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
- **API suite:** 46 tests, 45 pass, 1 skipped (the Postgres idempotency case
  needs a real `DATABASE_URL`).

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

**1-on-1 only.** The room model caps at two participants. Group calls are a
design change, not a config change.

## Deploying a change

Push to `main`. Render rebuilds and redeploys automatically.

The Dockerfile is load-bearing in two places, both commented in the file:

- `ENV CI=true` — without it `pnpm` aborts on a non-interactive `node_modules`
  purge (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`).
- `pnpm install --prod --frozen-lockfile`, **not** `pnpm prune --prod`. At a
  workspace root, prune empties `artifacts/api-server/node_modules` and the
  server then dies at boot with `Cannot find package 'better-sqlite3'`. There
  is a build-time assertion that catches this before it ships.

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
