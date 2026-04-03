import { redis } from "@/lib/redisClient";

export type Player = {
    id: string;
    name: string;
    score: number;
    hasGuessed: boolean;
};

export type GameStatus =
    | "LOBBY"
    | "CHOOSING_WORD"
    | "PLAYING"
    | "ROUND_END"
    | "GAME_OVER";

export type RoomState = {
    roomId: string;
    players: Player[];
    status: GameStatus;
    drawerId: string | null;
    currentWord: string | null;
    timer: number;
    round: number;
    maxRounds: number;
};

export class GameStore {
    private timers: Record<
        string,
        { interval?: NodeJS.Timeout; timeout?: NodeJS.Timeout }
    > = {};

    async getRoom(roomId: string): Promise<RoomState | null> {
        const room = await redis.hgetall(`room:${roomId}`);
        if (!room || Object.keys(room).length === 0) return null;

        const playerIds = await redis.lrange(`room:${roomId}:players`, 0, -1);

        const players = await Promise.all(
            playerIds.map(async (id) => {
                const p = await redis.hgetall(`player:${id}`);
                return {
                    id,
                    name: p.name,
                    score: Number(p.score),
                    hasGuessed: p.hasGuessed === "true"
                };
            })
        );

        return {
            roomId,
            status: room.status as GameStatus,
            drawerId: room.drawerId || null,
            currentWord: room.currentWord || null,
            round: Number(room.round),
            maxRounds: Number(room.maxRounds),
            timer: Number(room.timer),
            players
        };

    }

    async saveRoomState(roomId: string, partialState: Record<string, string>) {
        await redis.hset(`room:${roomId}`, partialState);
    }

    async deleteRoom(roomId: string) {
        await redis.del(`room:${roomId}`);
    }

    async createRoom(roomId: string) {
        const exists = await redis.exists(`room:${roomId}`);
        if (exists === 1) return;

        await redis.hset(`room:${roomId}`, {
            status: "LOBBY",
            round: "1",
            maxRounds: "6", // FIXED: maxRound -> maxRounds
            drawerId: "",
            currentWord: "",
            timer: "0",
        });
    }

    async addPlayer(roomId: string, player: Player, socketId: string) {
        await this.createRoom(roomId);

        // Check if player is already in the room to handle reconnections
        const isExistingMember = await redis.sismember(`room:${roomId}:players:set`, player.id);

        if (!isExistingMember) {
            await redis.hset(`player:${player.id}`, {
                name: player.name,
                score: player.score.toString(),
                hasGuessed: player.hasGuessed.toString(),
                roomId
            });

            await redis.rpush(`room:${roomId}:players`, player.id);
            await redis.sadd(`room:${roomId}:players:set`, player.id);
        }

        await redis.set(`socket:${socketId}`, player.id);
        await redis.set(`player:${player.id}:socket`, socketId);
    }

    async getPlayerIdBySocket(socketId: string) {
        return await redis.get(`socket:${socketId}`);
    }

    async getPlayer(playerId: string) {
        const p = await redis.hgetall(`player:${playerId}`);
        if (!p || Object.keys(p).length === 0) return null;
        return {
            id: playerId,
            name: p.name,
            score: Number(p.score),
            hasGuessed: p.hasGuessed === "true",
            roomId: p.roomId
        };
    }

    async markDisconnected(socketId: string) {
        const playerId = await redis.get(`socket:${socketId}`);
        if (!playerId) return null;

        const roomId = await redis.hget(`player:${playerId}`, "roomId");
        if (!roomId) return null;

        await redis.del(`socket:${socketId}`);
        await redis.del(`player:${playerId}:socket`);

        return { roomId, playerId };
    }

    async removePlayerFromRoom(roomId: string, playerId: string) {
        await redis.lrem(`room:${roomId}:players`, 0, playerId);
        await redis.srem(`room:${roomId}:players:set`, playerId);
        await redis.del(`player:${playerId}`);
        await redis.zrem(`room:${roomId}:leaderboard`, playerId); // Extra cleanup

        // Cleanup empty room
        const remainingPlayers = await redis.scard(`room:${roomId}:players:set`);
        if (remainingPlayers === 0) {
            await this.deleteRoom(roomId);
            await redis.del(`room:${roomId}:leaderboard`);
            this.clearTimers(roomId);
        }
    }

    async isPlayerReconnected(playerId: string): Promise<boolean> {
        const exists = await redis.exists(`player:${playerId}:socket`);
        return exists === 1;
    }

    async checkGuess(roomId: string, playerId: string, guess: string, io: any): Promise<boolean> {
        const [status, word, drawerId, timerStr] = await redis.hmget(
            `room:${roomId}`,
            "status",
            "currentWord",
            "drawerId",
            "timer"
        );

        if (!status || status !== "PLAYING" || !word) return false;

        const player = await redis.hgetall(`player:${playerId}`);
        if (!player || Object.keys(player).length === 0) return false;

        if (player.hasGuessed === "true" || drawerId === playerId) return false;

        if (guess.toLowerCase() !== word.toLowerCase()) return false;

        // ---------------- SCORING ----------------

        const timer = Number(timerStr) || 0;
        const timeRatio = timer / 60;
        const points = Math.max(10, Math.floor(100 * timeRatio));

        const tx = redis.multi();

        tx.hset(`player:${playerId}`, "hasGuessed", "true");
        tx.hincrby(`player:${playerId}`, "score", points); // Keep HASH in sync
        tx.zincrby(`room:${roomId}:leaderboard`, points, playerId);

        if (drawerId) {
            const drawerPoints = Math.floor(points / 2);
            tx.hincrby(`player:${drawerId}`, "score", drawerPoints); // Keep HASH in sync
            tx.zincrby(
                `room:${roomId}:leaderboard`,
                drawerPoints,
                drawerId
            );
        }

        await tx.exec();

        // ---------------- CHECK ALL GUESSED ----------------

        const playerIds = await redis.lrange(`room:${roomId}:players`, 0, -1);

        const pipeline = redis.multi();
        playerIds.forEach(id => {
            pipeline.hget(`player:${id}`, "hasGuessed"); // FIXED: players: -> player:
        });

        const results = await pipeline.exec();
        if (!results) return true;

        const allGuessed = playerIds.every((id, index) => {
            if (id === drawerId) return true;
            // ioredis returns [error, result] for each command in multi/exec
            return results[index][1] === "true";
        });

        if (allGuessed) {
            this.clearTimers(roomId);
            this.endRound(roomId, io);
        }

        return true;
    }

    async startGame(roomId: string, io: any) {
        const room = await this.getRoom(roomId);
        if (!room || room.players.length < 2 || room.status !== "LOBBY") return;

        const pipeline = redis.multi();
        pipeline.del(`room:${roomId}:leaderboard`);
        room.players.forEach(p => {
            pipeline.hset(`player:${p.id}`, "score", "0");
        });

        pipeline.hset(`room:${roomId}`, {
            status: "CHOOSING_WORD",
            round: "1",
            drawerId: room.players[0].id,
            currentWord: "",
            timer: "0"
        });

        await pipeline.exec();
        this.startRound(roomId, io);
    }

    async startRound(roomId: string, io: any) {
        const playerIds = await redis.lrange(`room:${roomId}:players`, 0, -1);
        if (playerIds.length < 2) return;

        const WORDS = ["apple", "dog", "house", "car", "javascript", "react"];
        const currentWord = WORDS[Math.floor(Math.random() * WORDS.length)];

        const pipeline = redis.multi();
        playerIds.forEach(id => {
            pipeline.hset(`player:${id}`, "hasGuessed", "false");
        });

        pipeline.hset(`room:${roomId}`, {
            status: "PLAYING",
            currentWord,
            timer: "60"
        });

        await pipeline.exec();

        const updatedRoom = await this.getRoom(roomId);
        io.to(roomId).emit("room_updated", updatedRoom);

        this.clearTimers(roomId);

        this.timers[roomId] = {
            interval: setInterval(async () => {
                const timerStr = await redis.hget(`room:${roomId}`, "timer");
                if (timerStr === null) {
                    this.clearTimers(roomId);
                    return;
                }

                let timer = Number(timerStr);
                timer -= 1;

                if (timer <= 0) {
                    this.clearTimers(roomId);
                    this.endRound(roomId, io);
                    return;
                }

                await redis.hset(`room:${roomId}`, "timer", timer.toString());
                io.to(roomId).emit("timer_tick", timer);
            }, 1000),
        };
    }

    async endRound(roomId: string, io: any) {
        this.clearTimers(roomId);

        await redis.hset(`room:${roomId}`, "status", "ROUND_END");

        const room = await this.getRoom(roomId);
        if (!room) return;

        io.to(roomId).emit("room_updated", room);
        io.to(roomId).emit("system_message", {
            type: "ROUND_END",
            word: room.currentWord,
        });

        // 🔥 Timeout runs in Node.js
        this.timers[roomId] = {
            timeout: setTimeout(async () => {
                const updatedRoom = await this.getRoom(roomId);
                if (!updatedRoom) return;

                if (updatedRoom.players.length < 2) {
                    await redis.hset(`room:${roomId}`, {
                        status: "LOBBY",
                        drawerId: ""
                    });
                    const finalRoom = await this.getRoom(roomId);
                    io.to(roomId).emit("room_updated", finalRoom);
                    return;
                }

                const nextDrawerId = await this.getNextDrawer(roomId, updatedRoom.drawerId);
                let newRound = updatedRoom.round;

                // If we wrapped around to the first player, increment round
                if (nextDrawerId === updatedRoom.players[0].id) {
                    newRound += 1;
                }

                if (newRound > updatedRoom.maxRounds) {
                    await redis.hset(`room:${roomId}`, "status", "GAME_OVER");
                    const finalRoom = await this.getRoom(roomId);
                    io.to(roomId).emit("room_updated", finalRoom);
                } else {
                    await redis.hset(`room:${roomId}`, {
                        drawerId: nextDrawerId || "",
                        round: newRound.toString()
                    });
                    this.startRound(roomId, io);
                }
            }, 5000),
        };
    }

    async getNextDrawer(roomId: string, currentDrawerId: string | null) {
        const players = await redis.lrange(`room:${roomId}:players`, 0, -1);
        if (players.length === 0) return null;

        let startIndex = 0;

        if (currentDrawerId) {
            const idx = players.indexOf(currentDrawerId);
            startIndex = idx === -1 ? 0 : (idx + 1) % players.length;
        }

        const pipeline = redis.multi();
        players.forEach(id => {
            pipeline.get(`player:${id}:socket`); // FIXED: players: -> player:
        });

        const results = await pipeline.exec();
        if (!results) return null;

        // ioredis returns array of [err, result]
        const socketIds = results.map(([_, res]) => res);

        for (let i = 0; i < players.length; i++) {
            const index = (startIndex + i) % players.length;

            if (socketIds[index]) {
                return players[index];
            }
        }

        return null;
    }

    clearTimers(roomId: string) {
        const t = this.timers[roomId];

        if (t?.interval) clearInterval(t.interval);
        if (t?.timeout) clearTimeout(t.timeout);

        delete this.timers[roomId];
    }
}

export const gameStore = new GameStore();