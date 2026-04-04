"use client"

import { useRef, useEffect, useState, useCallback } from "react";
import { socket } from "@/lib/socket"

const COLORS = [
    "#FFFFFF", "#C1C1C1", "#EF130B", "#FF7100", "#FFE400", "#00CC00", "#00B2FF", "#231FD3", "#A300BA", "#D37CAA", "#A0522D",
    "#000000", "#4C4C4C", "#740B07", "#C23800", "#E8A200", "#005510", "#00569E", "#0E0865", "#550069", "#A75574", "#63300D",
];

const SIZES = [
    { label: "S", value: 4 },
    { label: "M", value: 10 },
    { label: "L", value: 20 },
    { label: "XL", value: 32 },
];

const EraserIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
        <path d="M22 21H7" />
        <path d="m5 11 9 9" />
    </svg>
)

export default function DrawingCanvas({ roomId, isDrawer }: { roomId: string; isDrawer: boolean }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
    const lastEmitTime = useRef<number>(0);
    const lastEmittedPoint = useRef<{ x: number, y: number } | null>(null);
    const lastLocalPoint = useRef<{ x: number, y: number } | null>(null);

    const [drawing, setDrawing] = useState(false);
    const [color, setColor] = useState("#000000")
    const [size, setSize] = useState(4);

    const drawLine = useCallback((x0: number, y0: number, x1: number, y1: number, c: string, s: number) => {
        const ctx = ctxRef.current;
        if (!ctx) return;

        ctx.beginPath();
        ctx.strokeStyle = c;
        ctx.lineWidth = s;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.closePath();
    }, []);

    const startDrawing = (e: React.MouseEvent) => {
        if (!isDrawer || !canvasRef.current) return;
        setDrawing(true);
        const rect = canvasRef.current.getBoundingClientRect();
        const scaleX = canvasRef.current.width / rect.width;
        const scaleY = canvasRef.current.height / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        lastLocalPoint.current = { x, y };
        lastEmittedPoint.current = { x, y };
    };

    const stopDrawing = () => {
        setDrawing(false);
        lastLocalPoint.current = null;
        lastEmittedPoint.current = null;
    };

    const draw = (e: React.MouseEvent) => {
        if (!drawing || !isDrawer || !canvasRef.current || !lastLocalPoint.current || !lastEmittedPoint.current) return;

        const rect = canvasRef.current.getBoundingClientRect();
        const scaleX = canvasRef.current.width / rect.width;
        const scaleY = canvasRef.current.height / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;

        const prevX = lastLocalPoint.current.x;
        const prevY = lastLocalPoint.current.y;

        drawLine(prevX, prevY, x, y, color, size);
        lastLocalPoint.current = { x, y };

        const now = Date.now();
        if (now - lastEmitTime.current > 16) {
            socket.emit("draw", {
                roomId,
                x,
                y,
                prevX: lastEmittedPoint.current.x,
                prevY: lastEmittedPoint.current.y,
                color,
                size
            });
            lastEmitTime.current = now;
            lastEmittedPoint.current = { x, y };
        }
    };

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        ctxRef.current = canvas.getContext("2d")

        canvas.width = 800;
        canvas.height = 500;

        const ctx = ctxRef.current;
        if (ctx) {
            ctx.fillStyle = "#FFFFFF";
            ctx.fillRect(0, 0, 800, 500);
        }

        const handleRemoteDraw = (data: any) => {
            if (!isDrawer) drawLine(data.prevX, data.prevY, data.x, data.y, data.color, data.size);
        }

        const handlePlayerJoined = ({ newPlayerSocketId }: { newPlayerSocketId: string }) => {
            if (isDrawer && canvasRef.current) {
                const canvasData = canvasRef.current.toDataURL("image/png");

                socket.emit("sync_canvas", {
                    targetSocketId: newPlayerSocketId,
                    canvasData: canvasData
                })
            }
        }

        const handleReceiveCanvas = (canvasData: string) => {
            const img = new Image();
            img.onload = () => {
                if (ctxRef.current && !isDrawer) {
                    ctxRef.current.drawImage(img, 0, 0);
                }
            };
            img.src = canvasData;
        }

        socket.on("drawing", handleRemoteDraw);
        socket.on("player_joined", handlePlayerJoined);
        socket.on("receive_canvas_sync", handleReceiveCanvas);

        return () => {
            socket.on("drawing", handleRemoteDraw);
            socket.on("player_joined", handlePlayerJoined);
            socket.on("receive_canvas_sync", handleReceiveCanvas);
        }
    }, [isDrawer, drawLine]);

    return (
        <div className="w-full h-full flex flex-col items-center bg-[#f3f4f6] p-2 overflow-hidden justify-center relative min-h-0">
            {/* Canvas Area */}
            <div className="flex-1 w-full flex items-center justify-center min-h-0">
                <canvas
                    ref={canvasRef}
                    className="bg-white cursor-crosshair touch-none shadow-lg rounded-xl border-2 border-gray-300"
                    style={{ aspectRatio: "8/5", maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                    onMouseDown={startDrawing}
                    onMouseMove={draw}
                    onMouseUp={stopDrawing}
                    onMouseLeave={stopDrawing}
                />
            </div>

            {/* Toolbar */}
            {isDrawer && (
                <div
                    className="mt-3 flex flex-wrap sm:flex-nowrap items-center justify-between bg-white rounded-xl shadow-md border-b-4 border-gray-200 p-3 gap-3 flex-shrink-0"
                    style={{ width: "100%", maxWidth: 800 }}
                >

                    {/* Tools Group (Sizes & Eraser) */}
                    <div className="flex items-center gap-2 bg-gray-50 p-1.5 rounded-lg border border-gray-200 shadow-inner">

                        {/* Bruh Sizes */}
                        <div className="flex gap-1">
                            {SIZES.map(s => {
                                const isSelected = size === s.value;
                                return (
                                    <button
                                        key={s.label}
                                        onClick={() => setSize(s.value)}
                                        className={`w-10 h-10 flex items-center justify-center rounded-md transition-all ${isSelected
                                                ? 'bg-blue-500 text-white shadow-md scale-105'
                                                : 'bg-white hover:bg-gray-100 text-gray-700 border border-gray-200'
                                            }`}
                                        title={`Brush Size: ${s.value}px`}
                                    >
                                        <div
                                            className={isSelected ? "bg-white rounded-full" : "bg-gray-700 rounded-full"}
                                            style={{ width: Math.min(s.value, 20), height: Math.min(s.value, 20) }}
                                        />
                                    </button>
                                );
                            })}
                        </div>

                        <div className="w-px h-8 bg-gray-300 mx-1" />

                        {/* Eraser */}
                        <button
                            onClick={() => setColor("#FFFFFF")}
                            className={`w-10 h-10 flex items-center justify-center rounded-md transition-all ${color === "#FFFFFF"
                                    ? 'bg-blue-500 text-white shadow-md scale-105'
                                    : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-100'
                                }`}
                            title="Eraser"
                        >
                            <EraserIcon />
                        </button>
                    </div>

                    {/* Color Palette (Tight Squares) */}
                    <div className="bg-gray-200 p-1.5 rounded-lg border border-gray-300 shadow-inner ml-auto sm:ml-0 overflow-hidden">
                        <div className="grid grid-cols-11 gap-0.5 bg-gray-300 rounded-sm p-0.5">
                            {COLORS.map((c, index) => {
                                const isSelected = color === c;
                                return (
                                    <button
                                        key={index}
                                        onClick={() => setColor(c)}
                                        className={`w-5 h-5 sm:w-6 sm:h-6 transition-transform relative ${isSelected ? 'ring-2 ring-white z-10 scale-110 rounded-sm' : 'hover:scale-105 rounded-sm'
                                            }`}
                                        style={{ backgroundColor: c }}
                                        title={c}
                                    />
                                );
                            })}
                        </div>
                    </div>

                </div>
            )}
        </div>
    );
}