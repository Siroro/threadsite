#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/workspaces data/sites data/bot secrets
if [[ ! -e secrets/forgejo-token ]]; then
  umask 077
  : > secrets/forgejo-token
  chmod 600 secrets/forgejo-token
fi
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example"
else
  echo ".env already exists"
fi
printf '\nNext:\n  1. Edit .env and set DISCORD_BOT_TOKEN + DISCORD_APPLICATION_ID.\n  2. docker compose up -d forgejo opencode gameserver\n  3. ./scripts/bootstrap-forgejo.sh\n  4. docker compose up -d bot\n\nIf you want the bundled static Apache too:\n  docker compose --profile bundled-static up -d\n'
