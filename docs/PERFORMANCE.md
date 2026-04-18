# PERFORMANCE.md — Latency, Concurrency & Throughput

## Performance Philosophy

Scribble is a real-time game. Its performance requirements differ fundamentally from typical web APIs:

- **Drawing latency** (drawer stroke → guesser screen): target < 100ms end-to-end on LAN; < 200ms on WAN.
- **Guess processing latency**: < 50ms server-side (Redis read + compare + write).
- **Round timer accuracy**: ±200ms is imperceptible to players.
- **Concurrency**: O(100) concurrent rooms, O(8) players per room = O(800) concurrent WebSocket connections per instance.

---

## Latency Breakdown

### Drawing Path (Critical Path)

```
Drawer MouseMove
  → React synthetic event handler (~0.1ms)
  → accumulate into drawBatchRef (~0ms in-memory)
  [50ms timer fires]
  → socket.emit() serializes JSON (~0.05ms for 20 points)
  → WS send syscall (~0.1ms)
  → Network (LAN ~0.5ms | WAN ~20–80ms)
  → Node.js recv + Socket.IO decode (~0.2ms)
  → Handler: verify drawer + gameStore.getRoom() [2 Redis GETs: ~0.3–0.8ms]
  → socket.to(roomId).emit() fan-out (~0.1ms per recipient)
  → Network (same)
  → Recipient WS recv + decode (~0.2ms)
  → drawLine() on Canvas2D (~0.1ms)

Total (LAN): ~3–6ms
Total (WAN with 50ms ping): ~120–160ms
```

The dominant latency component on WAN is **network RTT**, not server processing. Server-side processing for a draw_batch is consistently under 2ms.

### Guess Processing Path

```
Client: socket.emit("chat_message")
Server: getPlayerIdBySocket() → 1 Redis GET (~0.3ms)
Server: getPlayer() → 1 Redis HGETALL (~0.3ms)
Server: checkGuess():
  → hmget(roomId, 4 fields) (~0.3ms)
  → hgetall(player) (~0.3ms)
  → MULTI/EXEC pipeline (3–5 commands) (~0.5ms)
  → lrange + pipeline (check all guessed) (~0.5ms)
Total server-side: ~2.5ms
```

---

## Redis Pipeline Optimisations

### `getRoom()` — Most Called Function

```typescript
const room = await redis.hgetall(`room:${roomId}`);             // 1 RTT
const playerIds = await redis.lrange(`room:${roomId}:players`, 0, -1); // 1 RTT
const players = await Promise.all(
    playerIds.map(id => redis.hgetall(`player:${id}`))          // N RTTs parallel
);
```

Critical issue: `Promise.all` here sends N `HGETALL` commands in parallel (non-blocking), but each is still a separate network round-trip. For 8 players this is 8 parallel Redis GETs (~0.3ms each). With `Promise.all` these resolve concurrently in ~0.3ms total. However, this means getRoom() costs 2 sequential RTTs + 1 parallel RTT = ~0.9ms in the best case.

**Optimization opportunity**: Use a single `MULTI/EXEC` pipeline that includes all player `HGETALL` commands to eliminate all sequential RTTs except one.

### `getActivePlayerCount()` — Uses Pipeline

```typescript
const pipeline = redis.multi();
playerIds.forEach(id => {
    pipeline.get(`player:${id}:socket`);
});
const results = await pipeline.exec();
```

This is a proper pipeline: N commands are buffered locally and sent in a single network write. Redis executes them sequentially server-side and returns all results in one response. For 8 players: 1 RTT total instead of 8.

### `checkGuess()` Scoring Pipeline

```typescript
const tx = redis.multi();
tx.hset(`player:${playerId}`, "hasGuessed", "true");
tx.hincrby(`player:${playerId}`, "score", points);
tx.zincrby(`room:${roomId}:leaderboard`, points, playerId);
tx.hincrby(`player:${drawerId}`, "score", drawerPoints);
tx.zincrby(`room:${roomId}:leaderboard`, drawerPoints, drawerId);
await tx.exec();
```

5 commands → 1 RTT. Crucially also atomic — no other command can interleave between the score increment and the leaderboard update.

---

## Concurrency Model

Node.js is single-threaded with an event loop. All I/O is non-blocking. This suits Scribble well:

- Socket.IO event handlers are async functions. Each `await redis.*` call yields the event loop, allowing other incoming events to be processed.
- 800 concurrent connections, each emitting draw_batch every 50ms = 16,000 events/sec. Each event requires ~3 Redis ops = ~48,000 Redis ops/sec. Redis handles ~500,000–1,000,000 ops/sec; this is a 2–5% load.
- The worker loop fires every 1000ms and its async operations complete within ~5ms — 0.5% of the loop time.

**What would saturate the event loop?**  
CPU-intensive synchronous work (e.g., large JSON.stringify on every event). The current codebase avoids this — JSON encoding happens in the V8 socket.io internals on relatively small payloads.

---

## Caching Architecture

### Level 1: Redis Word Cache (Per-Room SET)

```
On round start:
  Redis SPOP room:{roomId}:words   → word available (cache hit, ~0.3ms)
  
Cache miss path (first round):
  PostgreSQL: SELECT word FROM "Word" ORDER BY RANDOM() LIMIT 150  (~5–50ms)
  Redis SADD room:{roomId}:words [...150 words]   (~1ms)
  Redis SPOP → word
```

Cache hit rate after first round: **100%** until 150 words are exhausted (with 6 rounds and ≤8 players = ≤48 words per game — the cache never fully drains in one session).

**TTL**: 180,000ms (3 minutes) set via `EXPIRE`. This is intentionally set to 3 minutes rather than a game-length TTL, because the server doesn't have a reliable hook to delete the key when a room ends mid-game.

**Issue**: `redis.expire(key, 180000)` passes `180000` as seconds, not milliseconds. Redis TTL unit is always seconds. This would set a 50-hour TTL — a bug. Correct call: `redis.expire(key, 180)`.

### Level 2: In-Process Audio Caching (Client-side)

```typescript
let correctSound: HTMLAudioElement | null = null;

export const playCorrectGuessSound = () => {
    if (!correctSound) correctSound = getAudio("/sounds/playerGuessed.ogg");
    correctSound.currentTime = 0;
    correctSound.play();
};
```

Audio elements are lazily instantiated once and reused. This avoids re-fetching the audio file from the server on every correct guess. The file is served as a static asset by Next.js from the `public/sounds/` directory, which benefits from browser HTTP cache headers.

### Level 3: Prisma Client Singleton (Server-side)

```typescript
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };
const prisma = globalForPrisma.prisma ?? createPrismaClient();
if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = prisma;
}
```

In development, Next.js hot-reloads modules on file changes, which would create a new `PrismaClient` (and a new connection pool) on every save. The `globalThis` trick persists the singleton across hot reloads, preventing pool exhaustion.

In production (a single process), the singleton is created once at startup.

---

## Bottlenecks & Mitigations

| Bottleneck | Impact | Current Mitigation | Future Mitigation |
|---|---|---|---|
| `getRoom()` called on every socket event | ~1ms per call, called ~5x per round transition | Acceptable at current scale | Cache RoomState in memory for 100ms with invalidation on write |
| `ORDER BY RANDOM() LIMIT 150` (Postgres) | ~10–50ms, full table scan | Called only once per room session | Pre-shuffle word list at startup; store in Redis global SET |
| Worker loop on every instance (multi-instance) | Duplicate `endRound` calls | Not yet addressed | Use Redis `SET NX EX` as distributed lock before processing each room |
| Canvas sync via `toDataURL` (base64 PNG) | Can be 50–300KB for complex drawings | One-shot on `player_joined` | Use incremental canvas state (replay draw commands) |
| No rate limiting on `draw_batch` | Malicious client could spam events | `points.length > 200` guard | Token bucket per socket using Redis |
| Chat message 100-character limit enforced server-side | Minimal | `message.length > 100` check | Add connection-level rate limiter (e.g., max 10 events/sec per socket) |

---

## Memory Profile

### Server (Node.js process)

- Socket.IO: ~2–4KB per connected socket overhead.
- `GameStore`: zero in-memory state — all data in Redis.
- `workerStarted` flag + `setInterval` handle: negligible.
- Prisma connection pool: ~5MB base + 2MB per idle connection (10 connections = ~25MB total).
- Expected idle baseline: ~150MB Node.js heap (Next.js + Socket.IO + Prisma).

### Client (Browser)

- `drawBatchRef`: array of up to 20 points at ~80 bytes each = ~1.6KB max in-flight.
- `chat` state: capped at 100 messages (`slice(-100)`). Each message ~100 bytes = ~10KB max.
- Canvas pixel buffer: `width × height × 4 bytes` = a 1920×1080 canvas uses ~8MB.
