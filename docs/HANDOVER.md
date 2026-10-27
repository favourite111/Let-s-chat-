# VideoCall — what's deployed and what to watch

State as of 2026-10-27. Live at **https://let-s-chat-rvgk.onrender.com**

---

## The stack

| Piece | Where | Notes |
|---|---|---|
| App (SPA + API + signalling) | Render web service `videocall`, Docker runtime | One process serves everything |
| Rooms | Render Postgres `videocall-db` (free) | `STORE=postgres` forced; Render's disk is ephemeral |
| Relay | Metered Open Relay | `METERED_API_KEY`; 20 GB/month free |
| Source | `github.com/favourite111/Let-s-chat-`, branch `main` | Render auto-deploys on push |

Verify the deploy at any time:

```bash
curl -s https://let-s-chat-rvgk.onrender.com/api/healthz
# {"status":"ok","uptime":211,"store":"postgres","rooms":1}

curl -s https://let-s-chat-rvgk.onrender.com/api/ice
# STUN + four turn:global.relay.metered.ca entries with credentials
```

`"store":"postgres"` is the field to watch. If it ever reads `sqlite` or
`memory`, rooms are being written somewhere that will not survive a restart.

## What has been verified, not assumed

- **Persistence across a redeploy:** a room created before a deploy was still
  readable afterwards, same ID and timestamp.
- **Relay-only call:** a real two-browser call with `iceTransportPolicy:
  "relay"` (every direct path refused) connected both ways through
  `turn:global.relay.metered.ca`, 44.5 kB of video per peer, selected candidate
  pair `relay/relay`.
- **Adaptive quality:** forcing a 150 kbit/s link with 400 ms RTT took the
  sender from 1200 kbps/1× to 120 kbps/3× and switched to
  `maintain-framerate`; restoring the link climbed straight back. The call
  never dropped.
- **Opus tuning:** the negotiated SDP carries
  `maxaveragebitrate=32000;stereo=0;usedtx=1;useinbandfec=1`.
- **Codec preference:** H.264 is negotiated first (hardware encoding on phones).
- **API suite:** 91 tests, 90 pass, 1 skipped (the Postgres idempotency case
  needs a real `DATABASE_URL`).
- **Identity and host controls, end to end:** 31 checks in a real browser with
  a fake camera, against the production build — reload keeps the same seat,
  a third person is refused *recoverably* and gets in when a seat frees, the
  host ends the call for everyone, a removed participant cannot rejoin, a
  participant has no host controls, ownership survives a reload and a 3-second
  network blip, and video comes back after both. See "Identities and roles".

## Things that will expire

| What | When | What happens |
|---|---|---|
| **Free Postgres** | ~30 days after creation | Render deletes it. Emails you first. Create a new one, update `DATABASE_URL`. |
| **Free web service** | sleeps after ~15 min idle | First visit afterwards takes 30–50 s to wake. Not a bug. |
| **Metered 20 GB/month** | monthly cap | Past it, relayed calls stop connecting. Static credentials mean anyone can spend your allowance. |

## Known weaknesses

**The relay credential is shared with every visitor.** Metered's free tier
issues one static username/password, so `/api/ice` hands the same pair to
everyone. Fine for personal use; not fine for a public link. If that matters,
switch to Cloudflare Realtime TURN (1,000 GB/month free, short-lived
per-client credentials) — set `CLOUDFLARE_TURN_KEY_ID` and
`CLOUDFLARE_TURN_API_TOKEN`, and the app prefers them automatically. See
`docs/DEPLOY-TURN.md`.

**Single instance only.** Presence lives in process. Scaling out needs
`REDIS_URL`, which attaches the Socket.IO Redis adapter.

**Four people, and that is the ceiling.** A group call is a peer **mesh**: each
browser holds one connection per other person, so four people means three
connections each and three copies of your video going upstream. That is why the
capture drops to 640×480/20 fps once a third person joins. Beyond four, the
honest answer is a media server (SFU), not more peers — see `MAX_PARTICIPANTS`.

**Host powers are tied to one browser profile.** The host secret lives in that
browser's `localStorage`, keyed by room id. Clearing site data, using private
mode, or opening the room on another device means the room still belongs to the
original creator but nobody can prove it — the room stays open until it
expires (2 h idle) and cannot be closed early. That is the deliberate
consequence of never transferring ownership: there is no recovery path, by
design.

**Testing two people on one machine:** open the link in a *new tab or window*
(not "Duplicate tab"), or use a second browser / private window. Each window is
its own participant; the original host window keeps the Host badge and the
second one does not.

## Identities and roles

**One tab is one participant.** Each tab mints a **participant id** in
`sessionStorage`, so a reload or a reconnect in that tab reclaims the same seat,
while a second window is a genuinely different person. That id — not the socket
— is what presence is keyed by; counts keyed by socket, plus a stale socket
holding a seat for up to ~50 s, was the ghost-participant bug.

The id used to live in `localStorage`, which every window of a profile shares.
Pasting your own link into a second Chrome window then joined as *yourself*:
the same id, the same seat, one participant, and no call to connect to. If you
see "both windows show 1 person and neither connects", that is what happened —
check that each window reports a different id.

**Capacity counts connected participants only.** A dropped participant keeps
their seat (identity) for `PARTICIPANT_GRACE_MS` (45 s) but not a slot, so a
dead connection can never make the room look full. "Room full" is a recoverable
state in the UI: the client retries every 5 s and walks in as soon as a seat
frees.

**Ownership is fixed at creation and never transferred.** The creator stores a
secret in `localStorage` (`videocall:host-secret:<roomId>`); the server keeps
only its SHA-256. Host rights require *both* the owner's participant id and the
secret, verified server-side on every host action — the client drawing a button
is not authorization. Room closure is permanent; removed participant ids are
stored on the room, so a reconnect, reload or waiting out the grace period does
not let them back in.

Ownership survives the host disconnecting, reloading or reconnecting. There is
no host transfer, automatic or manual, under any circumstances: if the host
never returns, the room simply expires.

The host's participant id is remembered beside the secret in `localStorage`, so
**closing the host's window and reopening the link restores host ownership** —
but only while the host's seat is free. `GET /api/rooms/:id` reports
`hostConnected`, and a tab that holds the secret uses it to decide: host still
in the call → join as an ordinary second participant; host gone → reclaim the
host seat. That keeps "two windows of one browser" working without ever letting
a second window fight the real host for the seat.

A duplicated tab shares `sessionStorage` with its source, so both would present
the same id. The newer join wins the seat and the older tab is told
`session-replaced`, shows "Opened in another window" and releases the camera —
no silent collision. Opening the link in a new tab does not do this.

### Group calling (up to 4)

- **Mesh, not SFU.** `MAX_PARTICIPANTS` defaults to 4. Every participant holds a
  peer connection per other participant; the roster comes from the server and is
  the only source of truth for who is in the call.
- **Pre-join screen.** A link opens a name + camera check, not the call. The room
  is looked up *before* the camera is touched, so a closed or missing room is
  refused without asking for permissions.
- **Grid.** One person fills the screen; two stack on a phone and sit side by
  side on a desktop; three put your own tile full-width above two others on a
  phone; four use a 2×2 grid.
- **Uplink discipline.** Above two people everybody captures at 640×480/20 fps,
  and the per-peer adaptive quality loop still steps down further on a bad link.
- **Names** are required at the pre-join screen, remembered in `localStorage`,
  and sent with the join so every tile is labelled (host tiles carry a crown).

### The control model

One red **Leave** button, and everything destructive hangs off it or off the
host menu — nothing destructive sits next to a button people tap without
looking.

| Role | Taps Leave | Sees ⋮ |
|---|---|---|
| Guest | leaves immediately, exactly as before | no |
| Host | sheet: **Leave call** (room stays open) or **End for everyone** (red, closes the room) | yes |

The host's `⋮` menu holds the rare actions: **Copy invite link** and
**Remove <name>** (only while a guest is connected). Removal asks for a second
confirmation — it is permanent — and only then does the server disconnect them
and bar them.

The bar itself is three controls (mic, camera, Leave) for both roles, so it no
longer needs to wrap. Component: `src/components/action-sheet.tsx` (modal
dialog, Escape/backdrop to close, focus trapped and restored, 48 px+ rows).

### Socket protocol (server-enforced)

| Direction | Event | Notes |
|---|---|---|
| → server | `join-room {roomId, participantId, hostSecret?, displayName?}` | Re-emitted on every reconnect |
| ← client | `room-joined {self, participants, reclaimed, isHost}` | |
| ← client | `room-state {participants, count}` | Roster broadcast on every membership change; connected only |
| ← client | `join-error {reason}` / `room-full` / `room-closed` / `removed` / `session-replaced` | `room-full` is the only retryable one |
| ⇄ relay | `offer` / `answer` / `ice-candidate` with `to: participantId` | `from` is added server-side; cross-room relay is dropped |
| → server | `end-call`, `remove-participant {participantId}` | Host only; secret re-verified server-side, `host-action-error` otherwise |
| → server | `leave` | Explicit departure: frees the seat now instead of after the grace period |

REST: `DELETE /api/rooms/:id` now needs `x-participant-id` + `x-host-secret` and
**closes** the room (it no longer deletes the row, so joins can be refused
afterwards). It also notifies anyone still connected. `GET /api/rooms/:id`
returns `closed` and `hostConnected`.

## Deploying a change

Push to `main`. Render rebuilds and redeploys automatically.

The Dockerfile is load-bearing in two places, both commented in the file:

- `ENV CI=true` — without it `pnpm` aborts on a non-interactive `node_modules`
  purge (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`).
- `pnpm install --prod --frozen-lockfile`, **not** `pnpm prune --prod`. At a
  workspace root, prune empties `artifacts/api-server/node_modules` and the
  server then dies at boot with `Cannot find package 'better-sqlite3'`. There
  is a build-time assertion that catches this before it ships.

## Environment variables added in this phase

All optional; the defaults are what the deployment already runs with.

| Variable | Default | Effect |
|---|---|---|
| `PARTICIPANT_GRACE_MS` | `45000` | How long a disconnected participant keeps their seat |
| `SQLITE_PATH` | `./data/videocall.db` | Where the SQLite file lives (ignored when `STORE=postgres`) |
| `PG_POOL_SIZE` | driver default | Postgres pool size |
| `REDIS_CONNECT_TIMEOUT_MS` | `8000` | Fail fast instead of retrying a bad `REDIS_URL` forever |

No action is needed on Render: the existing service picks these up with the
defaults. The `rooms` table gains `host_participant_id`, `host_secret_hash`,
`closed_at` and `removed_participant_ids` at boot via `ADD COLUMN IF NOT
EXISTS`, so the live database migrates itself in place.

## Running it somewhere else

- **Docker/VPS:** `docker compose up -d`; SQLite on a volume. No Postgres or
  Redis needed.
- **A small panel that kills file-creation bursts:** use the prebuilt release,
  not a source build — `DEPLOY_MODE=prebuilt` in `loader/.env.example`. It
  downloads ~230 files instead of writing ~43,000. Releases are published as
  GitHub release assets by `scripts/build-release.mjs`.

## Secrets in use

Set in the Render dashboard, never in the repo:

- `METERED_API_KEY`
- `DATABASE_URL` (injected from the database)
- `CORS_ORIGINS`, `TURN_*` (optional)

Rotate `METERED_API_KEY` from the Metered dashboard if it ever leaks — it
was shared in chat, so it is worth regenerating and updating the one env var.
