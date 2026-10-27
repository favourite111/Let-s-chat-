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

## Hosted providers

If you use a provider that issues a fixed username and password instead of a
shared secret, set these instead of `TURN_SECRET`:

```
TURN_URLS=turn:relay.provider.com:3478
TURN_USERNAME=<issued username>
TURN_CREDENTIAL=<issued password>
```

The app mints time-limited credentials when a secret is present and falls back
to static ones otherwise. **Prefer the secret form** — with static credentials,
anyone who loads the page gets your relay password and can push traffic through
your account.

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

**`/api/ice` shows only STUN** — `TURN_URLS` is unset, empty, or set without
`TURN_SECRET`/`TURN_USERNAME`. The app deliberately ignores a half-configured
relay rather than handing clients a server that would reject them.

**Everything connects but the call is slow** — the relay is working but the
link is weak; the adaptive controller will step the video down. Check
`/var/log/turnserver.log` for allocation errors if quality is unexpectedly bad.
