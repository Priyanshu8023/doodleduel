import { Server, Socket } from "socket.io";
import { gameStore } from "@/server/store/gameState";

export const drawingHandler = (io: Server, socket: Socket) => {
    socket.on("draw", async (data: { roomId: string;[key: string]: unknown }) => {
        const { roomId } = data;
        const room = await gameStore.getRoom(roomId);
        const playerId = await gameStore.getPlayerIdBySocket(socket.id);

        // Ensure the game exists and the sender is the current drawer
        if (room && playerId && room.drawerId === playerId) {
            socket.to(roomId).emit("drawing", data);
        }
    });
};