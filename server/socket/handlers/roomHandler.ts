import { Server, Socket } from "socket.io";
import { gameStore } from "@/server/store/gameState";

export const roomHandler = (io: Server, socket: Socket) => {

    socket.on("join_room", ({ roomId, name }) => {
        socket.join(roomId);

        gameStore.addPlayer(roomId, {
            id: socket.id,
            name: name,
            score: 0,
            hasGuessed: false,
            isDrawer: false
        });

        const updatedRoom = gameStore.getRoom(roomId);
        io.to(roomId).emit("room_updated", updatedRoom);
        console.log(`User ${socket.id} joined: ${roomId}`);
    })

    socket.on("chat_message", ({ roomId, message }) => {
        const room = gameStore.getRoom(roomId);
        const player = room?.players.find(p => p.id === socket.id);
        const userName = player?.name;

        const isCorrectGuess = gameStore.checkGuess(roomId, socket.id, message);

        if (isCorrectGuess) {

            io.to(roomId).emit("system_message", {
                type: "CORRECT_GUESS",
                userId: socket.id,
                userName: userName,
            });

            io.to(roomId).emit("room_state_updated", gameStore.getRoom(roomId));
        } else {

            io.to(roomId).emit("receive_message", {
                userId: socket.id,
                userName: userName,
                message,
            })
        }
    })

    socket.on("start_game", (roomId: string) => {
        gameStore.startGame(roomId, io);
    });

    socket.on("disconnect", () => {
        const roomId = gameStore.removePlayerFromAllRooms(socket.id);

        if (roomId) {
            const updatedRoom = gameStore.getRoom(roomId);
            if (updatedRoom) {
                io.to(roomId).emit("room_updated", updatedRoom);
            }
        }
    })
}