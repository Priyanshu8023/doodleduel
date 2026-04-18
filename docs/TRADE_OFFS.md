# TRADE_OFFS.md — Technology Decisions & Limitations

## Why Each Technology Was Chosen

### Next.js 16 as the Frontend Framework

**Chosen because:**
- App Router provides RSC (React Server Components) for zero-JS landing page and routing.
- Handles SSR, static asset serving, and image optimization out-of-the-box.
- File-based routing eliminates boilerplate routing setup.
- The `use(params)` hook in React 19 + Next.js 16 enables async param unwrapping in client components.

**Trade-off against alternatives:**
- **Vite + React SPA**: Simpler bundle, faster dev HMR. But no SSR, no built-in static serving — would require a separate static file server.
- **Remix**: Strong SSR story but smaller ecosystem; WebSocket integration equally custom.
- **SvelteKit**: Smaller bundle sizes, but the team is standardized on React.

**Limitation**: Next.js's built-in server (started in App Router era) is incompatible with Socket.IO. A custom `server.ts` replaces Next.js's standalone server — this means features like Next.js's built-in image optimization cache must be manually configured, and Vercel/serverless deployment is **incompatible** (the custom server requires a persistent process).

---

### Socket.IO over Raw WebSocket

**Chosen because:**
- Automatic transport negotiation (polling → WebSocket) — handles corporate firewalls and proxies that block WebSocket upgrades.
- Built-in room management (`socket.join(roomId)`, `io.to(roomId).emit()`) — removing the need to implement room fan-out manually.
- Auto-reconnection with exponential backoff.
- The Redis adapter for horizontal scaling is a first-class plugin.

**Trade-off against alternatives:**
- **Raw `ws` library**: Lower overhead (~5KB vs Socket.IO's ~25KB client bundle), no transport fallback, no built-in rooms. Would require building room management and reconnection from scratch.
- **WebTransport (HTTP/3)**: Lower latency (UDP-based), but browser support is still limited (~85% as of 2025) and there's no battle-tested Node.js server library.
- **Server-Sent Events (SSE)**: Unidirectional server→client only. Would require HTTP polling back-channel for client→server events. Not suitable for bidirectional real-time drawing.

**Current limitation**: Socket.IO has ~3× the protocol overhead of raw WebSocket due to its encoding/framing layer (`42["event",...]`). For drawing streams this adds ~5–10 bytes per message — negligible at batch sizes.

---

### Redis (ioredis) as Primary Game State Store

**Chosen because:**
- Entire `RoomState` assembly takes ~1ms (vs ~5ms+ for equivalent PostgreSQL joins).
- Native data structures (`ZSET` for timers, `SET` for word pools) eliminate ORM translation layer.
- Atomic `MULTI/EXEC` pipelines prevent scoring race conditions.
- Stateless server — Redis holds all state, enabling process restarts without game loss.

**Trade-off against alternatives:**
- **In-memory JavaScript Map**: Zero latency, but state lost on restart. No horizontal scaling.
- **PostgreSQL only**: ACID guarantees, but a row lock per guess in a high-concurrency game could serialize what should be parallel operations.
- **Memcached**: No rich data structures (no ZSET, no SPOP). Pipelining is available but less expressive.
- **DynamoDB**: Managed, serverless scaling. But no native sorted set; leaderboard and timer queue would need workarounds. Higher read/write unit costs add up at scale.

**Limitations**:
- Redis is not durable by default (memory-only). If Redis crashes, all active game rooms are lost. Mitigation: enable RDB snapshots (`save 60 1000`) or AOF persistence, at the cost of ~5–10% write throughput.
- The `EXPIRE` bug on the word pool (`redis.expire(key, 180000)` sets 50-hour TTL instead of 3 minutes) means word caches grow stale without auto-cleanup —keys persist until GC or room deletion.

---

### PostgreSQL + Prisma for Cold Storage

**Chosen because:**
- Relational model suits the `Word` (id, word, level) and `User` (id, username, xp) schemas perfectly.
- Prisma provides type-safe queries, migration management, and the generated client.
- The `pg` Pool + `PrismaPg` adapter allows using Prisma without its default Rust query engine binary — important for Docker Alpine compatibility.

**Trade-off against alternatives:**
- **SQLite**: Zero-dependency, perfect for dev. But not suitable for concurrent writes from multiple processes (WAL mode helps, but not for horizontal scaling).
- **MongoDB**: Flexible schema, useful if word objects needed complex attributes. Overhead for a simple `{id, word, level}` schema is unjustified.
- **Storing words in Redis only**: Faster, but loses the ability to query by `level`, filter, or add secondary word attributes. PostgreSQL remains the source of truth.

**Prisma limitation**: `$queryRawUnsafe` for `ORDER BY RANDOM()` bypasses Prisma's type safety. The query is low-risk (read-only) but not validated against the schema by the ORM.

---

### `tsx` as the TypeScript Runtime

**Chosen because:**
- Zero-config TypeScript execution for `server.ts`. No separate `tsc` compilation step during development.
- Fast startup — uses esbuild under the hood, transpiling TypeScript on-the-fly.
- Supports `@` path aliases out-of-the-box (reads `tsconfig.json` `paths`).

**Trade-off against alternatives:**
- **`ts-node`**: Slower (uses TypeScript compiler vs esbuild). But more spec-compliant for edge cases.
- **Compiling to JS**: The correct production approach — `tsc` → `node dist/server.js`. Eliminates `tsx` from the production runtime, reducing container overhead. Not yet implemented.
- **Bun**: Native TypeScript execution, faster I/O. Migration risk — Bun's `bun:crypto`, socket handling, and Node.js API compatibility gaps could break Socket.IO or Prisma.

**Current limitation**: Running TypeScript in production via `tsx` means every file is transpiled at process startup (~0.5s overhead). Under load, this is a cold start concern (mitigated by Docker — the container is warmed up before routing traffic).

---

### Draw Batching (50ms / 20-point threshold)

**Chosen because:**
- Reduces WebSocket message frequency by ~20× vs per-mousemove emision.
- Keeps each payload under 2KB, well within Socket.IO's default max buffer size.

**Trade-off:**
- Introduces up to 50ms of artificial latency on top of network RTT. At 50ms + 50ms WAN = ~100ms perceived lag. Versus HTTP polling which would add 100–500ms.
- Fast mouse strokes (e.g., a quick curve) that accumulate 20 points trigger an emit immediately regardless of time — this keeps the 50ms cap from becoming a bottleneck for fast drawers.

---

## Known Limitations & What Could Be Improved

| Area | Current Limitation | Recommended Fix |
|---|---|---|
| `sync_canvas` trust | Any client can send fake canvas data to any socket | Validate that sender is the current drawer server-side |
| `currentWord` exposure | Full word sent to all clients in `room_updated` | Send masked word to guessers; full word to drawer only |
| Single worker loop | Multiple instances both run `endRound` | Redis `SET NX EX` distributed lock per room per tick |
| No auth on `start_game` | Any player can start if conditions met | Track `hostPlayerId` in room hash; validate on server |
| `tsx` in production | Runtime TypeScript transpilation overhead | Compile `server.ts` with `tsc` in Dockerfile builder stage |
| `redis.expire` bug | 180000 seconds (50h) instead of 180 seconds (3min) | `redis.expire(key, 180)` |
| No message rate limiting | Spam possible via `chat_message`/`draw_batch` | Token bucket per socket in Redis |
| Canvas not responsive | Fixed pixel buffer set at mount; doesn't resize | Debounced resize observer → `canvas.width = newWidth` |
| `ORDER BY RANDOM()` | Full table scan on Postgres word fetch | Pre-cache all words in a global Redis SET on startup |
| No error boundaries | Unhandled promise rejections can crash Node.js | `process.on('unhandledRejection', handler)` + per-handler try/catch |
