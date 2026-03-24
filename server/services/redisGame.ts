import { redis } from "@/server/redis/client"

const getRoomKey = ( roomId:string) => `room:${roomId}`

export const createRoom = async ( roomId:string) =>{
    await redis.hset(getRoomKey(roomId),{
        status:"waiting",
        round: 0,
        maxPlayers:8,
    })
}

export const addPlayer = async(roomId:string,userId : string) =>{
    await redis.srem(`${getRoomKey(roomId)}:players`,userId)
    await redis.hdel(`${getRoomKey(roomId)}:scores`,userId)
}

export const getPlayers = async(roomId:string) =>{
    return await redis.smembers(`${getRoomKey(roomId)}:players`);
}

export const getDrawer = async(roomId : string) =>{
    return await redis.get(`${getRoomKey(roomId)}:drawer`)
}

export const setDrawer= async ( roomId:string,userId:string)=>{
    await redis.set(`${getRoomKey(roomId)}:drawer`, userId);
}

export const getWord = async (roomId:string) =>{
    return await redis.get(`${getRoomKey(roomId)}:word`)
}

export const setTimer = async(roomId:string,time:number)=>{
    return await redis.set(`${getRoomKey(roomId)}:time`,time)
}

export const getTimer = async(roomId:string)=>{
    return await redis.get(`${getRoomKey(roomId)}:timer`)
}

export const addScore = async (roomId:string,userId:string,points:number) =>{
    await redis.hincrby(`${getRoomKey(roomId)}:scores`,userId,points);
}

export const getScores = async (roomId: string) => {
  return await redis.hgetall(`${getRoomKey(roomId)}:scores`);
};

export const updateGameState = async (roomId: string, data: any) => {
  await redis.hset(getRoomKey(roomId), data);
};

export const getGameState = async (roomId: string) => {
  return await redis.hgetall(getRoomKey(roomId));
};

export const deleteRoom = async( roomId:string) =>{
    const keys= [
        getRoomKey(roomId),
        `${getRoomKey(roomId)}:players`,
        `${getRoomKey(roomId)}:scores`,
        `${getRoomKey(roomId)}:drawer`,
        `${getRoomKey(roomId)}:word`,
        `${getRoomKey(roomId)}:timer`,
    ]

    await redis.del(...keys)
}