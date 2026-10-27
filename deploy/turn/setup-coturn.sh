#!/usr/bin/env bash
#
# Install coturn and configure it for this app's time-limited credentials.
#
# Run this on the machine that will relay calls — a VPS with a public IPv4 and
# the ability to open UDP ports. It is NOT for a shared container panel; see
# docs/DEPLOY-TURN.md for why.
#
#   ssh root@your-server
#   TURN_SECRET="$(openssl rand -hex 32)" \
#   PUBLIC_IP="203.0.113.10" \
#   REALM="turn.example.com" \
#   bash setup-coturn.sh
#
# The script is idempotent: running it again updates the config and restarts.
set -euo pipefail

SECRET="${TURN_SECRET:-}"
PUBLIC_IP="${PUBLIC_IP:-}"
REALM="${REALM:-turn.local}"
MIN_PORT="${MIN_PORT:-49160}"
MAX_PORT="${MAX_PORT:-49200}"
# Optional: set these to also accept NATed setups (e.g. behind a cloud NAT).
PRIVATE_IP="${PRIVATE_IP:-}"

die() { echo "error: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo -i, then re-run)"
[ -n "$SECRET" ] || die "set TURN_SECRET (e.g. TURN_SECRET=\$(openssl rand -hex 32))"
[ -n "$PUBLIC_IP" ] || die "set PUBLIC_IP (the server's public IPv4 address)"
[ "${#SECRET}" -ge 16 ] || die "TURN_SECRET must be at least 16 characters"

echo "==> installing coturn"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends coturn openssl >/dev/null

# Debian/Ubuntu ship coturn disabled. Turn it on.
echo "==> enabling the service"
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn

echo "==> writing /etc/turnserver.conf"
EXTERNAL_LINE="external-ip=${PUBLIC_IP}"
if [ -n "$PRIVATE_IP" ] && [ "$PRIVATE_IP" != "$PUBLIC_IP" ]; then
  EXTERNAL_LINE="external-ip=${PUBLIC_IP}/${PRIVATE_IP}"
fi

cat > /etc/turnserver.conf <<CONF
# Managed by setup-coturn.sh — safe to regenerate.

listening-port=3478
# TLS listener. Enable only after pointing a certificate at this host.
#tls-listening-port=5349

${EXTERNAL_LINE}

# A deliberately small relay range: easier to firewall, and plenty for a
# handful of concurrent calls. Each call needs roughly two ports.
min-port=${MIN_PORT}
max-port=${MAX_PORT}

fingerprint

# Time-limited credentials (the "TURN REST API" scheme).
#   username   = <unix-expiry>:<label>
#   credential = base64(HMAC-SHA1(static-auth-secret, username))
# The app mints these in artifacts/api-server/src/lib/turn.ts.
use-auth-secret
static-auth-secret=${SECRET}
realm=${REALM}

# Refuse to relay to private address space — without this a TURN server can be
# used to probe the host's internal network.
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
# ...allowing loopback only when explicitly testing locally.
#allow-loopback-peers

no-cli
log-file=/var/log/turnserver.log
simple-log
CONF
chmod 600 /etc/turnserver.conf

echo "==> opening the firewall"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 3478/udp  >/dev/null || true
  ufw allow 3478/tcp  >/dev/null || true
  ufw allow 5349/tcp  >/dev/null || true
  ufw allow "${MIN_PORT}:${MAX_PORT}/udp" >/dev/null || true
  echo "    ufw rules added"
else
  echo "    ufw not active — make sure your provider's firewall allows:"
  echo "      3478/udp, 3478/tcp, ${MIN_PORT}-${MAX_PORT}/udp"
fi

echo "==> restarting coturn"
systemctl enable coturn >/dev/null 2>&1 || true
systemctl restart coturn
sleep 1
systemctl is-active --quiet coturn || { journalctl -u coturn -n 20 --no-pager; die "coturn failed to start"; }
ss -lun | grep -q 3478 || die "coturn is not listening on 3478/udp"

cat <<DONE

coturn is running.

Set these on the app service (Render → Environment, or .env on a VPS):

  TURN_URLS=turn:${PUBLIC_IP}:3478?transport=udp
  TURN_SECRET=${SECRET}

  # once you have a certificate and DNS name, serve TLS too (port 5349):
  # TURN_URLS=turn:${PUBLIC_IP}:3478?transport=udp,turns:${REALM}:5349

  # optional: how long a minted credential stays valid (default 3600)
  # TURN_TTL_SECONDS=3600

Verify from this machine with: bash verify-turn.sh
Verify through the app with: curl https://your-app/api/ice
DONE
