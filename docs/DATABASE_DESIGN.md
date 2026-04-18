# DATABASE_DESIGN.md — Storage Architecture

Scribble uses a **two-tier storage strategy**: Redis for hot real-time state, PostgreSQL for cold persistent data. Understanding *why* they are used together — and the exact data model in each — is critical for reasoning about performance, consistency, and scaling.

---

## Tier 1: Redis — Hot State

### Why Redis?

1. **Sub-millisecond latency**: Redis operates entirely in RAM. A `HGETALL` on a player hash takes ~0.2ms locally vs ~3–8ms for a PostgreSQL SELECT over TCP.
2. **Native game-data structures**: Sorted sets for timer queues, sets for unique membership & random word pools, lists for ordered player sequences — these map directly to game mechanics without ORM translation.
3. **Atomic pipelining**: `MULTI/EXEC` (Redis transactions) lets us score a guess, update a leaderboard, and mark a player as guessed in a single atomic operation — impossible to achieve in a non-transactional key-value store.
4. **TTL semantics**: We store room activity timestamps in a sorted set and use `ZRANGEBYSCORE` as a lazy GC mechanism. Redis doesn't impose any schema, so state layout can evolve without migrations.

---

### Redis Key Schema

#### Room Hash — `room:{roomId}`

```
HSET room:{roomId}
  status          → "LOBBY" | "CHOOSING_WORD" | "PLAYING" | "ROUND_END" | "GAME_OVER"
  round           → "1"  (current round number, string)
  maxRounds       → "6"
  drawerId        → "{playerId}" | ""
  currentWord     → "elephant" | ""
  roundEndTime    → "1713400027000"  (Unix timestamp ms, string)
```

**Why store all fields in one hash?**  
Batch reading with `HMGET` or `HGETALL` uses a single network round-trip. If each field were a separate key, assembling the room state would require multiple sequential GET calls or complex MULTI/EXEC pipelining.

#### Player Hash — `player:{playerId}`

```
HSET player:{playerId}
  name       → "alice"
  score      → "450"   (string; Redis stores everything as strings)
  hasGuessed → "true" | "false"
  roomId     → "{roomId}"
```

**Score storage**: Despite being a number conceptually, Redis hashes store strings. `HINCRBY player:{id} score 25` handles atomic increments natively — no read-modify-write race condition.

#### Player Ordering — `room:{roomId}:players` (LIST)

```
RPUSH room:{roomId}:players {playerId}
```

A Redis LIST preserves insertion order. This is the authoritative player sequence used for **turn rotation** (who draws next). `LRANGE room:{roomId}:players 0 -1` retrieves all players in join order in a single O(N) call.

**Why LIST + SET together?**  
- `LRANGE` on the LIST gives ordered player sequence for turn logic — O(N).
- `SISMEMBER` on the SET gives O(1) duplicate-join detection.
- `SCARD` on the SET gives O(1) room size check.

Using only a LIST would require a linear scan for membership checks. Using only a SET would lose ordering.

#### Player Membership Set — `room:{roomId}:players:set` (SET)

```
SADD room:{roomId}:players:set {playerId}
```

Used for: O(1) duplicate detection, O(1) cardinality, batch cleanup via `SMEMBERS`.

#### Socket ↔ Player Mappings (STRING)

```
SET socket:{socketId}         → {playerId}     ; lookup player from socket on any event
SET player:{playerId}:socket  → {socketId}     ; check if player is currently online
```

Two-direction mapping enables:
- Any inbound event: look up `socket:{socketId}` → playerId → player data.
- Disconnect/reconnect logic: check `EXISTS player:{id}:socket` to determine if player is still connected.
- `getNextDrawer`: pipe `GET player:{id}:socket` for each player ID — null result means disconnected.

#### Round Timer Queue — `active_rounds` (ZSET)

```
ZADD active_rounds {roundEndTime_ms} {roomId}
ZRANGEBYSCORE active_rounds -inf {now}    ; get all expired rounds
ZREM active_rounds {roomId}
```

Score = Unix timestamp of round end. The worker loop runs `ZRANGEBYSCORE -inf now` every second — O(log N + M) where M is the number of results. In practice M=0 or 1 per tick.

**Why a sorted set?**  
A sorted set's range query is O(log N + M) — much better than scanning a hash table or list. It also supports multiple rooms with different end times simultaneously.

#### Transition Timer Queue — `transition_rounds` (ZSET)

Same structure as `active_rounds`, but scores = time to proceed to next round after 3-second transition delay.

#### Leaderboard — `room:{roomId}:leaderboard` (ZSET)

```
ZINCRBY room:{roomId}:leaderboard {points} {playerId}
ZRANGE  room:{roomId}:leaderboard 0 -1 WITHSCORES REV  ; top-N ordered
```

ZSET auto-sorts by score. `ZINCRBY` is atomic — no concurrent update race. Currently the leaderboard is maintained in Redis but not separately emitted; scores are embedded in player hashes and returned via `getRoom`.

#### Word Pool — `room:{roomId}:words` (SET)

```
SADD  room:{roomId}:words "word1" "word2" ... "word150"
SPOP  room:{roomId}:words     ; random pop — O(1), removes the word
EXPIRE room:{roomId}:words 180000  ; 3 minutes TTL
```

`SPOP` is critical here: it atomically pops a **random** element from the set. This gives us word-without-replacement semantics, ensuring no repeated words within a word pool refresh cycle. When the set is empty, the server fetches a fresh batch of 150 from PostgreSQL.

#### Room Activity Tracker — `room_activity` (ZSET)

```
ZADD room_activity {now} {roomId}   ; updated on any room activity
ZRANGEBYSCORE room_activity -inf {30minsAgo}  ; find stale rooms
```

Stale rooms (no activity for 30 minutes) are force-deleted by the worker loop. This is the primary GC mechanism for abandoned rooms.

---

## Tier 2: PostgreSQL — Cold Persistent Data

### Schema (Prisma DSL)

```prisma
model Word {
  id    Int    @id @default(autoincrement())
  word  String
  level String  // difficulty: "easy" | "medium" | "hard"
}

model User {
  id        Int      @id @default(autoincrement())
  username  String
  avatorUrl String?
  xp        Int      @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

### `Word` Table

**Purpose**: Canonical word dictionary. Contains thousands of unique words with a difficulty level.

**Query pattern**:
```sql
SELECT word FROM "Word" ORDER BY RANDOM() LIMIT 150
```

`ORDER BY RANDOM()` causes a sequential scan with a sort — O(N log N). This is the **only query that hits PostgreSQL per room per game session block**. After the first fetch, all 150 words are cached in Redis for the room, so subsequent rounds consume from the cache.

**Why `$queryRawUnsafe`?**  
Prisma's standard `findMany` with `orderBy` does not support `RANDOM()` via the ORM API. `$queryRawUnsafe` allows the raw SQL needed for database-native random sorting. `RANDOM()` in PostgreSQL is evaluated per-row during the sort, making it the most efficient random-selection approach short of maintaining a pre-shuffled array.

**Optimization consideration**: For a word table with O(10k) rows, `ORDER BY RANDOM()` performs a full scan + sort each time. An alternative is `TABLESAMPLE SYSTEM(10)` followed by `LIMIT 150`, which is O(1) sampling but can have statistical bias. For the current scale (infrequent batch fetches), the simpler approach is acceptable.

**Indexing**:
- `id` — primary key, B-tree indexed automatically.
- `level` — a partial index `CREATE INDEX idx_word_level ON "Word"(level)` would optimize word-by-difficulty queries if added later.

### `User` Table

**Purpose**: Persistent player profiles with XP progression. Currently populated by auth flow (scaffolded — not fully wired into game loop yet).

**Connection Pooling**: Uses `pg.Pool` (not a single `pg.Client`) via `PrismaPg` adapter:

```typescript
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
```

The `Pool` maintains N idle connections (default: 10) and reuses them. This avoids the ~5ms TCP+TLS handshake + PostgreSQL authentication overhead on every query. In dev with Prisma query logging enabled, this is visible as the difference between a first query (~50ms) and subsequent queries (~3–5ms).

---

## Data Consistency Model

Redis does not provide ACID guarantees across multiple keys. Scribble handles consistency via:

1. **Pipelining** (`MULTI/EXEC`): Scoring a guess (`HSET hasGuessed`, `HINCRBY score`, `ZINCRBY leaderboard`) is a single atomic pipeline. Either all three succeed or all fail — no partial updates.

2. **Idempotent guards**: `SISMEMBER` before `SADD` prevents duplicate player registration. `checkGuess` checks `player.hasGuessed === "true"` before scoring — prevents double-scoring from rapid fire guesses.

3. **Worker-driven state transitions**: State advances (`PLAYING → ROUND_END → PLAYING`) happen only via the server-side worker loop, never from client events alone. This prevents race conditions where two clients could simultaneously trigger `endRound`.

---

## Scaling Considerations

### Redis Scaling

- **Single instance** (current): Sufficient for hundreds of rooms. Redis processes ~1M ops/sec on a single core.
- **Redis Cluster**: For massive scale (10k+ concurrent rooms), shard by `roomId` hash slot. All keys for a room share a hash tag `{roomId}` — Redis Cluster routes them to the same shard.
- **Memory sizing**: Each room ≈ 500 bytes of keys + 80 bytes per player. 10,000 rooms with 8 players ≈ 11MB. Negligible.

### PostgreSQL Scaling

- Word fetches are **extremely infrequent** (once per room session block). A single Postgres instance handles thousands of rooms without issue.
- Add a `READ REPLICA` for word fetches if write contention becomes a concern (unlikely with the current schema).
- `pg.Pool` size should be `(num_cores * 2) + effective_spindle_count` per the PgBouncer recommendation.
