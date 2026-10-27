#!/usr/bin/env bash
#
# Prove the local coturn relay actually works, end to end.
#
# Mints a credential exactly the way the app does (HMAC-SHA1 of
# "<expiry>:<label>" with the shared secret), then drives a real TURN
# allocation and data relay through it with turnutils_uclient.
#
#   bash verify-turn.sh
#
# Exits non-zero if the relay is broken, so it can be wired into a health check.
set -uo pipefail

CONF="${TURN_CONF:-/etc/turnserver.conf}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3478}"

[ -r "$CONF" ] || { echo "cannot read $CONF — is coturn installed here?" >&2; exit 2; }

SECRET=$(grep -E '^static-auth-secret=' "$CONF" | head -1 | cut -d= -f2-)
[ -n "$SECRET" ] || { echo "no static-auth-secret in $CONF (use-auth-secret not configured?)" >&2; exit 2; }

command -v turnutils_uclient >/dev/null || { echo "turnutils_uclient not installed (apt install coturn)" >&2; exit 2; }

mint() {
  # $1 = label, $2 = seconds of validity (may be negative)
  python3 - "$SECRET" "$1" "$2" <<'PY'
import base64, hashlib, hmac, sys, time
secret, label, offset = sys.argv[1], sys.argv[2], int(sys.argv[3])
username = f"{int(time.time()) + offset}:{label}"
cred = base64.b64encode(hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()).decode()
print(username)
print(cred)
PY
}

run_client() { # $1 user, $2 cred
  timeout 25 turnutils_uclient -u "$1" -w "$2" -p "$PORT" -n 1 -m 1 -y "$HOST" 2>&1
}

fail=0

echo "==> valid credential should relay"
mapfile -t GOOD < <(mint "verify" 600)
OUT=$(run_client "${GOOD[0]}" "${GOOD[1]}")
if echo "$OUT" | grep -qiE "Total connect time|Total transmit time"; then
  echo "    PASS — allocation succeeded and data relayed"
  echo "$OUT" | grep -iE "Total lost packets" | head -1 | sed 's/^/    /'
else
  echo "    FAIL — no relay. Output:"
  echo "$OUT" | tail -5 | sed 's/^/      /'
  fail=1
fi

echo "==> expired credential should be refused"
mapfile -t OLD < <(mint "verify" -60)
# Capture first, then match: with `pipefail` a non-zero exit from the client
# counts as the pipeline's status and would mask a successful grep.
OUT=$(run_client "${OLD[0]}" "${OLD[1]}")
if echo "$OUT" | grep -qiE "Cannot complete Allocation|ERROR|401"; then
  echo "    PASS — expired credential refused"
else
  echo "    FAIL — coturn accepted an expired credential"; fail=1
fi

echo "==> wrong secret should be refused"
BADUSER="$(( $(date +%s) + 600 )):mallory"
BADCRED=$(python3 -c "
import base64,hashlib,hmac,time
u='$BADUSER'
print(base64.b64encode(hmac.new(b'definitely-not-the-secret', u.encode(), hashlib.sha1).digest()).decode())")
OUT=$(run_client "$BADUSER" "$BADCRED")
if echo "$OUT" | grep -qiE "Cannot complete Allocation|ERROR|401"; then
  echo "    PASS — forged credential refused"
else
  echo "    FAIL — coturn accepted a forged credential"; fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "coturn is relaying correctly."
else
  echo "coturn verification FAILED — check /var/log/turnserver.log"
fi
exit "$fail"
