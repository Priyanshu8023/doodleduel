"use client"

import { useEffect, useState } from "react"
import { socket } from "@/lib/socket"
export default function ChatSection({ roomId }: { roomId: string }) {
    const [message, setMessage] = useState("");
    const [chat, setChat] = useState<{ userName?: string, message?: string, type?: string, word?: string }[]>([]);

    useEffect(() => {
        const handleMsg = (msg: any) => setChat((prev) => [...prev, msg].slice(-100));
        const handleSys = (sys: any) => setChat((prev) => [...prev, sys].slice(-100));

        socket.on("receive_message", handleMsg);
        socket.on("system_message", handleSys);


        return () => {
            socket.off("receive_message", handleMsg);
            socket.off("system_message", handleSys);
        }
    }, [])

    const sendMessage = (e: React.FormEvent) => {
        e.preventDefault();
        const trimmedMessage = message.trim();
        if (!trimmedMessage) return;
        
        if (trimmedMessage.length > 50) {
            setChat((prev) => [...prev, { type: "WARNING", message: "Message is too long (max 50 characters)" }].slice(-100));
            return;
        }

        socket.emit("chat_message", {
            roomId,
            message: trimmedMessage,
        });
        setMessage("");
    }

    return (
        <div className="flex flex-col h-full border rounded-lg bg-gray-50 overflow-hidden shadow-sm">
            <div className="flex-1 p-4 overflow-y-auto space-y-2">
                {chat.map((c, i) => (
                    <div key={i} className={`p-2 rounded-md max-w-[80%] ${
                        c.type === "CORRECT_GUESS" ? "bg-green-100 text-green-800 self-center w-full text-center font-bold" : 
                        c.type === "ROUND_END" ? "bg-red-100 text-red-800 w-full text-center font-bold" : 
                        c.type === "WARNING" ? "bg-yellow-100 text-yellow-800 self-center w-full text-center font-semibold text-sm" : 
                        "bg-white border"
                    }`}>
                        {c.type === "CORRECT_GUESS" ? `${c.userName} guessed the word!` : 
                         c.type === "ROUND_END" ? `Round over! The word was: ${c.word}` : 
                         c.type === "WARNING" ? c.message : (
                            <p><span className="font-semibold text-xs text-gray-400">{c.userName}: </span>{c.message}</p>
                        )}
                    </div>
                ))}
            </div>
            <form onSubmit={sendMessage} className="p-3 bg-white border-t flex gap-2">
                <input
                    type="text"
                    placeholder="Type your guess..."
                    className="flex-1 px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                />
                <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium">Send</button>
            </form>
        </div>
    )
}