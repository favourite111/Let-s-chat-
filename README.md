# VideoCall

Free, no-signup **1-on-1 video calls in the browser**. Create a room, share the link, talk face-to-face. No accounts, no downloads, no plugins.

> **Status:** working prototype, hardened for single-instance deployment. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the known limitations (group calls, horizontal scaling, verified E2EE) before relying on it for anything sensitive.

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

One process serves the SPA and the API. `render.yaml` is a working blueprint; any Node host works.

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
| `MAX_ROOMS` | `10000` | In-memory room cap |
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
  db/             Drizzle/Postgres scaffolding (currently unused)
docs/             Architecture + limitations
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
