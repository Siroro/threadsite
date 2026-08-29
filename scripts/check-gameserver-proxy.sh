#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "Missing .env. Run ./scripts/setup.sh first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

PUBLIC="${GAMESERVER_PUBLIC_URL:-ws://localhost:8090/ws}"
PORT="${GAMESERVER_PORT:-8090}"

# Browsers send this Origin on the WebSocket handshake; the relay rejects
# upgrades from other origins when GAMESERVER_ALLOWED_ORIGINS is configured.
if [[ -n "${GAMESERVER_ALLOWED_ORIGINS:-}" ]]; then
  ORIGIN="${GAMESERVER_ALLOWED_ORIGINS%%,*}"
else
  ORIGIN="${PUBLIC_SITES_BASE_URL:-http://localhost:8080}"
fi
ORIGIN="${ORIGIN%%/}"

printf 'Internal relay:   '
curl -fsS -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:${PORT}/health" || true

printf 'WebSocket upgrade (%s):\n' "$PUBLIC"
CURL_ERR_FILE="$(mktemp)"
STATUS="$(
  curl -sS --http1.1 --max-time 6 -o /dev/null -D - \
    -H 'Connection: Upgrade' \
    -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    -H 'Sec-WebSocket-Version: 13' \
    -H "Origin: ${ORIGIN}" \
    "${PUBLIC}" 2>"$CURL_ERR_FILE" | head -n1 | tr -d '\r' || true
)"
CURL_ERR="$(tr '\n' ' ' <"$CURL_ERR_FILE")"
rm -f "$CURL_ERR_FILE"
printf '  sent Origin: %s\n' "$ORIGIN"
printf '  response:    %s\n' "${STATUS:-none}"
if [[ -z "$STATUS" && -n "${CURL_ERR// /}" ]]; then
  printf '  curl error:  %s\n' "$CURL_ERR"
fi

if [[ "$STATUS" == *" 101 "* ]]; then
  echo "OK: the relay answered the upgrade through Apache."
elif [[ -z "$STATUS" ]]; then
  echo
  echo "No HTTP response at all — the request failed at the DNS, TCP, or TLS layer, before any server replied."
  echo "- 'Could not resolve host': the DNS record for this hostname does not exist in the authoritative zone"
  echo "  (if siroro.co.uk uses Cloudflare DNS, add the A record in Cloudflare; Virtualmin's local zone is not"
  echo "  authoritative)."
  echo "- Connection timed out: the record resolves to an IP that is not reachable from where you ran this."
  echo "  Running ON the host box with the record pointing at its own public IP is a classic hairpin-NAT case —"
  echo "  test from outside the box, or use '--resolve <host>:443:127.0.0.1' to test Apache locally."
  echo "- SSL/TLS error: certificate/SNI mismatch when bypassing Cloudflare."
  exit 1
else
  echo
  echo "Got '${STATUS}' instead of '101 Switching Protocols'."
  echo "If the internal relay printed 200, fix the Virtualmin HTTPS vhost using apache/gameserver-vhost.conf.example"
  echo "(modules: proxy proxy_http proxy_wstunnel headers), and make sure Origin '${ORIGIN}' is allowed by"
  echo "GAMESERVER_ALLOWED_ORIGINS when that list is set. With Cloudflare proxying, also check the SSL/TLS mode"
  echo "is Full (strict) — Flexible never reaches the HTTPS vhost."
  exit 1
fi
