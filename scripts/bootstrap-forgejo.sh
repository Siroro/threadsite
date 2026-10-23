#!/usr/bin/env bash
set -euo pipefail
RESTART_BOT=1
if [[ "${1:-}" == --no-restart-bot && $# == 1 ]]; then
  RESTART_BOT=0
elif (( $# )); then
  echo "Usage: scripts/bootstrap-forgejo.sh [--no-restart-bot]" >&2
  exit 2
fi
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "Missing .env. Run ./scripts/setup.sh first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

OWNER="${FORGEJO_OWNER:-sitebot}"
EMAIL="${FORGEJO_BOT_EMAIL:-sitebot@localhost}"
ADMIN_USER="${FORGEJO_ADMIN_USER:-forgeadmin}"
ADMIN_EMAIL="${FORGEJO_ADMIN_EMAIL:-forgeadmin@localhost}"
mkdir -p secrets

if [[ "${ADMIN_USER,,}" == "admin" ]]; then
  echo "FORGEJO_ADMIN_USER=admin is reserved by Forgejo and cannot be created." >&2
  echo "Use a normal username such as FORGEJO_ADMIN_USER=forgeadmin, then rerun this script." >&2
  exit 2
fi

echo "Ensuring Forgejo is running..."
docker compose up -d forgejo

# The rootless image stores its generated app.ini here.
FJ=(forgejo -w /var/lib/gitea -c /var/lib/gitea/custom/conf/app.ini)

for _ in {1..60}; do
  if docker compose exec -T forgejo "${FJ[@]}" admin user list >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

USER_LIST="$(docker compose exec -T forgejo "${FJ[@]}" admin user list 2>/dev/null || true)"
user_exists() {
  local user="$1"
  awk 'NR>1 {print $2}' <<<"$USER_LIST" | grep -Fxq "$user"
}

if ! user_exists "$ADMIN_USER"; then
  ADMIN_PASSWORD="${FORGEJO_ADMIN_PASSWORD:-}"
  if [[ -z "$ADMIN_PASSWORD" ]]; then
    ADMIN_PASSWORD="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
    umask 077
    printf '%s\n' "$ADMIN_PASSWORD" > secrets/forgejo-admin-password
    chmod 600 secrets/forgejo-admin-password
  fi
  echo "Creating Forgejo administrator '$ADMIN_USER'..."
  docker compose exec -T forgejo "${FJ[@]}" admin user create \
    --username "$ADMIN_USER" \
    --email "$ADMIN_EMAIL" \
    --password "$ADMIN_PASSWORD" \
    --admin \
    --must-change-password=false
  if [[ -z "${FORGEJO_ADMIN_PASSWORD:-}" ]]; then
    echo "Generated admin password is stored in secrets/forgejo-admin-password"
  fi
  USER_LIST="$(docker compose exec -T forgejo "${FJ[@]}" admin user list 2>/dev/null || true)"
else
  echo "Forgejo administrator '$ADMIN_USER' already exists."
fi

if ! user_exists "$OWNER"; then
  echo "Creating non-admin Forgejo service user '$OWNER'..."
  docker compose exec -T forgejo "${FJ[@]}" admin user create \
    --username "$OWNER" \
    --email "$EMAIL" \
    --random-password \
    --must-change-password=false
else
  echo "Forgejo service user '$OWNER' already exists."
fi

TOKEN_NAME="threadsite-$(date +%s)"
TOKEN="$(docker compose exec -T forgejo "${FJ[@]}" admin user generate-access-token \
  --username "$OWNER" --token-name "$TOKEN_NAME" --raw --scopes all | tr -d '\r\n')"

if [[ -z "$TOKEN" ]]; then
  echo "Forgejo did not return an access token." >&2
  exit 1
fi

umask 077
printf '%s\n' "$TOKEN" > secrets/forgejo-token
chmod 600 secrets/forgejo-token

# A second token, from the admin account, solely for creating the restricted
# per-repo push accounts that /site pushkey hands out. The service token cannot
# create users; this one must never be used for anything else.
ADMIN_TOKEN_NAME="threadsite-admin-$(date +%s)"
ADMIN_TOKEN="$(docker compose exec -T forgejo "${FJ[@]}" admin user generate-access-token \
  --username "$ADMIN_USER" --token-name "$ADMIN_TOKEN_NAME" --raw --scopes all | tr -d '\r\n')"

if [[ -n "$ADMIN_TOKEN" ]]; then
  printf '%s\n' "$ADMIN_TOKEN" > secrets/forgejo-admin-token
  chmod 600 secrets/forgejo-admin-token
  echo "Wrote secrets/forgejo-admin-token for push-account creation."
else
  echo "WARNING: Forgejo did not return an admin access token; /site pushkey will not work until this script succeeds." >&2
fi

echo "Wrote secrets/forgejo-token for the non-admin '$OWNER' account."
if (( RESTART_BOT )); then
  echo "Restarting bot if it already exists..."
  docker compose restart bot >/dev/null 2>&1 || true
fi
echo "Done."
