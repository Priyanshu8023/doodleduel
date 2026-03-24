"use client"

import {useEffect ,useState} from "react"
import { socket } from "@/lib/socket"


export default function ChatSection(){
    const [message,setMessage]=useState("")
    const [chat,setChat] = useState<string[]>([])

    useEffect(()=>{
        socket.on("receive_message",(msg)=>{
            setChat((prev)=>[...prev,msg]);
        })

        return ()=>{
            socket.off("receive_message")
        }
    },[])

    const sendMessage = () =>{
        socket.emit("send_message",{
            roomId:"room1",
            message,
        })
    }

    const joinRoom = ( )=>{
        socket.emit("join_room","room1");
    }
}