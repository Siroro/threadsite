#!/usr/bin/env bash
#
# One-command in-place update from the GitHub remote:
#
#   scripts/deploy.sh              # track origin/main (the default branch)
#   scripts/deploy.sh release/v2.5 # track a specific branch
#
# Fetches, hard-resets tracked files to the remote branch (safe for .env,
# secrets/ and data/ — they are untracked and never touched; NEVER run
# `git clean` in this repo), then rebuilds and recreates only the containers
# whose code actually changed since the deployed commit.
#
set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH="${1:-main}"
ORIGIN="${THREADSITE_ORIGIN:-https://github.com/Siroro/threadsite.git}"

command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "$ORIGIN"
  echo "Added origin $ORIGIN"
fi

# Tracked-but-modified files would be lost to the reset; untracked files
# (.env, secrets/, data/) are ignored by definition and stay safe.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to deploy: the working tree has local changes to tracked files." >&2
  echo "Commit or stash them first (git stash), then re-run." >&2
  exit 1
fi

echo "Fetching from origin…"
git fetch origin

if ! git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
  echo "Remote branch origin/$BRANCH not found." >&2
  echo "Available: $(git branch -r --format '%(refname:short)' | tr '\n' ' ')" >&2
  exit 1
fi

old_head="$(git rev-parse --short HEAD)"
new_head="$(git rev-parse --short "origin/$BRANCH")"
if [[ "$old_head" == "$new_head" ]]; then
  echo "Already at $new_head ($BRANCH) — nothing to update."
  exit 0
fi
echo "Updating $old_head -> $new_head ($BRANCH):"
git log --oneline "HEAD..origin/$BRANCH" | head -15
git reset --hard "origin/$BRANCH" >/dev/null

# Build and recreate only what changed. Assets, agent templates and commands
# all live inside the bot image; the other services change rarely.
mapfile -t services < <( {
  git diff --name-only "$old_head" "$new_head" | grep -qE '^(bot/|scripts/)' && echo bot
  git diff --name-only "$old_head" "$new_head" | grep -qE '^opencode/' && echo opencode
  git diff --name-only "$old_head" "$new_head" | grep -qE '^gameserver/' && echo gameserver
  git diff --name-only "$old_head" "$new_head" | grep -qE '^preview/' && echo preview
} || true )

if [[ ${#services[@]} -eq 0 ]]; then
  echo "No service code changed — nothing to rebuild. Deployed commit: $new_head"
  exit 0
fi

echo "Rebuilding: ${services[*]}"
docker compose build "${services[@]}"
docker compose up -d "${services[@]}"

if git diff --name-only "$old_head" "$new_head" | grep -qE '^docker-compose\.yml'; then
  echo "NOTE: docker-compose.yml changed — consider 'docker compose up -d' for all services."
fi

echo "Done. Deployed $new_head ($BRANCH)."
echo "On boot the bot backfills pinned project cards into existing threads;"
echo "new slash-command options register immediately (guild) or within ~1h (global)."
