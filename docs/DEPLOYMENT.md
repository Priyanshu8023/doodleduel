# DEPLOYMENT.md — Infrastructure & CI/CD

## Deployment Architecture

```mermaid
graph TB
    subgraph Internet
        User["User Browser"]
    end

    subgraph Cloud ["Cloud Provider (e.g. DigitalOcean / AWS / Render)"]
        LB["Load Balancer\n(Sticky Sessions via IP Hash)"]

        subgraph Node1 ["Node.js Instance 1"]
            App1["server.ts\nNext.js + Socket.IO"]
        end

        subgraph Node2 ["Node.js Instance 2 (optional)"]
            App2["server.ts\nNext.js + Socket.IO"]
        end

        subgraph DataLayer ["Data Layer"]
            Redis["Redis\n(Primary game state\n+ Pub/Sub adapter)"]
            Postgres["PostgreSQL\n(Word dict + Users)"]
        end
    end

    User --> LB
    LB -->|"sticky"| Node1
    LB -->|"sticky"| Node2
    Node1 <-->|"ioredis"| Redis
    Node2 <-->|"ioredis"| Redis
    Node1 <-->|"pg Pool"| Postgres
    Node2 <-->|"pg Pool"| Postgres
    Node1 <-->|"pub/sub adapter"| Redis
    Node2 <-->|"pub/sub adapter"| Redis
```

---

## Docker Setup

### Multi-Stage Dockerfile Analysis

The Dockerfile uses a 3-stage multi-stage build pattern:

```dockerfile
# Stage 1: deps — install ALL dependencies (dev + prod)
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat   # Required for some native modules on Alpine
COPY package.json package-lock.json* ./
RUN npm ci                             # Reproducible, locked install

# Stage 2: builder — compile Next.js + generate Prisma client
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate   # Generates TypeScript client to generated/prisma/
RUN npm run build         # next build → .next/ output directory

# Stage 3: runner — minimal runtime image
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs    # Non-root group
RUN adduser --system --uid 1001 nextjs     # Run as non-root user (security)

# Copy only what runtime needs — NOT dev dependencies
COPY --from=builder /app/public ./public
COPY --from=builder /app/server ./server
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/package.json /app/package-lock.json* ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/generated ./generated

RUN npm ci --omit=dev && npm install tsx   # Production deps only + tsx runner

COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

USER nextjs
EXPOSE 3000
CMD ["npm", "run", "start"]   # NODE_ENV=production tsx server/server.ts
```

**Why `libc6-compat`?**  
Alpine Linux uses `musl libc` instead of `glibc`. Some native Node.js modules (and PostgreSQL's `pg` native bindings) require `glibc` shims provided by `libc6-compat`.

**Why copy `generated/` into runner stage?**  
`prisma generate` outputs the Prisma client (TypeScript types + query engine WASM/binary) into `generated/prisma/`. This directory is required at runtime for ORM queries. Without copying it, the runtime container would fail with "Cannot find module '../generated/prisma/client'".

**Why `npm install tsx` separately in the runner stage?**  
`tsx` is a devDependency (TypeScript execution). After `npm ci --omit=dev`, it's stripped. Since `server.ts` is **not compiled by `next build`** (it's a separate entry point), we need `tsx` at runtime to execute TypeScript. A more production-hardened approach would compile `server.ts` with `tsc` during the builder stage.

**Final image size estimate**: node:20-alpine base (~140MB) + pruned dependencies + .next build (~80MB) + generated Prisma client (~20MB) ≈ **~270MB** total.

---

### Docker Compose (Local Development)

```yaml
services:
  app:
    build: .
    ports: ["3000:3000"]
    environment:
      - DATABASE_URL=postgresql://user:password@db:5432/scribble
      - REDIS_URL=redis://redis:6379

  db:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: password
      POSTGRES_DB: scribble
    volumes:
      - pgdata:/var/lib/postgresql/data   # Persistent data across container restarts

  redis:
    image: redis:alpine
```

**`depends_on` note**: `depends_on` in Compose ensures startup ordering but does NOT wait for health — the `db` container might not be ready to accept connections when `app` starts. For production, add `healthcheck` + `depends_on.condition: service_healthy`.

---

## Environment Variables

| Variable | Required | Example | Notes |
|---|---|---|---|
| `DATABASE_URL` | Yes | `postgresql://user:pass@host:5432/scribble` | Used by pg Pool and Prisma CLI |
| `REDIS_URL` | Yes | `redis://localhost:6379` | Used by ioredis + redis-adapter |
| `NODE_ENV` | Yes | `production` | Controls Next.js optimization + Prisma log levels |
| `HOSTNAME` | No | `0.0.0.0` | Socket bind address; defaults to localhost |
| `PORT` | No | `3000` | Currently hardcoded in server.ts; env var is set but not consumed |
| `NEXT_TELEMETRY_DISABLED` | No | `1` | Disables anonymous Next.js telemetry |

---

## CI/CD Overview

The project does not currently include a CI/CD pipeline file, but the recommended setup is:

```mermaid
flowchart LR
    Push["git push to main"] --> CI["GitHub Actions / GitLab CI"]
    CI --> Lint["npm run lint\n(eslint)"]
    CI --> Build["npm run build\n(next build)"]
    CI --> DockerBuild["docker build\n(multi-stage)"]
    DockerBuild --> Push2["docker push\n(Docker Hub / ECR / GHCR)"]
    Push2 --> Deploy["Deploy to Server\n(docker pull + docker-compose up -d)"]
    Deploy --> HealthCheck["GET /api/custom-health-check\n(smoke test)"]
```

### Recommended GitHub Actions Pipeline

```yaml
name: Build & Deploy

on:
  push:
    branches: [main]

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Set up Node 20
        uses: actions/setup-node@v4
        with: { node-version: '20' }
      
      - run: npm ci
      - run: npx prisma generate
      - run: npm run build
      
      - name: Docker login
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}
      
      - name: Build & Push
        uses: docker/build-push-action@v5
        with:
          push: true
          tags: ${{ secrets.DOCKERHUB_USERNAME }}/scribble:latest
      
  deploy:
    needs: build-and-push
    runs-on: ubuntu-latest
    steps:
      - name: SSH deploy
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            docker pull ${{ secrets.DOCKERHUB_USERNAME }}/scribble:latest
            docker-compose -f /app/docker-compose.yml up -d app
```

---

## Database Migrations

Prisma migrations are managed via CLI:

```bash
# Development: create and apply migration
npx prisma migrate dev --name add_word_level

# Production: apply existing migrations
npx prisma migrate deploy

# Generate Prisma client (must run after schema changes)
npx prisma generate
```

**Important**: The `generated/` directory (Prisma client output) is included in the Docker image and must be regenerated and rebuilt on schema changes. Add `npx prisma generate` to the CI pipeline before `npm run build`.

---

## Port & Networking

- **Port 3000**: Both Next.js HTTP and Socket.IO WebSocket traffic — same process, same TCP port.
- **Port 5432**: PostgreSQL (should NOT be exposed publicly in production; only accessible within container network).
- **Port 6379**: Redis (same — internal only).

**Reverse Proxy (Production):** Place Nginx or Caddy in front to handle:
- TLS termination (HTTPS/WSS).
- HTTP → HTTPS redirect.
- WebSocket upgrade passthrough:
  ```nginx
  location / {
      proxy_pass http://localhost:3000;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_read_timeout 86400;  # Keep WS alive
  }
  ```
