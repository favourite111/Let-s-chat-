# Deploying on a VPS (no Postgres required)

Rooms are stored in **SQLite** — a file on disk. On a normal VPS that disk is persistent, so your app keeps its rooms across restarts and deploys with **zero extra services**. Postgres and Redis are optional upgrades, not prerequisites.

The only thing a VPS cannot give you is a TURN relay for awkward mobile networks — see [TURN](#4-turn-for-mobile-networks) below.

---

## Option A — Docker (recommended)

```bash
git clone https://github.com/favourite111/Let-s-chat-.git
cd Let-s-chat-
docker compose up -d --build
```

That starts the app on port 8080 with `./data/videocall.db` bind-mounted into the container, so rooms survive `docker compose down/up`, image rebuilds and reboots.

```bash
docker compose logs -f          # follow logs
docker compose down             # stop (data stays in ./data)
```

Check it:

```bash
curl -s localhost:8080/api/healthz     # {"status":"ok",...,"rooms":0}
```

### Optional: switch to Postgres and/or Redis later

```bash
docker compose --profile postgres --profile redis up -d
```

Then in `docker-compose.yml` under the `app` service, set:

```yaml
DATABASE_URL: postgres://videocall:videocall@postgres:5432/videocall
REDIS_URL: redis://redis:6379
```

and `docker compose up -d` again. The app picks Postgres up automatically on boot and creates its table; existing SQLite data is **not** migrated (rooms are short-lived invite codes — creating them again takes a second).

---

## Option B — bare Node + systemd

Tested on Debian/Ubuntu with Node 22.

```bash
# 1. Node 22 + pnpm
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential python3
sudo corepack enable && sudo corepack prepare pnpm@10 --activate

# 2. Code
sudo mkdir -p /srv/videocall && sudo chown "$USER" /srv/videocall
git clone https://github.com/favourite111/Let-s-chat-.git /srv/videocall
cd /srv/videocall

# 3. Install + build
pnpm install --frozen-lockfile
pnpm build

# 4. Data directory (this is your database)
mkdir -p data

# 5. Environment
cp .env.example .env      # edit CORS_ORIGINS, TURN_* if you have them
```

`/etc/systemd/system/videocall.service`:

```ini
[Unit]
Description=VideoCall
After=network.target

[Service]
Type=simple
User=videocall
WorkingDirectory=/srv/videocall
Environment=NODE_ENV=production
Environment=PORT=8080
Environment=SQLITE_PATH=/srv/videocall/data/videocall.db
Environment=TRUST_PROXY=1
# Environment=CORS_ORIGINS=https://call.example.com
# Environment=TURN_URLS=turn:turn.example.com:3478
# Environment=TURN_USERNAME=...
# Environment=TURN_CREDENTIAL=...
ExecStart=/usr/bin/node --enable-source-maps /srv/videocall/artifacts/api-server/dist/index.mjs
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -s /usr/sbin/nologin videocall
sudo chown -R videocall:videocall /srv/videocall
sudo systemctl daemon-reload
sudo systemctl enable --now videocall
systemctl status videocall
journalctl -u videocall -f
```

## Option C — the loader (update with a restart click)

If you would rather never touch git on the VPS again, use `loader/` from this
repo. It fetches the project, runs it and supervises it. Updating = restarting
the loader.

**On a small panel, use `DEPLOY_MODE=prebuilt`.** In that mode the loader
downloads a published release (2 MB, ~230 files) instead of building: it
creates ~230 files instead of ~43,000, needs no pnpm, no C toolchain and about
130 MB of disk instead of ~1 GB.

That matters because budget panel hosts force-stop containers that create too
many files too quickly — the failure looks like a crash, not like a build
problem. A source build there is what triggers it.

* `DEPLOY_MODE=prebuilt` — the published release. **Use this on panels.**
* `DEPLOY_MODE=source` — clone and build on the box (needs the disk and CPU).
* `DEPLOY_MODE=auto` — default: prebuilt if a release exists, else source.

Releases are produced by `scripts/build-release.mjs` (see *Publishing a
release* below) and published as GitHub release assets, so `prebuilt` works out
of the box for `v1.0.0`.

```
/srv/videocall/
├── index.js            ← the loader (copy from loader/)
├── package.json
├── .env                ← your config (PORT, TURN_*, CORS_ORIGINS…)
├── data/               ← YOUR DATABASE — never touched by a deploy
│   └── videocall.db
├── app/                ← the built project (replaced on every update)
└── .cache/             ← download, staging, previous release, logs
```

### Install once

```bash
sudo mkdir -p /srv/videocall && cd /srv/videocall
# grab the loader straight from the repo
curl -fsSL https://raw.githubusercontent.com/favourite111/Let-s-chat-/main/loader/index.js -o index.js
curl -fsSL https://raw.githubusercontent.com/favourite111/Let-s-chat-/main/loader/package.json -o package.json
curl -fsSL https://raw.githubusercontent.com/favourite111/Let-s-chat-/main/loader/.env.example -o .env.example

npm install            # adm-zip + chalk, nothing else
cp .env.example .env   # edit PORT / TURN / CORS_ORIGINS
# on a small panel, add: DEPLOY_MODE=prebuilt
node index.js          # first run fetches a release (or builds), and starts
```

### Deploy an update

```bash
systemctl restart videocall     # or: your panel's Restart button
```

On every start the loader asks GitHub for the latest commit on `main`:

* **same commit** → nothing is downloaded or rebuilt, the app starts in ~1s
* **new commit** → download → install → build into `.cache/staging` → atomic swap

```bash
# without dropping the supervisor:
kill -HUP $(cat .cache/loader.pid)

# check what would happen, change nothing:
node index.js --check

# update in the background (e.g. cron), without starting the app:
node index.js --update

# go back to the previous release:
node index.js --rollback
```

### Why your data is safe

| What | Where | Survives an update? |
|---|---|---|
| SQLite database | `./data/videocall.db` (outside `app/`) | ✅ always |
| `.env` in the app folder | preserved and restored | ✅ |
| `data/` inside the app folder | preserved and restored | ✅ |
| Code, `node_modules`, `dist` | `app/` | replaced (that's the point) |

### Safety rails

* **Atomic swap** — the new release is built in `.cache/staging` and only moved
  into `app/` after a successful build. A broken build leaves the running
  version untouched.
* **Auto-rollback** — if a new release crashes `MAX_RESTARTS` times within
  `RESTART_WINDOW_MS`, the loader swaps back to `.cache/app.prev` and starts it.
* **Single instance** — a pid file stops two loaders fighting over the port.
* **Crash supervision** — restarts the app with backoff, gives up loudly after
  a crash loop instead of spinning forever.
* **Graceful shutdown** — `SIGTERM` is forwarded, so in-flight WebRTC calls and
  the SQLite write-ahead log close cleanly.
* **Logs** — `.cache/logs/loader.log` and `.cache/logs/app.log` (rotated at 5 MB).

`KEEP_PREVIOUS=0` deletes the old release after a successful update if disk is
tight (it costs ~400 MB because of `node_modules`).

### systemd unit

```ini
[Unit]
Description=VideoCall (loader)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=videocall
WorkingDirectory=/srv/videocall
ExecStart=/usr/bin/node /srv/videocall/index.js
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20
# the loader writes here, so make sure the user can
# Environment=SQLITE_PATH=/srv/videocall/data/videocall.db

[Install]
WantedBy=multi-user.target
```

---

## Nginx + HTTPS (required for camera access)

Browsers only allow `getUserMedia` on **HTTPS** (or localhost). Plain HTTP on an IP address will show a permission error.

```nginx
server {
    listen 80;
    server_name call.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name call.example.com;

    ssl_certificate     /etc/letsencrypt/live/call.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/call.example.com/privkey.pem;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Socket.IO needs WebSocket upgrade + long timeouts
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d call.example.com
```

Then set `CORS_ORIGINS=https://call.example.com` and restart the service.

## TURN for mobile networks

STUN alone fails on carrier-grade NAT (a lot of mobile data in Nigeria, and most hotel/office Wi-Fi). That is the one gap a VPS cannot close by itself — you need a relay on a public IP:

```bash
sudo apt-get install -y coturn
sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

`/etc/turnserver.conf`:

```conf
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
realm=call.example.com
user=videocall:CHANGE_ME
min-port=49152
max-port=65535
no-multicast-peers
```

```bash
sudo systemctl enable --now coturn
sudo ufw allow 3478/tcp && sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp && sudo ufw allow 49152:65535/udp
```

Point the app at it (the client fetches this from `/api/ice`, so no rebuild is needed):

```bash
TURN_URLS=turn:call.example.com:3478?transport=udp,turn:call.example.com:3478?transport=tcp
TURN_USERNAME=videocall
TURN_CREDENTIAL=CHANGE_ME
```

Verify: `curl -s https://call.example.com/api/ice` should list your turn URLs.

## Backups

Everything durable is one file:

```bash
# Safe hot backup (WAL mode)
sqlite3 /srv/videocall/data/videocall.db ".backup '/var/backups/videocall-$(date +%F).db'"

# cron, nightly at 03:15
15 3 * * * sqlite3 /srv/videocall/data/videocall.db ".backup '/var/backups/videocall-$(date +\%F).db'"
```

Rooms expire after 2 hours of inactivity by default (`ROOM_TTL_MS`), so the file stays tiny. Loss of it costs nothing more than in-flight invite links.

## Updating

```bash
cd /srv/videocall
git pull
pnpm install --frozen-lockfile
pnpm build
sudo systemctl restart videocall      # SIGTERM is handled gracefully
```

Docker: `git pull && docker compose up -d --build`.

## Smoke test

```bash
curl -s https://call.example.com/api/healthz
curl -s -X POST https://call.example.com/api/rooms -H 'content-type: application/json' -d '{"hostName":"Ada"}'
```

Open the returned room link on two devices. If they connect on the same Wi-Fi but not on mobile data, that is TURN (step 4) — not the app.

## Scaling note

SQLite + in-memory presence = **one instance**. That is plenty: a single Node process happily handles hundreds of concurrent 1-on-1 calls because media never touches the server.

Go multi-instance only if you outgrow it, and then switch both stores at once:

```bash
DATABASE_URL=postgres://...     # rooms
REDIS_URL=redis://...           # presence + Socket.IO adapter
```

plus sticky sessions in nginx (`ip_hash`). Full details in [ARCHITECTURE.md](ARCHITECTURE.md).
