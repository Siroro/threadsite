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

PUBLIC="${FORGEJO_PUBLIC_URL:-}"
PORT="${FORGEJO_PORT:-3000}"

if [[ -z "$PUBLIC" ]]; then
  echo "FORGEJO_PUBLIC_URL is empty." >&2
  exit 1
fi

printf 'Internal Forgejo: '
curl -fsS -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:${PORT}/" || true
printf 'Public Forgejo:   '
curl -fsS -o /dev/null -w '%{http_code}\n' "${PUBLIC%/}/" || true

ASSET_PATH="$(curl -fsSL "${PUBLIC%/}/" 2>/dev/null | grep -oE '(/assets/[^"'"'"' ]+\.js[^"'"'"' ]*)' | head -n1 || true)"
if [[ -n "$ASSET_PATH" ]]; then
  printf 'Public asset:     '
  curl -fsS -o /dev/null -w '%{http_code} %{content_type}\n' "${PUBLIC%/}${ASSET_PATH}" || true
  echo "Asset URL: ${PUBLIC%/}${ASSET_PATH}"
else
  echo "Could not discover a JS asset from the Forgejo home page."
fi

echo
echo "If internal is 200 but the public asset fails, fix the Virtualmin HTTPS vhost using apache/forgejo-virtualmin.conf.example."
