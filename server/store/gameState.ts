export type Player = {
    id: string;
    name: string;
    score: number;
    hasGuessed: boolean;
    isDrawer: boolean;
}

export type GameStatus = "LOBBY" | "CHOOSING_WORD" | "PLAYING" | "ROUND_END" | "GAME_OVER";

export type RoomState = {
    roomId: string;
    players: Player[];
    status: GameStatus;
    drawerId: string | null;
    currentWord: string | null;
    timer: number;
    round: number;
    maxRounds: number;
    timerInterval?: NodeJS.Timeout | null;
    timeoutId?: NodeJS.Timeout | null;
}

export class GameStore {
    private rooms: Record<string, RoomState> = {};

    createRoom(roomId: string) {
        if (!this.rooms[roomId]) {
            this.rooms[roomId] = {
                roomId,
                players: [],
                status: "LOBBY",
                round: 1,
                maxRounds: 3,
                drawerId: null,
                currentWord: null,
                timer: 0,
                timerInterval: null,
                timeoutId: null
            }
        }
    }

    addPlayer(roomId: string, player: Player) {
        this.createRoom(roomId);
        this.rooms[roomId].players.push(player);
    }

    removePlayer(roomId: string, socketId: string) {
        const room = this.rooms[roomId];
        if(!room) return ;

        const wasDrawer = room.drawerId === socketId;

        room.players  =room.players.filter(p=> p.id !== socketId);

        if(wasDrawer){
            room.drawerId = this.getNextDrawer(room.players,null);
        }

        if(room.players.length === 0){
            if(room.timerInterval) clearInterval(room.timerInterval)
            if (room.timeoutId) clearTimeout(room.timeoutId);
            delete this.rooms[roomId];
        }
         
    }

    removePlayerFromAllRooms(socketId: string): string | null {
        for (const roomId of Object.keys(this.rooms)) {
            const room = this.rooms[roomId];
            if (room.players.find(p => p.id === socketId)) {
                this.removePlayer(roomId, socketId);
                return roomId; // Return the roomId they were removed from
            }
        }
        return null;
    }

    getRoom(roomId: string): RoomState | null {
        return this.rooms[roomId] || null;
    }

    checkGuess(roomId: string, socketId: string, guess: string): boolean {
        const room = this.rooms[roomId];
        if (!room || room.status !== "PLAYING" || !room.currentWord) return false;

        if (guess.toLowerCase() == room.currentWord.toLocaleLowerCase()) {
            const player = room.players.find(p => p.id === socketId);
            if (player && !player.hasGuessed && !player.isDrawer) {
                player.hasGuessed = true;
                player.score += 100;
                return true;
            }
        }
        return false;
    }


    startGame(roomId: string, io: any) {
        const room = this.rooms[roomId];
        if (!room || room.players.length < 2 || room.status !== "LOBBY") return;

        room.status = "CHOOSING_WORD";
        room.round = 1;
        room.drawerId = room.players[0].id;

        room.players.forEach(p => p.score = 0);

        this.startRound(roomId, io);
    }

    startRound(roomId: string, io: any) {
        const room = this.rooms[roomId];
        if (!room) return;

        room.players.forEach(p => {
            p.hasGuessed = false;
             
        });

        const WORDS = ["apple", "dog", "house", "car", "javascript", "react", "guitar", "sunflower"];
        room.currentWord = WORDS[Math.floor(Math.random() * WORDS.length)];

        room.status = "PLAYING";
        room.timer = 60;

        io.to(roomId).emit("room_updated", room);

        if (room.timerInterval) clearInterval(room.timerInterval);
        if (room.timeoutId) clearTimeout(room.timeoutId);

        room.timerInterval = setInterval(() => {
            room.timer -= 1;
            io.to(roomId).emit("timer_tick", room.timer);

            if (room.timer <= 0) {
                this.endRound(roomId, io);
            }
        }, 1000);
    }

    endRound(roomId: string, io: any) {
        const room = this.rooms[roomId];
        if (!room) return;

        if (room.timerInterval) clearInterval(room.timerInterval);

        room.status = "ROUND_END";
        io.to(roomId).emit("room_updated", room);
         
        io.to(roomId).emit("system_message", { type: "ROUND_END", word: room.currentWord });

        room.timeoutId = setTimeout(() => {
            const prevDrawerId = room.drawerId;

            // Move to next player
            room.drawerId= this.getNextDrawer(room.players,room.drawerId);

             if(room.drawerId === room.players[0].id){
                room.round+=1;
             }

            // Check if game is completely over
            if (room.round > room.maxRounds) {
                room.status = "GAME_OVER";
                io.to(roomId).emit("room_updated", room);
            } else {
                this.startRound(roomId, io);
            }
        }, 5000);
    }

    getNextDrawer(players:Player[],currentDrawerId: string | null){
        if(players.length == 0) return null;

        if(!currentDrawerId) return players[0].id;

        const currentIndex = players.findIndex(p=>p.id===currentDrawerId);

        if(currentIndex === -1 )  return players[0].id;

        const nextIndex = (currentIndex +1)%players.length;

        return players[nextIndex].id;
    }
}

export const gameStore = new GameStore();

