#!/usr/bin/env bash
#
# ThreadSite start script — the one command for the server: update from git,
# rebuild what changed, bring the stack up, and watch it get healthy.
# Also covers the day-2 operations.
#
#   ./start.sh                 update to latest main, rebuild, up
#   ./start.sh release/v2.5    same, tracking a specific branch
#   ./start.sh --no-update     start the current code without touching git
#   ./start.sh status          service health overview
#   ./start.sh logs [service]  follow logs (default: bot)
#   ./start.sh restart [svc]   restart one service, or the whole stack
#   ./start.sh stop            stop the stack (containers, data and .env kept)
#
# .env, secrets/ and data/ are untracked and never touched by updates.
# Bundled Apache profile: COMPOSE_PROFILES=bundled-static ./start.sh
# First run on a fresh clone: ./scripts/setup.sh, edit .env, then start.
#
set -euo pipefail
cd "$(dirname "$0")"

BRANCH="main"
UPDATE=1
COMMAND="up"
SERVICE=""

usage() { grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed -n '3,20p'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    up|status|logs|restart|stop) COMMAND="$1" ;;
    --no-update) UPDATE=0 ;;
    -h|--help) usage; exit 0 ;;
    main|release/*) BRANCH="$1" ;;
    bot|opencode|forgejo|gameserver|preview|httpd) SERVICE="$1" ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

if [[ -t 1 ]]; then
  say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
  warn() { printf '\033[1;33m -> \033[0m%s\n' "$*" >&2; }
else
  say()  { printf '==> %s\n' "$*"; }
  warn() { printf ' -> %s\n' "$*" >&2; }
fi

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
compose() { docker compose "$@"; }

if [[ ! -f .env ]]; then
  echo "No .env found — run ./scripts/setup.sh, fill in the values, then start." >&2
  exit 1
fi

health_overview() {
  compose ps -q | xargs -r docker inspect --format '  {{.Name}}: {{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true
}

wait_healthy() {
  local deadline=$((SECONDS + 120)) out ready
  say "Waiting for services to report healthy (up to 2 min)…"
  while (( SECONDS < deadline )); do
    out="$(compose ps -q | xargs -r docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
    ready=1
    while IFS= read -r state; do
      [[ -z "$state" ]] && continue
      case "$state" in healthy|running) ;; *) ready=0 ;; esac
    done <<< "$out"
    if (( ready )); then say "All services healthy."; return 0; fi
    sleep 3
  done
  warn "Some services are not healthy yet — check ./start.sh logs"
}

case "$COMMAND" in
  status)
    compose ps
    echo
    health_overview
    ;;

  logs)
    exec compose logs -f --tail=100 "${SERVICE:-bot}"
    ;;

  restart)
    if [[ -n "$SERVICE" ]]; then
      say "Restarting $SERVICE…"
      compose restart "$SERVICE"
    else
      say "Restarting the stack…"
      compose restart
    fi
    health_overview
    ;;

  stop)
    say "Stopping the stack (data and .env are kept)…"
    compose stop
    ;;

  up)
    if (( UPDATE )); then
      # Update code and rebuild changed images. deploy.sh refuses to run over
      # local tracked edits and self-heals git's dubious-ownership refusal.
      ./scripts/deploy.sh "$BRANCH"
    else
      say "Skipping the git update (--no-update)."
    fi

    say "Bringing the stack up…"
    compose up -d

    wait_healthy
    echo
    compose ps
    echo
    if [[ ! -e secrets/forgejo-token ]]; then
      warn "First run detected: bootstrap the Forgejo service user with"
      warn "  ./scripts/bootstrap-forgejo.sh"
    fi
    say "Up to date on $BRANCH. Logs: ./start.sh logs   Status: ./start.sh status"
    ;;
esac
