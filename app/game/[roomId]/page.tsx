"use client"

import { use, useEffect, useState } from "react";
import { socket } from "@/lib/socket";
import DrawingCanvas from "@/components/game/DrawingCanvas";
import ChatSection from "@/components/game/ChatSection";
import { Bounce, ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { playRoundStartSound, playTickSound, playRoundEndSound, playCorrectGuessSound } from "@/lib/audio";

type RoomState = {
    roomId: string;
    players: { id: string, name: string, score: number, hasGuessed: boolean }[];
    status: "LOBBY" | "CHOOSING_WORD" | "PLAYING" | "ROUND_END" | "GAME_OVER";
    drawerId: string | null;
    currentWord: string | null;
    roundEndTime: number;
    round: number;
    maxRounds: number;
};

export default function GameRoom({ params }: { params: Promise<{ roomId: string }> }) {
    const { roomId } = use(params);
    const [name, setName] = useState("");
    const [joined, setJoined] = useState(false);
    const [playerId, setPlayerId] = useState("");

    const [roomState, setRoomState] = useState<RoomState | null>(null);
    const [timer, setTimer] = useState(0);

    useEffect(() => {
        let id = localStorage.getItem("playerId");
        if (!id) {
            id = crypto.randomUUID();
            localStorage.setItem("playerId", id);
        }
        setPlayerId(id);

        const handleRoomUpdate = (state: RoomState) => {
            setRoomState(state);
        };

        const handleSystemMessage = (sys: any) => {
            if (sys.type === "CORRECT_GUESS") {
                playCorrectGuessSound();
            }
        };

        socket.on("room_updated", handleRoomUpdate);
        socket.on("room_state_updated", handleRoomUpdate);
        socket.on("system_message", handleSystemMessage);

        return () => {
            socket.off("room_updated", handleRoomUpdate);
            socket.off("room_state_updated", handleRoomUpdate);
            socket.off("system_message", handleSystemMessage);
        }
    }, []);

    useEffect(() => {
        if (roomState?.status === "PLAYING" && roomState.roundEndTime) {
            playRoundStartSound();
            const updateTimer = () => {
                const timeLeft = Math.max(0, Math.ceil((roomState.roundEndTime - Date.now()) / 1000));
                setTimer(timeLeft);

                if (timeLeft <= 5 && timeLeft > 0) {
                    playTickSound();
                }
            };

            updateTimer();
            const interval = setInterval(updateTimer, 1000);
            return () => clearInterval(interval);
        } else if (roomState?.status === "ROUND_END") {
            playRoundEndSound();
            setTimer(0);
        } else {
            setTimer(0);
        }
    }, [roomState?.status, roomState?.roundEndTime]);

    const joinRoom = (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim() || !playerId) return;

        if (name.length > 15) {
            toast.error("Name must be under 15 characters", {
                position: "top-right",
                autoClose: 5000,
                hideProgressBar: false,
                closeOnClick: false,
                pauseOnHover: true,
                draggable: true,
                progress: undefined,
                theme: "light",
                transition: Bounce,
            });
            return;
        }

        socket.emit("join_room", { roomId, name, playerId });
        setJoined(true);
    }

    const startGame = () => {
        socket.emit("start_game", roomId);
    }

    if (!joined) {
        return (
            <div className="flex h-screen items-center justify-center bg-gray-100">
                <form onSubmit={joinRoom} className="p-8 bg-white rounded-xl shadow-lg flex flex-col gap-4 text-center max-w-sm w-full">
                    <h1 className="text-2xl font-black tracking-tight text-gray-900">Join Room: {roomId}</h1>
                    <input
                        className="border-2 border-gray-200 px-4 py-3 rounded-lg text-lg focus:outline-none focus:border-blue-500 transition-colors"
                        type="text"
                        placeholder="Enter your name..."
                        value={name}
                        onChange={e => setName(e.target.value)}
                        autoFocus
                    />
                    <button type="submit" className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg transition-colors">
                        Play!
                    </button>
                </form>
                <ToastContainer
                    position="top-right"
                    autoClose={5000}
                    hideProgressBar={false}
                    newestOnTop={false}
                    closeOnClick={false}
                    rtl={false}
                    pauseOnFocusLoss
                    draggable
                    pauseOnHover
                    theme="light"
                    transition={Bounce}
                />
            </div>
        )
    }

    if (!roomState) return <div className="flex h-screen items-center justify-center text-gray-500 font-bold">Connecting...</div>;

    const myPlayer = roomState.players.find(p => p.id === playerId);
    const isDrawer = roomState.drawerId === playerId;

    return (
        <div className="flex flex-col h-screen bg-gray-100 font-sans">
            <div className="h-16 bg-white border-b flex items-center justify-between px-6 shadow-sm z-10">
                <div className="flex items-center gap-4">
                    <h1 className="font-black text-2xl tracking-tighter text-blue-600">skribble.io</h1>
                    <span className="text-xs font-semibold px-2 py-1 bg-gray-100 rounded-md text-gray-500">Room: {roomId}</span>
                </div>

                {roomState.status === "PLAYING" && (
                    <div className="flex flex-col items-center">
                        <span className="text-sm font-bold text-gray-400 uppercase tracking-widest">Round {roomState.round} of {roomState.maxRounds}</span>
                        {isDrawer ? (
                            <span className="text-xl font-black tracking-widest text-gray-900">Draw this: <span className="text-blue-600 underline decoration-blue-200">{roomState.currentWord}</span></span>
                        ) : (
                            <span className="text-xl tracking-widest text-gray-900 flex gap-2">
                                {roomState.currentWord ? roomState.currentWord.replace(/[a-zA-Z]/g, "_ ") : "Waiting for word..."}
                            </span>
                        )}
                    </div>
                )}

                <div className="text-2xl font-black tabular-nums min-w-[3ch] text-right text-gray-800">
                    {roomState.status === "PLAYING" ? timer : "∞"}
                </div>
            </div>

            {/* Main Game Area */}
            <div className="flex-1 flex overflow-hidden p-4 gap-4 max-w-7xl mx-auto w-full">
                {/* Left Side: Players */}
                <div className="w-64 flex flex-col gap-2">
                    <div className="bg-white rounded-lg shadow-sm border p-4 flex-1 overflow-y-auto">
                        <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-4">Players</h2>
                        <ul className="space-y-3">
                            {roomState.players.map(p => (
                                <li key={p.id} className={`flex items-center justify-between p-2 rounded-md ${p.id === playerId ? "bg-blue-50 border-blue-100 border" : ""} ${p.hasGuessed ? "bg-green-50" : ""}`}>
                                    <div className="flex flex-col">
                                        <span className={`font-semibold ${p.id === playerId ? 'text-blue-700' : 'text-gray-800'}`}>
                                            {p.name} {roomState.drawerId === p.id && '✏️'} {p.hasGuessed && '✔️'}
                                        </span>
                                        <span className="text-xs text-gray-500">Points: {p.score}</span>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </div>

                    {/* Game Controls for Host */}
                    {roomState.status === "LOBBY" && roomState.players.length >= 2 && roomState.players[0].id === playerId && (
                        <button
                            onClick={startGame}
                            className="w-full py-4 bg-green-500 hover:bg-green-600 text-white font-black rounded-lg shadow-md transition-all active:scale-95"
                        >
                            START GAME
                        </button>
                    )}
                    {roomState.status === "LOBBY" && roomState.players.length < 2 && (
                        <div className="w-full py-4 bg-gray-200 text-gray-500 text-center font-bold rounded-lg border-2 border-dashed border-gray-300">
                            Waiting for players...
                        </div>
                    )}
                </div>

                {/* Center: Canvas or Overlay */}
                <div className="flex-1 flex flex-col relative rounded-lg overflow-hidden shadow-md bg-white border">
                    <DrawingCanvas roomId={roomId} isDrawer={isDrawer} />

                    {/* Overlays for different game states */}
                    {roomState.status === "LOBBY" && (
                        <div className="absolute inset-0 bg-white/80 backdrop-blur-sm flex items-center justify-center">
                            <h2 className="text-4xl font-black text-gray-800">Waiting in Lobby...</h2>
                        </div>
                    )}

                    {roomState.status === "ROUND_END" && (
                        <div className="absolute inset-0 bg-black/60 backdrop-blur-md flex items-center justify-center text-white flex-col gap-4">
                            <h2 className="text-5xl font-black text-yellow-400">Round Over!</h2>
                            <p className="text-2xl font-bold">The word was: <span className="underline">{roomState.currentWord}</span></p>
                            <p className="animate-pulse opacity-50 font-bold mt-8">Next round starting soon...</p>
                        </div>
                    )}
                </div>

                {/* Right Side: Chat */}
                <div className="w-80">
                    <ChatSection roomId={roomId} />
                </div>
            </div>
        </div>
    )
}
