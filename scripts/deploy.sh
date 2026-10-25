#!/usr/bin/env bash
#
# One-command in-place update from the GitHub remote. This repository is
# main-only: every deployment tracks origin/main.
#
#   scripts/deploy.sh           # update tracked files to origin/main
#   scripts/deploy.sh --force   # also discard local edits to tracked files
#
# .env, secrets/ and data/ are untracked and never touched; NEVER run
# `git clean` in this repo. Rebuilds and recreates only the containers whose
# code actually changed since the deployed commit.
#
set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH="main"
ORIGIN="${THREADSITE_ORIGIN:-https://github.com/Siroro/threadsite.git}"
FORCE=0
case "${1:-}" in
  --force) FORCE=1 ;;
  "") ;;
  *) echo "Unknown argument: $1 (only --force is accepted; this repo is main-only)" >&2; exit 1 ;;
esac

command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

# git refuses repositories owned by another user (common when the tree was
# created by root). Self-heal: mark exactly this checkout as safe for the
# current user instead of failing the deploy.
if ! git rev-parse --git-dir >/dev/null 2>&1 && git rev-parse --git-dir 2>&1 | grep -q "dubious ownership"; then
  git config --global --add safe.directory "$(pwd)"
  echo "Marked $(pwd) as a safe git directory for $(whoami)."
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "$ORIGIN"
  echo "Added origin $ORIGIN"
fi

# Tracked-but-modified files would be discarded by the checkout below.
# Untracked files (including .env, secrets/, data/) are safe and never block.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  if (( FORCE )); then
    echo "Discarding local edits to tracked files (--force)."
  else
    echo "Refusing to deploy: the working tree has local changes to tracked files." >&2
    echo "Commit or stash them, or re-run with --force to discard them." >&2
    exit 1
  fi
fi

echo "Fetching from origin…"
git fetch origin

if ! git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
  echo "Remote branch origin/$BRANCH not found." >&2
  exit 1
fi

old_head="$(git rev-parse --short HEAD)"
new_head="$(git rev-parse --short "origin/$BRANCH")"

if [[ "$old_head" != "$new_head" ]]; then
  echo "Updating $old_head -> $new_head ($BRANCH):"
  git log --oneline "HEAD..origin/$BRANCH" | head -15
fi

# Main-only: force the checkout to origin/main. -f discards the (already
# vetted) local edits and overwrites stale untracked copies of files that are
# tracked upstream, the state a copied or pre-rewrite checkout ends up in.
git checkout -f -B "$BRANCH" "origin/$BRANCH" >/dev/null
git branch --set-upstream-to="origin/$BRANCH" HEAD >/dev/null 2>&1 || true

# Drop stale local branches (pre-rewrite history would only mislead a pull).
for stale in $(git for-each-ref --format='%(refname:short)' refs/heads/ | grep -vx "$BRANCH" || true); do
  git branch -D "$stale" >/dev/null 2>&1 && echo "Removed stale local branch $stale"
done

if [[ "$old_head" == "$new_head" ]]; then
  echo "Already at $new_head ($BRANCH): nothing to update."
  exit 0
fi

# Build and recreate only what changed. Assets, agent templates and commands
# all live inside the bot image; the other services change rarely.
mapfile -t services < <( {
  git diff --name-only "$old_head" "$new_head" | grep -qE '^(bot/|scripts/)' && echo bot
  git diff --name-only "$old_head" "$new_head" | grep -qE '^opencode/' && echo opencode
  git diff --name-only "$old_head" "$new_head" | grep -qE '^gameserver/' && echo gameserver
  git diff --name-only "$old_head" "$new_head" | grep -qE '^preview/' && echo preview
} || true )

if [[ ${#services[@]} -eq 0 ]]; then
  echo "No service code changed: nothing to rebuild. Deployed commit: $new_head"
  exit 0
fi

echo "Rebuilding: ${services[*]}"
docker compose build "${services[@]}"
docker compose up -d "${services[@]}"

if git diff --name-only "$old_head" "$new_head" | grep -qE '^docker-compose\.yml'; then
  echo "NOTE: docker-compose.yml changed; consider 'docker compose up -d' for all services."
fi

echo "Done. Deployed $new_head ($BRANCH)."
echo "On boot the bot backfills pinned project cards into existing threads;"
echo "new slash-command options register immediately (guild) or within ~1h (global)."
