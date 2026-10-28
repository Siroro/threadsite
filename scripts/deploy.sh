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
# code actually changed since the deployed commit (a docker-compose.yml
# change rebuilds every service), and refreshes the shared build stamp when
# it can prove every image current, so a following ./start.sh need not build.
#
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib.sh

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

# Whether every image was current for the inputs of the last stamped build.
# Captured before the checkout moves HEAD and rewrites the compose files; it
# decides below whether this deploy may re-stamp after rebuilding.
images_were_current=0
if images_stamped_current; then images_were_current=1; fi

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
# all live inside the bot image; the other services change rarely. A compose
# change can move any build context, so it rebuilds everything.
changed_files="$(git diff --name-only "$old_head" "$new_head")"
mapfile -t services < <( {
  grep -qE '^(bot/|scripts/)' <<<"$changed_files" && echo bot
  grep -qE '^opencode/' <<<"$changed_files" && echo opencode
  grep -qE '^gameserver/' <<<"$changed_files" && echo gameserver
  grep -qE '^preview/' <<<"$changed_files" && echo preview
} || true )
if grep -qE '^docker-compose(\.override)?\.yml$' <<<"$changed_files"; then
  services=(bot opencode gameserver preview)
fi

if [[ ${#services[@]} -eq 0 ]]; then
  echo "No service code changed: nothing to rebuild. Deployed commit: $new_head"
  if (( images_were_current )); then stamp_images_current; fi
  exit 0
fi

echo "Rebuilding: ${services[*]}"
docker compose build "${services[@]}"
docker compose up -d "${services[@]}"
prune_dangling_images

# Re-stamp only when every image is now current for the new inputs: the
# services above were just rebuilt, and nothing the others build from changed
# (a compose change rebuilds everything, and an older commit or .env would
# have failed the check captured before the checkout). Otherwise leave the
# mismatched stamp in place: the caller's full build — or the next
# ./start.sh — reconciles and re-stamps instead of trusting the gap.
if (( images_were_current )); then
  stamp_images_current
fi

echo "Done. Deployed $new_head ($BRANCH)."
echo "Slash-command options register immediately (guild) or within ~1h (global)."
