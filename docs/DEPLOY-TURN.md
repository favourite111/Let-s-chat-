# Making calls connect reliably: TURN

STUN tells each caller its own public address. It does **not** carry media.
When two people are both behind carrier-grade NAT — the normal situation on
mobile data — neither can reach the other directly, and the call never
connects. Nothing in the app can fix that from the browser side. Only a relay
can, and that relay is TURN.

You need TURN if any of these are true:

- callers are on mobile data (especially on Nigerian networks)
- callers are on different networks
- one side is behind restrictive wifi, a corporate firewall, or CGNAT

Without it, calls work only when at least one side has a directly reachable
address. That is a coin flip, not a product.

## Where a relay can run

| Option | Works? | Notes |
|---|---|---|
| **A VPS with a public IPv4** | ✅ recommended | Full control, ~$4/month, setup below |
| A hosted TURN provider | ✅ | Twilio, Metered, Cloudflare Calls. No server, but per-GB billing |
| **A shared container panel** | ❌ usually not | See below — this is the trap |

A shared panel (Pterodactyl/Katabump-style) gives you one allocated port, not a
range of UDP ports, and the container's public address is usually NAT'd. coturn
needs:

- **inbound UDP on 3478** (and TCP 3478, TLS 5349 if enabled)
- **a range of inbound UDP ports** for the relay itself (this deployment uses
  49160–49200)
- a **public IP it can advertise**, or `external-ip=PUBLIC/PRIVATE` if NAT'd

Most panels expose exactly one port and no port ranges, so coturn cannot work
there. If you only have a panel, use a hosted provider instead — the app
supports both (see *Hosted providers* below), no server required.

## Setup on a VPS

On a fresh Ubuntu/Debian box:

```bash
scp deploy/turn/setup-coturn.sh root@your-server:/root/
ssh root@your-server

TURN_SECRET="$(openssl rand -hex 32)" \
PUBLIC_IP="203.0.113.10" \
REALM="turn.example.com" \
bash setup-coturn.sh
```

The script installs coturn, writes `/etc/turnserver.conf`, opens the firewall,
starts the service, and prints the two environment variables to set on the app.
It is idempotent — re-running updates the config.

Make sure your provider's firewall (the cloud one, not just `ufw`) allows:

```
3478/udp   3478/tcp   49160-49200/udp
```

If the box sits behind NAT, pass `PRIVATE_IP=<private address>` as well so
coturn advertises the public address while binding the private one.

## Point the app at it

On Render: **your service → Environment → Add Environment Variable**

| Key | Value |
|---|---|
| `TURN_URLS` | `turn:203.0.113.10:3478?transport=udp` |
| `TURN_SECRET` | the secret printed by the setup script |

Save; the service redeploys. `TURN_TTL_SECONDS` is optional (default 3600).

## Verify

Three levels, cheapest first.

**1. Is the app serving a relay config?**

```bash
curl -s https://your-app.onrender.com/api/ice | python3 -m json.tool
```

Two entries should appear — STUN and TURN. The TURN entry's `username` looks
like `1793094582:videocall` (a Unix expiry, then a label) and `credential` is a
base64 string. Request it twice: **both fields must differ**, because each
response is freshly minted and expires.

**2. Does the relay itself work?** On the VPS:

```bash
bash verify-turn.sh
```

It mints a credential the same way the app does and drives a real allocation
through coturn. Expect three PASS lines: valid relays, expired refused, forged
refused.

**3. Does a call actually relay?** Open the room in two browsers and check how
they connected: in DevTools → `chrome://webrtc-internals`, the selected
candidate pair shows `(relay)` on both sides when TURN is carrying the call.

## Free hosted relays (no server of your own)

If you cannot run a VPS, use a hosted relay. The app supports three
configurations; pick one.

### Option 1 — Cloudflare Realtime TURN (recommended: 1 TB/month free)

The most generous free tier by a wide margin: **1,000 GB per month**, then
$0.05/GB. Anycast across 330+ cities, so it is close to your users rather than
in one region. No credit card.

1. Create a free Cloudflare account → dashboard → **Realtime** → **TURN keys**
   → create a TURN key. Note the **TURN Token ID** and its **API token**.
2. Set both on your service:

| Key | Value |
|---|---|
| `CLOUDFLARE_TURN_KEY_ID` | the TURN key ID |
| `CLOUDFLARE_TURN_API_TOKEN` | the API token for that key |

Optional: `CLOUDFLARE_TURN_TTL_SECONDS` (default 3600, capped at 48 h).

The key never reaches the browser. The server calls Cloudflare's
`generate-ice-servers` endpoint and hands the client a short-lived credential,
cached until five minutes before it expires so ordinary page loads do not burn
API calls. If Cloudflare is unreachable the endpoint degrades to STUN and logs
it — a relay outage never takes calls down for people who can connect directly.

### Option 2 — Metered Open Relay (20 GB/month free)

Also free, also no server, but a fifth of Cloudflare's allowance. Sign up at
[metered.ca/tools/openrelay](https://www.metered.ca/tools/openrelay/) and copy
the `iceServers` block from the dashboard. It issues a fixed username and
password, so set:

```
TURN_URLS=turn:standard.relay.metered.ca:80,turn:standard.relay.metered.ca:443,turn:standard.relay.metered.ca:443?transport=tcp
TURN_USERNAME=<from the dashboard>
TURN_CREDENTIAL=<from the dashboard>
```

**Do not use the `openrelayproject` / `openrelayproject` credentials** that
appear in almost every WebRTC tutorial. Metered retired that public pair;
`openrelay.metered.ca` now resolves to `100::1`, the IPv6 discard-only prefix
(RFC 6666), so the name is deliberately pointed at a blackhole. Calls using it
never allocate a relay and silently fail to connect. Sign up for a real
per-account key instead.

### Option 3 — your own coturn

Cheapest at volume and fully under your control, but needs a VPS with a public
IP and a range of open UDP ports. See the top of this document.

### Which to choose

| | Free allowance | Setup | Notes |
|---|---|---|---|
| Cloudflare | **1,000 GB/mo** | Cloudflare account + TURN key | Best free tier; anycast |
| Metered Open Relay | 20 GB/mo | account, static credentials | Fixed password shared with every client |
| Own coturn | unlimited (pay the VPS) | ~15 minutes, needs public UDP | Full control, ~$4/mo |

At the adaptive controller's typical 0.5–1.2 Mbit/s per direction, 1,000 GB is
roughly 1,000–2,000 hours of relayed call per month. For personal use you will
not come close.

---

The app mints time-limited credentials when a secret is present, uses
Cloudflare's API when that is configured, and falls back to static credentials
otherwise. **Prefer a secret or Cloudflare over a static password** — with
static credentials, anyone who loads the page receives your relay password and
can push traffic through your account.

## Why time-limited credentials

Every visitor used to receive the same username and password, which meant
anyone could `curl /api/ice`, take the credential, and relay their own traffic
on your bandwidth. Now:

```
username   = "<unix-expiry>:<label>"
credential = base64(HMAC-SHA1(shared_secret, username))
```

The server stores only the secret; it recomputes the HMAC and checks the
expiry, rejecting anything stale. A leaked credential is worthless within the
hour and there is nothing to rotate. This is coturn's native
`use-auth-secret` mode (the "TURN REST API" scheme), implemented in
`artifacts/api-server/src/lib/turn.ts`.

## Capacity

Each active call relays roughly **two ports** and whatever bitrate the call is
using — with the adaptive controller, typically 0.5–1.2 Mbit/s per direction.
The 41-port range in the default config handles a handful of simultaneous calls
comfortably. Widen `MIN_PORT`/`MAX_PORT` if you need more, and open the same
range in the firewall.

Watch bandwidth: a relay carries **both** directions for **both**
participants. An hour of good-quality call is roughly 0.5–1 GB through the
relay, so check your provider's monthly allowance before a busy week.

## TLS (optional, usually unnecessary)

WebRTC media is already encrypted end to end (DTLS-SRTP). `turns:` on 5349
matters only when a network blocks plain UDP entirely and forces TCP/TLS.

To enable it, point a DNS name at the server, get a certificate, and uncomment
`tls-listening-port=5349` plus the `cert=`/`pkey=` lines in
`/etc/turnserver.conf`. Then extend the URL:

```
TURN_URLS=turn:203.0.113.10:3478?transport=udp,turns:turn.example.com:5349
```

## Troubleshooting

**Calls still fail on mobile data** — confirm `/api/ice` returns a TURN entry
*and* that the relay is reachable from outside: from another machine, run
`turnutils_uclient -u <user> -w <cred> -p 3478 <public-ip>`. If that times out,
the ports are closed at the provider firewall.

**`401 Unauthorized` on `/api/ice` credentials** — `TURN_SECRET` on the app
does not match `static-auth-secret` in `/etc/turnserver.conf`. They must be
identical.

**`/api/ice` shows only STUN** — nothing is configured: `TURN_URLS` is unset or
incomplete (no `TURN_SECRET`/`TURN_USERNAME`), and neither
`CLOUDFLARE_TURN_KEY_ID` nor `CLOUDFLARE_TURN_API_TOKEN` is set. The app
deliberately ignores a half-configured relay rather than handing clients a
server that would reject them.

**`Cloudflare TURN credentials unavailable` in the logs** — the API rejected the
key or token, or Cloudflare was unreachable. `/api/ice` falls back to STUN, so
calls still work for directly reachable peers. Check the key ID and that the
API token belongs to that TURN key.

**Everything connects but the call is slow** — the relay is working but the
link is weak; the adaptive controller will step the video down. Check
`/var/log/turnserver.log` for allocation errors if quality is unexpectedly bad.
