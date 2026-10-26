# Architecture & known limitations

## Request / media flow

1. `POST /api/rooms` creates a room in the in-memory store and returns a 12-character code (60 bits of entropy, unambiguous base32).
2. The browser opens `/room/:roomId`, fetches `/api/ice` for STUN/TURN config, then requests camera + microphone.
3. The browser connects to Socket.IO and emits `join-room`. The server accepts **only if the room exists** and has fewer than 2 participants.
4. The peer already in the room receives `user-connected` and creates the SDP offer; the newcomer answers. Keeping a single deterministic offerer avoids glare for two peers.
5. ICE candidates are buffered client-side until the remote description is set, then flushed.
6. Mute and camera-off are implemented with `track.enabled` (no renegotiation) and mirrored to the peer via `media-state`.
7. On `disconnect` the client shows "Reconnecting…"; Socket.IO's automatic reconnect fires `connect` again, which re-emits `join-room` and rebuilds the peer connection. `iceconnectionstatechange` triggers `restartIce()` on failure.

## Server modules

| File | Responsibility |
|---|---|
| `src/lib/rooms.ts` | Room service: creation, join/leave, live participant counts, TTL sweep, capacity cap |
| `src/lib/store/*` | Pluggable persistence: `sqlite` (default), `postgres`, `memory`; presence in memory or Redis |
| `src/lib/signaling.ts` | Validated Socket.IO relay; enforces room membership and per-socket rate limits |
| `src/routes/rooms.ts` | REST endpoints, Zod validation from the OpenAPI contract |
| `src/routes/ice.ts` | TURN/STUN config from environment |
| `src/app.ts` | Helmet CSP, CORS policy, compression, rate limits, JSON 404s, SPA fallback |
| `src/index.ts` | Socket.IO wiring, crash guards, graceful shutdown |

Every inbound socket payload is validated before use and each handler is wrapped, so a malformed message can no longer take the process down (`test/smoke.test.mjs` covers this).

## Storage model

Two kinds of state, deliberately separated:

| State | Nature | Default | Upgrade |
|---|---|---|---|
| **Rooms** (`id`, host, timestamps) | durable — must survive a restart | SQLite file (`SQLITE_PATH`) with WAL | Postgres via `DATABASE_URL` |
| **Presence** (socket ids in a room) | ephemeral — meaningless after a restart | in-process memory | Redis via `REDIS_URL` |

`STORE=auto` (default) picks Postgres when `DATABASE_URL` is present, SQLite otherwise. Because the durable part is a single small table, SQLite is genuinely sufficient for a VPS: no daemon to run, no backup tooling beyond copying one file. `lib/store/index.ts` resolves the backend and logs which one won.

An **explicitly configured** `SQLITE_PATH` that cannot be opened is a hard startup error — better than booting into a silent in-memory fallback and losing rooms on the next restart. Only the *default* path may fall back (so `pnpm dev` works anywhere).

## Deliberate limitations

**Single instance by default.** With SQLite + memory presence, two processes would see different presence and could not relay between them. `render.yaml` pins `numInstances: 1`, and `docker-compose.yml` runs one container. To scale:

- set `DATABASE_URL` (rooms) **and** `REDIS_URL` (presence),
- the Socket.IO Redis adapter is attached automatically when `REDIS_URL` is set,
- add sticky sessions (`ip_hash` in nginx) so a room's sockets land on one replica,
- issue short-lived TURN credentials per session instead of static ones.

**Restarts drop live calls, not rooms.** Room records persist; the WebRTC sessions they describe do not, which is correct — peers reconnect and re-join the same room id.

**Not verified end-to-end encryption.** WebRTC always encrypts media in transit (DTLS-SRTP), so the UI says *"Encrypted in transit"*, not "end-to-end". True E2EE with tamper-evident signalling requires identity keys exchanged out-of-band and fingerprint comparison — those are unauthenticated right now, so a compromised signalling server could MITM a call.

**Two participants only.** Supporting 3+ peers needs an SFU (mediasoup, LiveKit, Janus) rather than mesh peer connections.

**No TURN by default.** The client falls back to public STUN. On carrier-grade NAT / symmetric NAT — common on mobile networks — a call will fail to connect without your own TURN relay configured through `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`.

**`artifacts/mockup-sandbox`** is leftover Replit design-canvas tooling. It is not part of the product and can be deleted along with the unused shadcn components in `artifacts/video-call/src/components/ui` (only `button`, `card`, `input`, `tooltip`, `toast`, `toaster` and `sonner` are imported).

## Roadmap

- [ ] Persist rooms in Postgres; Redis adapter for multi-instance
- [ ] Coturn deployment with time-limited credentials
- [ ] In-call chat over `RTCDataChannel`
- [ ] Screen sharing (renegotiation via the perfect-negotiation pattern)
- [ ] Group calls (SFU)
- [ ] Room password / waiting room / lock
- [ ] Recording (`MediaRecorder`)
- [ ] Playwright smoke test with fake media devices
- [ ] E2EE with verifiable identity
- [ ] Delete the unused UI kit and the mockup sandbox
