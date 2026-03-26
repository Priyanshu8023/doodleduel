import express, { Request, Response } from "express";
import { createServer } from "http";
import next from "next";
import { Server } from "socket.io";
import { roomHandler } from "./socket/handlers/roomHandler";
import { drawingHandler } from "./socket/handlers/drawing";


interface ServertoClientEvents {
    receive_message: (message: string) => void;
}

interface ClienttoServerEvents {
    join_room: (roomId: string) => void;
    send_message: (data: { roomId: string, message: string }) => void;
}

const dev = process.env.NODE_ENV !== "production"
const hostname = process.env.HOSTNAME || "localhost"
const port = 3000;

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler();

app.prepare().then(() => {
    const expressApp = express();
    const httpServer = createServer(expressApp);

    const io = new Server<ClienttoServerEvents, ServertoClientEvents>(httpServer, {
        cors: {
            origin: "*",
        }
    })

    io.on("connection", (socket) => {
        console.log(`User connected: ${socket.id}`);

        // Register custom handlers
        roomHandler(io, socket);
        drawingHandler(io, socket);

        // Disconnect logging
        socket.on("disconnect", () => {
            console.log(`User disconnected: ${socket.id}`);
        })
    })

    expressApp.get("/api/custom-health-check", (req: Request, res: Response) => {
        res.send({ status: "ok" });
    })


    expressApp.use((req: Request, res: Response) => {
        return handle(req, res);
    })

    httpServer.listen(port, () => {
        console.log(`Ready on http://${hostname}:${port}`);
    })
});

