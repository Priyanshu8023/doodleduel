import express, { Request, Response } from "express";
import { createServer } from "http";
import next from "next";
import { Server } from "socket.io";
import { Socket } from "socket.io-client";

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

    const io = new Server<ClienttoServerEvents,ServertoClientEvents>(httpServer,{
        cors:{
            origin:"*",
        }
    })

    io.on("connection",(socket) =>{
        console.log(`User connected: ${socket.id}`);

        socket.on("join_room",(roomId)=>{
            socket.join(roomId);
            console.log(`User ${socket.id} joined: ${roomId}`);
        })

        socket.on("send_message",({roomId,message})=>{
            socket.to(roomId).emit("receive_message",message);
        })

        socket.on("disconnect",()=>{
            console.log(`User disconnected: ${socket.id}`);
        })
    })

    expressApp.get("/api/custom-health-check",(req:Request,res:Response)=>{
        res.send({status:"ok"});
    })

    expressApp.all("*",(req:Request,res:Response)=>{
        return handle(req,res);
    })

    httpServer.listen(port,()=>{
        console.log(`Ready on http://${hostname}:${port}`);
    })
});

