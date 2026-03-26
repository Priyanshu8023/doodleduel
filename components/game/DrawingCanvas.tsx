"use client"

import { useRef, useEffect, useState, useCallback } from "react";
import { socket } from "@/lib/socket"

export default function DrawingCanvas({ roomId, isDrawer }: { roomId: string; isDrawer: boolean }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
    const lastEmitTime = useRef<number>(0);
    const lastEmittedPoint = useRef<{ x: number, y: number } | null>(null);
    const lastLocalPoint = useRef<{ x: number, y: number } | null>(null);

    const [drawing, setDrawing] = useState(false);
    const [color, setColor] = useState("#000000")
    const [size, setSize] = useState(3);

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
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
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
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
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

        const handleRemoteDraw = (data: any) => {
            if (!isDrawer) drawLine(data.prevX, data.prevY, data.x, data.y, data.color, data.size);
        }

        socket.on("drawing", handleRemoteDraw);
        return () => { socket.off("drawing", handleRemoteDraw) }
    }, [isDrawer, drawLine]);

    return (
        <canvas
            ref={canvasRef}
            className="border bg-white rounded-lg cursor-crosshair touch-none"
            onMouseDown={startDrawing}
            onMouseMove={draw}
            onMouseUp={stopDrawing}
            onMouseLeave={stopDrawing}
        />
    );
}