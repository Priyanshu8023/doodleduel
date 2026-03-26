import { Server, Socket } from "socket.io";
import { gameStore, Player } from "@/server/store/gameState";

export const drawingHandler = (io: Server, socket: Socket) => {
    socket.on("draw", async (data: { roomId: string; [key: string]: unknown }) => {
        const { roomId } = data;
        const room = await gameStore.getRoom(roomId);
        
        // Ensure the game exists and the sender is the current drawer
        const player = room?.players.find(p => p.id === socket.id);
        if (room && player && player.isDrawer) {
            socket.to(roomId).emit("drawing", data);
        }
    });
};