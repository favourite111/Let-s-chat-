# Deploying on Render

Two clicks, one blueprint. `render.yaml` in the repo root describes everything:
the web service **and** the Postgres database, wired together.

## 1. Create the service

1. Push this repo to GitHub (already done).
2. Render dashboard → **New** → **Blueprint**.
3. Pick the repository. Render reads `render.yaml` and shows:
   * `videocall` — Web Service (Node)
   * `videocall-db` — PostgreSQL (free)
4. **Apply**. Render provisions the database first, injects `DATABASE_URL`
   into the service, installs with pnpm, builds, and starts.

First deploy takes ~3–5 minutes. When it's live, open the `.onrender.com` URL.

## What the blueprint sets

| Setting | Value | Why |
|---|---|---|
| `STORE` | `postgres` | Render's disk is wiped on every deploy. Forcing Postgres means the server **refuses to boot** if the database is unreachable, instead of silently writing rooms to a file that will disappear. |
| `DATABASE_URL` | from `videocall-db` | Injected automatically; the `rooms` table is created on first boot — no migrations. |
| build | `pnpm install --frozen-lockfile` + build both packages | `PORT`/`BASE_PATH` are provided so the Vite config doesn't throw. |
| start | `node artifacts/api-server/dist/index.mjs` | One process serves the API **and** the built frontend. |
| health check | `/api/healthz` | Render restarts the service if it stops answering. |
| `TRUST_PROXY` | `1` | Render terminates TLS in front of the app. |

## 2. Set these in the dashboard (Environment)

| Variable | Value | Notes |
|---|---|---|
| `CORS_ORIGINS` | `https://your-service.onrender.com` | Same-origin, so not strictly required — but set it. |
| `TURN_URLS` | `turn:your-turn-host:3478?transport=udp,turn:your-turn-host:3478?transport=tcp` | **Strongly recommended.** |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | your coturn credentials | Needed for calls on mobile data / carrier-grade NAT. |

Without TURN, two people on ordinary home Wi-Fi usually connect fine; two people
on mobile data often don't — that's the network, not the app.

## 3. Deploying updates

Render auto-deploys on every push to `main`:

```bash
git push origin main      # Render rebuilds and swaps the new version in
```

Zero-downtime, because Render only routes traffic once `/api/healthz` answers.
Rooms live in Postgres, so they survive deploys and restarts.

## Free-tier realities (read this once)

* **The web service sleeps** after ~15 minutes of inactivity. The next request
  takes 30–60 s to wake it. Fine for testing, annoying for real calls.
* **The free Postgres expires** (Render deletes it ~30 days after creation on
  the free plan). Rooms are short-lived invite codes, so the practical loss is
  "existing links stop working" — but you'll need to recreate the database and
  redeploy to keep the app running. Upgrade to a paid database if this matters.
* **WebSockets are supported** on Render web services, so signalling works out
  of the box (no extra config needed for Socket.IO).

## Troubleshooting

**"Application failed to respond" right after deploy** — check the logs. The
most common cause is the database still being provisioned; Render restarts the
service automatically once it connects.

**`STORE=postgres requires DATABASE_URL`** — the database wasn't attached to the
service. Dashboard → your service → Environment → confirm `DATABASE_URL` exists
(or just apply the blueprint again).

**`Cannot open the SQLite database`** — you overrode `STORE` to `sqlite` on
Render. Don't: that storage does not survive a deploy.

**Calls connect but there's no video on mobile data** — set `TURN_*`. See above.

**Build fails on `better-sqlite3`** — it's only used in SQLite mode, but it is
still installed. Render's build image has the toolchain, so this normally just
works; if it ever doesn't, set `PNPM_CONFIG_IGNORE_SCRIPTS=true` (Postgres mode
doesn't need the native binary).

## Verifying a deploy

```bash
curl -s https://your-service.onrender.com/api/healthz
# {"status":"ok","uptime":12,"rooms":0}

curl -s -X POST https://your-service.onrender.com/api/rooms \
  -H 'content-type: application/json' -d '{"hostName":"Ada"}'
# {"id":"...12 chars...","hostName":"Ada","participantCount":0,"createdAt":"..."}
```

Open the room link on two devices to confirm media flows.
