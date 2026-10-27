# VideoCall

Free, no-signup **1-on-1 video calls in the browser**. Create a room, share the link, talk face-to-face. No accounts, no downloads, no plugins.

> **Status:** working prototype, hardened for single-instance deployment. Rooms are stored in SQLite, so on a VPS they survive restarts and deploys with no extra services. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for limitations (group calls, horizontal scaling, verified E2EE) and [`docs/DEPLOY-VPS.md`](docs/DEPLOY-VPS.md) for a full VPS walkthrough.

---

## How it works

```
Browser A ──┐                                        ┌── Browser B
            │   Socket.IO (SDP + ICE relay only)     │
            └──────────────►  Node server  ◄─────────┘
                             Express + Socket.IO
                             in-memory room store
            ┌─────────────── WebRTC media ───────────┐
            └─────────────  peer-to-peer  ───────────┘
```

The server never sees media. It stores room metadata, enforces the 2-peer limit, and relays signaling messages. Audio and video flow directly between browsers (or through a TURN relay when a direct path is impossible).

## Quick start

```bash
# 1. Install (pnpm is required — enforced by preinstall)
corepack enable && corepack prepare pnpm@10 --activate
pnpm install

# 2. Run the API (port 8080) and the web app (port 5173) together
pnpm dev
```

Open <http://localhost:5173>. Vite proxies `/api` and `/socket.io` to the API server, so no environment variables are needed for a local run.

To test a real call, open the room link in a second browser or on your phone (use your machine's LAN IP, and note that `getUserMedia` requires **HTTPS or localhost** — from a phone you'll need a tunnel such as `ngrok`/`cloudflared`).

### Production

```bash
pnpm build   # typechecks everything, builds API bundle + SPA
NODE_ENV=production PORT=8080 node artifacts/api-server/dist/index.mjs
```

One process serves the SPA and the API. Rooms are written to **`./data/videocall.db`** (SQLite, WAL mode), so they persist across restarts.

### Deploying to a VPS

```bash
docker compose up -d --build      # app + ./data volume, nothing else needed
```

Or use the zero-touch loader in [`loader/`](loader/): it fetches a release, runs
and supervises it, and keeps your database — so shipping an update is just
**restart**.

On a small panel (the kind that force-stops a container for creating too many
files), set **`DEPLOY_MODE=prebuilt`**. The loader then downloads the published
release — 2 MB, ~230 files — instead of installing and building, which writes
~43,000 files and is what trips those limits. Nothing to install, no compiler,
about 130 MB of disk. Without it, `auto` builds from source.

```bash
node index.js --check     # what would change?
node index.js             # update if needed, then run
```

**Render:** click **New → Blueprint**, pick this repo, apply. `render.yaml` creates
the web service *and* a Postgres database and wires them together — see
[`docs/DEPLOY-RENDER.md`](docs/DEPLOY-RENDER.md).

Step-by-step for Docker, bare Node + systemd, and the loader — plus nginx + HTTPS
+ coturn: **[`docs/DEPLOY-VPS.md`](docs/DEPLOY-VPS.md)**.

## Storage

Three backends, one interface; the app picks one at boot.

| Backend | When it is used | Durable? | Needed for |
|---|---|---|---|
| **SQLite** (default) | always, unless told otherwise | ✅ file on disk | a single VPS — recommended |
| **Postgres** | when `DATABASE_URL` is set (or `STORE=postgres`) | ✅ | hosts with no persistent disk (Render, Railway, Fly) — **Render uses this**, or >1 instance |
| **memory** | `STORE=memory`, or if SQLite is unavailable at the default path | ❌ | tests |

**Presence** (who is currently in a room) is separate from rooms and lives in memory by default, or in **Redis** when `REDIS_URL` is set — that plus the Socket.IO Redis adapter is what lets you run several instances. A single VPS never needs it.

```bash
# SQLite (default)
SQLITE_PATH=./data/videocall.db

# Optional upgrade
DATABASE_URL=postgres://user:pass@host:5432/videocall    # rooms
REDIS_URL=redis://host:6379                              # presence + adapter
```

Both tables are created automatically on boot — there is no migration step.

```bash
# Back up everything that matters
sqlite3 data/videocall.db ".backup 'backup.db'"
```

## Configuration

All variables are optional locally — see [`.env.example`](.env.example) for the full list.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | *required in prod* | API server port (`8080`) |
| `UI_PORT` | `5173` | Vite dev/preview port |
| `BASE_PATH` | `/` | SPA base path (for sub-path hosting) |
| `CORS_ORIGINS` | reflect | Comma-separated allowlist for REST + Socket.IO |
| `TRUST_PROXY` | `1` | Set `0` when exposed directly |
| `RATE_LIMIT_PER_MINUTE` | `600` | General per-IP limit |
| `ROOM_CREATE_LIMIT_PER_MINUTE` | `30` | `POST /api/rooms` per IP |
| `STORE` | `auto` | `auto` \| `sqlite` \| `postgres` \| `memory` |
| `SQLITE_PATH` | `./data/videocall.db` | Room database file (default store) |
| `DATABASE_URL` | — | Use Postgres for rooms instead |
| `REDIS_URL` | — | Redis presence + Socket.IO adapter (multi-instance) |
| `MAX_ROOMS` | `20000` | Room cap before new rooms are refused |
| `ROOM_TTL_MS` | `7200000` | Idle-empty-room lifetime (2 h) |
| `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` | — | Your TURN relay. **Strongly recommended** — without it, calls fail on many mobile/carrier-grade-NAT networks. |

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/healthz` | Health + uptime + room count |
| `POST` | `/api/rooms` | Create a room → `201 { id, hostName, participantCount, createdAt }` |
| `GET` | `/api/rooms/:roomId` | Room info, live `participantCount` (404 if gone) |
| `DELETE` | `/api/rooms/:roomId` | Close a room |
| `GET` | `/api/ice` | STUN/TURN servers for the browser |

Socket.IO events (path `/socket.io`): `join-room`, `room-joined`, `user-connected`, `offer`, `answer`, `ice-candidate`, `media-state`, `user-disconnected`, `room-full`, `join-error`.

The contract lives in [`lib/api-spec/openapi.yaml`](lib/api-spec/openapi.yaml); typed React Query hooks and Zod schemas are generated from it with Orval:

```bash
pnpm --filter @workspace/api-spec run codegen
```

## Repository layout

```
artifacts/
  api-server/     Express 5 + Socket.IO signaling server, room store
  video-call/     React 19 + Vite SPA (home + call room)
  mockup-sandbox/ Replit design canvas (not part of the product)
lib/
  api-spec/       OpenAPI 3.1 contract + Orval config
  api-client-react/  Generated typed hooks (custom fetch mutator)
  api-zod/        Generated Zod schemas for request/response validation
  db/             Drizzle scaffolding (unused — stores live in artifacts/api-server/src/lib/store)
docs/             Architecture, limitations, VPS deployment guide
loader/           Pull-to-deploy loader for a VPS (see docs/DEPLOY-VPS.md)
scripts/          Workspace utilities
```

## Quality gates

```bash
pnpm typecheck   # tsc across every package
pnpm test        # API + signaling integration tests (node:test)
pnpm build       # typecheck + build everything
```

CI runs all three on every push — see [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Browser support

Chrome/Edge 90+, Firefox 90+, Safari 15+ (iOS included). Requires `getUserMedia`, which browsers only allow on HTTPS or `localhost`.

## License

MIT
