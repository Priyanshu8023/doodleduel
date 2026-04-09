# Scribble

## 🚀 Overview
**Scribble** is a high-performance, real-time multiplayer drawing and guessing game. Built on top of Next.js and Socket.io, it allows players to join live virtual rooms, take turns drawing words on a shared interactive canvas, and compete to guess the correct word as fast as possible. 

**Problem it solves:** Many legacy browser-based drawing games suffer from high latency, stale UI, or bottlenecked connections when lobbies grow. Scribble solves this by bringing modern React paradigms and a Redis-adapter backend to gracefully handle rapid batched WebSocket events without breaking a sweat, resulting in ultra-smooth real-time gameplay.

**Use cases:** 
* Remote party games with friends.
* Engaging community events for Discord servers or Twitch streams.

## 🧠 Features
* **Real-Time Interactive Canvas:** Zero-lag drawing synchronization utilizing batched coordinate processing over WebSockets.
* **Live Multiplayer Chat:** A dedicated prediction chat featuring server-side word validation and automated point allocation.
* **Dynamic Turn Management:** Synchronous clocks and turn rotators broadcast globally across connected clients.
* **In-Memory Dictionary Engine:** 150+ randomized game words actively cached via Redis directly from PostgreSQL to eliminate database bottlenecks during rapid gameplay.
* **Responsive Modern UI:** Fully styled using Tailwind CSS and Framer Motion for immediate visual feedback and dynamic leaderboards.

## 🛠️ Tech Stack
* **Frontend:** Next.js (App Router), React 19, Tailwind CSS v4, Framer Motion
* **Backend:** Node.js, Express.js, Socket.io
* **Database:** PostgreSQL, Prisma ORM
* **Caching & Pub/Sub:** Redis, `socket.io-redis-adapter`
* **DevOps:** Docker, Docker Compose (Multi-stage builds)

## 📂 Project Structure
```text
scribble/
├── app/                  # Next.js App Router root
│   ├── game/             # Dynamic routing for game lobbys (e.g., /game/[roomId])
│   ├── layout.tsx        # Global shared page layout (fonts, providers)
│   ├── page.tsx          # Landing page entry point
│   └── globals.css       # Tailwind CSS directives & global stylesheets
├── components/           # Reusable React components (Modular architecture)
│   ├── game/             # Game-specific UI (ChatSection, DrawingCanvas, PlayerList)
│   ├── CanvasPreview.tsx # Re-usable canvas viewer for the homepage
│   ├── Hero.tsx          # Homepage landing graphics
│   └── Navbar.tsx        # Top navigation element
├── lib/                  # Shared utilities and global singletons
│   ├── prisma.ts         # Prisma ORM instantiation and adapter logic
│   ├── redisClient.ts    # Redis connection handler
│   ├── redisAdapter.ts   # Integration linking Node server to Redis pub/sub
│   └── socket.ts         # Client-side socket initialization
├── server/               # Custom Express.js & WebSocket backend
│   ├── server.ts         # Initializes Express listener alongside Next.js handler
│   ├── socket/           # WebSocket event sub-handlers (draw, guess, join)
│   └── store/            # In-memory volatile state buffers
├── prisma/               # Database integration
│   ├── schema.prisma     # Postgres tables (User, Game, Stats models)
│   └── migrations/       # SQL tracking history
├── generated/            # Custom target folder for compiled Prisma typings
├── Dockerfile            # Configured for Node 20-Alpine multi-stage NextJS builds
└── docker-compose.yml    # Rapid infrastructure orchestration (Redis/PG/App)
```

## ⚙️ Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Priyanshu8023/scribble.git
   cd scribble
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Database Initialization:**
   ```bash
   npx prisma generate
   npx prisma db push
   ```

4. **Start the Development Server:**
   ```bash
   npm run dev
   # Server runs natively on http://localhost:3000
   ```
*(Alternatively, run the entire stack seamlessly via `docker-compose up --build`)*

## 🔐 Environment Variables
Duplicate `.env.example` (or create `.env.local`) and configure:
```env
# Server
PORT=3000

# Database
DATABASE_URL="postgresql://user:password@localhost:5432/scribble?schema=public"

# Cache
REDIS_URL="redis://localhost:6379"
```

## 🧩 System Architecture
Scribble operates natively under a monolith architecture with extended custom server functionality. Next.js handles the front-end rendering and static assets, while a custom Node/Express wrapper hosts the Socket.io WebSocket connections on the same port. To allow for horizontal scaling across multiple Docker instances, Socket.io utilizes a Redis Adapter to synchronize real-time actions. Game words and leaderboard metrics are permanently stored in PostgreSQL and retrieved natively via Prisma.

## 🖼️ Architecture Diagram

```mermaid
graph LR
    classDef frontend fill:#3b82f6,stroke:#1d4ed8,stroke-width:2px,color:#fff,rx:8px,ry:8px;
    classDef backend fill:#10b981,stroke:#047857,stroke-width:2px,color:#fff,rx:8px,ry:8px;
    classDef db fill:#f59e0b,stroke:#b45309,stroke-width:2px,color:#fff,rx:8px,ry:8px;
    classDef cache fill:#ef4444,stroke:#b91c1c,stroke-width:2px,color:#fff,rx:8px,ry:8px;
    classDef users fill:#64748b,stroke:#334155,stroke-width:2px,color:#fff,rx:15px,ry:15px;

    subgraph Clients ["🎮 Players (Browser)"]
        direction TB
        User1((Player 1)):::users
        User2((Player 2)):::users
    end

    subgraph AppServer ["⚡ Application Tier"]
        direction TB
        NextJS["Next.js (React UI)"]:::frontend
        Express["Express.js + Socket.io"]:::backend
    end

    subgraph DataLayer ["🗄️ Data Layer"]
        direction TB
        Redis[("Redis (Cache & Pub/Sub)")]:::cache
        Postgres[("PostgreSQL via Prisma")]:::db
    end

    %% Client Interactions
    User1 <--> |WebSockets| Express
    User2 <--> |WebSockets| Express
    User1 -.-> |HTTP| NextJS
    User2 -.-> |HTTP| NextJS

    %% Internal Routing
    NextJS -.-> |Serves build| Express

    %% Database and Cache Logic
    Express <--> |Syncs Rooms & Caches| Redis
    Express <--> |Persists Game Stats| Postgres
    Postgres -.-> |Hydrates Dictionary| Redis
```

## 📡 API Endpoints (WebSocket Events)
While maintaining minimal REST APIs, Scribble functions primarily via Event Emitters:
* **`join_room(roomId, user)`:** Attaches client to a specific game lobby.
* **`draw_batch(points[])`:** Intakes batched array vectors to distribute coordinate rendering.
* **`guess_word(string)`:** Fires user guesses through the backend validation engine.
* **`room_state_update(Context)`:** Emits the collective game board synchronization timer, leaderboards, and actively drawing player details.

## 🧪 Future Improvements
* **OAuth Login & Elo Tracking:** Integrating `NextAuth.js` to enable Google/Discord logins, allowing players to retain lifelong Elo rating and stats across sessions.
* **Custom Word Lobbies:** Provide host users the functionality to submit custom prompt lists to the PostgreSQL DB alongside the standard dictionary arrays.
* **WebRTC Integration:** Currently, vector drawings are routed via TCP WebSockets. Shifting pure coordinates to WebRTC UDP channels could reduce drawing latency from `~30ms` to `<5ms`, offering true zero-latency rendering under heavy network strain.
