# WORKFLOW.md — End-to-End Request & Game Flow

## Game State Machine

The game follows a finite state machine (FSM) with five states:

```
LOBBY → CHOOSING_WORD → PLAYING → ROUND_END → (next PLAYING or GAME_OVER)
                                               ↑___________________________|
```

> **Note:** `CHOOSING_WORD` is persisted as a transient status during `startGame` initialization. The system immediately advances to `PLAYING` via `startRound` — there is no word-picking UI; the word is selected server-side automatically. The state is kept for future UI extensibility.

---

## Full Session Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    participant Browser as Browser (Client)
    participant SocketIO as Socket.IO Server
    participant GS as GameStore
    participant Redis as Redis
    participant PG as PostgreSQL
    participant Worker as Worker Loop (setInterval)

    Browser->>SocketIO: connect (WS handshake)
    SocketIO-->>Browser: socket.id assigned

    Browser->>SocketIO: emit("join_room", {roomId, name, playerId})
    SocketIO->>GS: addPlayer(roomId, player, socketId)
    GS->>Redis: HSET room:{roomId} (create if not exists)
    GS->>Redis: RPUSH room:{roomId}:players {playerId}
    GS->>Redis: SADD room:{roomId}:players:set {playerId}
    GS->>Redis: SET socket:{socketId} → playerId
    GS->>Redis: SET player:{playerId}:socket → socketId
    GS->>Redis: HGETALL room:{roomId} + LRANGE players
    GS-->>SocketIO: RoomState object
    SocketIO-->>Browser: emit("room_updated", roomState)  [to all in room]
    SocketIO-->>Browser: emit("player_joined", {newPlayerSocketId}) [to others]

    Note over Browser: Other player's DrawingCanvas receives "player_joined"
    Browser->>SocketIO: emit("sync_canvas", {targetSocketId, canvasData})
    SocketIO-->>Browser: emit("receive_canvas_sync", canvasData)  [to target only]

    Browser->>SocketIO: emit("start_game", roomId)  [host only]
    SocketIO->>GS: startGame(roomId, io)
    GS->>Redis: DEL room:{roomId}:leaderboard
    GS->>Redis: HSET each player score=0
    GS->>Redis: HSET room:{roomId} status=CHOOSING_WORD, drawerId=players[0], round=1
    GS->>GS: startRound(roomId, io)

    GS->>Redis: SPOP room:{roomId}:words  [check word cache]
    alt Cache miss (first round or exhausted)
        GS->>PG: SELECT word FROM "Word" ORDER BY RANDOM() LIMIT 150
        GS->>Redis: SADD room:{roomId}:words [...150 words]
        GS->>Redis: SPOP room:{roomId}:words → currentWord
    end

    GS->>Redis: HSET each player hasGuessed=false
    GS->>Redis: HSET room:{roomId} status=PLAYING, currentWord=X, roundEndTime=now+60s
    GS->>Redis: ZADD active_rounds {roundEndTime} {roomId}
    GS->>Redis: HGETALL room:{roomId} → full RoomState
    GS-->>SocketIO: io.to(roomId).emit("room_updated", fullRoomState)
    SocketIO-->>Browser: receive room_updated  (drawer sees word, guessers see blanks)

    loop Every mouse move batch (≤50ms or ≥20 points)
        Browser->>SocketIO: emit("draw_batch", {roomId, points[]})
        SocketIO->>GS: verify room status=PLAYING AND sender=drawerId
        SocketIO-->>Browser: emit("draw_batch", data)  [to all others in room]
    end

    Browser->>SocketIO: emit("chat_message", {roomId, message})
    SocketIO->>GS: checkGuess(roomId, playerId, message, io)
    GS->>Redis: HMGET room:{roomId} status, currentWord, drawerId, roundEndTime
    GS->>Redis: HGETALL player:{playerId}
    alt Correct guess
        GS->>Redis: MULTI → HSET hasGuessed=true, HINCRBY score, ZINCRBY leaderboard (guesser + drawer)
        GS->>Redis: CHECK all players guessed?
        alt All guessed early
            GS->>Redis: ZREM active_rounds {roomId}
            GS->>GS: endRound(roomId, io)
        end
        SocketIO-->>Browser: emit("system_message", {type:CORRECT_GUESS,...})
        SocketIO-->>Browser: emit("room_state_updated", updatedRoom)
    else Wrong guess
        SocketIO-->>Browser: emit("receive_message", {userName, message})
    end

    Worker->>Redis: ZRANGEBYSCORE active_rounds -inf now
    Redis-->>Worker: [roomId] (timer expired)
    Worker->>GS: endRound(roomId, io)
    GS->>Redis: HSET room:{roomId} status=ROUND_END
    SocketIO-->>Browser: emit("room_updated", room) + emit("system_message", ROUND_END)
    GS->>Redis: ZADD transition_rounds {now+3000} {roomId}

    Worker->>Redis: ZRANGEBYSCORE transition_rounds -inf now
    Redis-->>Worker: [roomId] (3s transition expired)
    Worker->>GS: processNextRound(roomId, io)
    GS->>GS: getNextDrawer() → next active player
    alt More rounds remain
        GS->>Redis: HSET room:{roomId} drawerId=next, round=N
        GS->>GS: startRound()
    else All rounds done
        GS->>Redis: HSET room:{roomId} status=GAME_OVER
        SocketIO-->>Browser: emit("room_updated", finalState)
    end

    Browser->>SocketIO: disconnect (tab close / network loss)
    SocketIO->>GS: markDisconnected(socketId)
    GS->>Redis: DEL socket:{socketId}, DEL player:{playerId}:socket
    Note over GS: 30-second grace timer starts
    GS-->>GS: setTimeout 30s → isPlayerReconnected()?
    alt Player reconnected within 30s
        Note over GS: Socket re-maps, player stays in room
    else No reconnect
        GS->>Redis: LREM players list, SREM players set, DEL player hash
        SocketIO-->>Browser: emit("room_updated") to remaining players
    end
```

---

## Edge Cases & Failure Handling

### Round Timer Drift
The worker loop fires every 1000ms via `setInterval`. JavaScript's event loop is single-threaded; if a prior tick is blocked by async I/O (e.g., slow Redis response), the next tick fires late. To mitigate this, round end times are stored as **absolute Unix timestamps in Redis** (`roundEndTime`), not relative countdown values. The worker queries `ZRANGEBYSCORE active_rounds -inf <now>` — so even if the worker fires 200ms late, it correctly picks up all rounds that should have ended.

### All Players Disconnect Mid-Game
If a disconnect brings active player count below 2:
1. `processNextRound` detects `activeCount < 2`.
2. Room is reset to `LOBBY` state.
3. The leaderboard is preserved; timers are cleared.
4. The `room_activity` sorted set still tracks the room — the stale room GC (30-minute TTL assessed by worker) will clean it up if nobody rejoins.

### Player Joins During Active Round
When a new socket fires `join_room` while the room is `PLAYING`:
1. The `player_joined` event is emitted to **all other sockets** in the room.
2. The drawer's `DrawingCanvas` listens for `player_joined` and immediately calls `canvas.toDataURL()` to snapshot the current drawing, then emits `sync_canvas` directly to the new player's socket ID.
3. The new player receives `receive_canvas_sync` and draws the image onto their blank canvas — providing near-instant state catch-up without the server holding any canvas data.

This is a **peer-to-peer canvas sync** routed through the server. The server only bridges the socket IDs; it never decodes or stores the canvas image.

### Redis Connection Loss
`ioredis` has built-in reconnection with exponential backoff. During reconnection, all handler methods that await Redis will throw errors caught by the try/catch in `workerLoop`. Game state in memory is zero — so a brief Redis outage means the worker skips ticks but does not corrupt state. Once Redis reconnects, the sorted sets pick up from where they left off.

### Duplicate Player IDs
`addPlayer` checks `SISMEMBER room:{roomId}:players:set` before inserting. If the player ID already exists (reconnect scenario), only the socket mapping is updated (`SET player:{id}:socket = newSocketId`) — the player data hash is untouched, preserving score.
