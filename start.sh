#!/usr/bin/env bash
#
# Root-level one-command update + start: pull the latest code from GitHub,
# rebuild the images whose sources changed, and bring the whole stack up.
#
#   ./start.sh               # latest main, default compose services
#   ./start.sh release/v2.5  # latest of a specific branch
#
# .env, secrets/ and data/ are untracked and never touched. A fresh clone
# needs ./scripts/setup.sh (and ./scripts/bootstrap-forgejo.sh) once first.
#
set -euo pipefail
cd "$(dirname "$0")"

BRANCH="${1:-main}"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

if [[ ! -f .env ]]; then
  echo "No .env found — run ./scripts/setup.sh and fill it in first." >&2
  exit 1
fi

# Update code and rebuild changed images. This also self-heals git's
# dubious-ownership refusal and refuses to run over local tracked edits.
./scripts/deploy.sh "$BRANCH"

# Open the stack: the default profile's services (bot, opencode, forgejo,
# gameserver, preview and their dependencies). Append --profile
# bundled-static yourself if you use the bundled Apache profile.
echo "Bringing the stack up…"
docker compose up -d

echo
docker compose ps
echo "Stack up to date on $BRANCH."
