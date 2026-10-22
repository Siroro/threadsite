#!/usr/bin/env bash
#
# ThreadSite start script — the one command for the server. This repository is
# main-only: every update tracks origin/main.
#
#   ./start.sh                 update to latest main, rebuild, up
#   ./start.sh --no-update     start the current code without touching git
#   ./start.sh --force         update, discarding local edits to tracked files
#   ./start.sh status          service health overview
#   ./start.sh logs [service]  follow logs (default: bot)
#   ./start.sh restart [svc]   restart one service, or the whole stack
#   ./start.sh stop            stop the stack (containers, data and .env kept)
#   ./start.sh projects        list registered projects, threads and repositories
#   ./start.sh games           list registered games only
#   ./start.sh cleanup         select projects interactively for removal
#   ./start.sh remove --thread ID          preview full project removal
#   ./start.sh forget --repo NAME --apply  forget a registration, keeping files
#   ./start.sh purge                       preview orphaned resources; --apply removes them
#
# .env, secrets/ and data/ are untracked and never touched by updates.
# Optional profiles (set COMPOSE_PROFILES in .env): caddy (edge proxy with
# automatic HTTPS, see scripts/caddy-quickstart.sh) or bundled-static (httpd).
# First run on a fresh clone: ./scripts/setup.sh, edit .env, then start.
#
set -euo pipefail
cd "$(dirname "$0")"

UPDATE=1
FORCE=0
COMMAND="up"
SERVICE=""
MAINTENANCE_ARGS=()

usage() { sed -n '3,/^set -/p' "$0" | sed '$d; s/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    up|status|logs|restart|stop) COMMAND="$1" ;;
    projects|threads|repos|games|cleanup|remove|forget|purge)
      COMMAND="$1"; shift; MAINTENANCE_ARGS=("$@"); break ;;
    --no-update) UPDATE=0 ;;
    --force) FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    bot|opencode|forgejo|gameserver|preview|httpd|caddy) SERVICE="$1" ;;
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
    ready=0
    [[ -n "$out" ]] && ready=1
    while IFS= read -r state; do
      [[ -z "$state" ]] && continue
      case "$state" in healthy|running) ;; *) ready=0 ;; esac
    done <<< "$out"
    if (( ready )); then say "All services healthy."; return 0; fi
    sleep 3
  done
  warn "Some services are not healthy yet — check ./start.sh logs"
  return 1
}

maintenance() {
  compose run --rm --no-deps -T --entrypoint node bot dist/maintenance.js "$@"
}

remove_projects() {
  local mode="$1" apply=0 arg was_running result=0
  shift
  local selection=()
  for arg in "$@"; do
    if [[ "$arg" == --apply ]]; then apply=1; else selection+=("$arg"); fi
  done
  maintenance "$mode" "${selection[@]}" || return $?
  (( apply )) || return 0
  was_running="$(compose ps --status running -q bot)" || return $?
  if [[ -n "$was_running" ]]; then
    say "Stopping the bot during cleanup…"
    # Always restore its original running state, including after an error.
    trap 'compose up -d --no-deps bot' EXIT
    compose stop bot || return $?
  fi
  maintenance "$mode" "${selection[@]}" --apply || result=$?
  if [[ -n "$was_running" ]]; then
    compose up -d --no-deps bot || result=$?
    trap - EXIT
  fi
  return "$result"
}

cleanup_menu() {
  [[ -t 0 ]] || { echo "Interactive cleanup needs a terminal. Use remove/forget --thread ID [--apply] instead." >&2; return 1; }
  local output line index=0 choice mode confirmation number
  local rows=() selected=() fields=()
  output="$(maintenance list --tsv "${MAINTENANCE_ARGS[@]}")" || return $?
  [[ -n "$output" ]] || { say "No registered projects match."; return 0; }
  mapfile -t rows <<< "$output"
  printf '\nRegistered projects (thread / kind / status / name / repo):\n'
  for line in "${rows[@]}"; do
    index=$((index + 1))
    printf '  %d) %s\n' "$index" "$line"
  done
  printf '\nSelect numbers separated by spaces (0 cancels): '
  read -r choice || return 0
  [[ -n "$choice" && "$choice" != 0 ]] || return 0
  read -r -a fields <<< "$choice"
  for number in "${fields[@]}"; do
    if [[ ! "$number" =~ ^[1-9][0-9]*$ ]] || (( ${#number} > 6 )); then echo "Invalid selection: $number" >&2; return 1; fi
    if (( number > ${#rows[@]} )); then echo "Invalid selection: $number" >&2; return 1; fi
    line="${rows[number-1]}"
    selected+=(--thread "${line%%$'\t'*}")
  done
  printf '\n1) Remove project: Discord thread, repository, workspace, published files and registration\n2) Forget registration only: keep thread, repository and files\n0) Cancel\nChoose: '
  read -r choice || return 0
  case "$choice" in 1) mode=remove ;; 2) mode=forget ;; 0|"") return 0 ;; *) echo "Invalid action" >&2; return 1 ;; esac
  maintenance "$mode" "${selected[@]}" || return $?
  printf '\nType DELETE to apply this selection, or press Enter to cancel: '
  read -r confirmation || return 0
  [[ "$confirmation" == DELETE ]] || { say "Cancelled. No changes made."; return 0; }
  remove_projects "$mode" "${selected[@]}" --apply
}

case "$COMMAND" in
  status)
    compose ps
    echo
    health_overview
    ;;

  logs)
    exec docker compose logs -f --tail=100 "${SERVICE:-bot}"
    ;;

  projects|threads|repos)
    maintenance list "${MAINTENANCE_ARGS[@]}"
    ;;

  games)
    maintenance list "${MAINTENANCE_ARGS[@]}" --kind games
    ;;

  cleanup)
    cleanup_menu
    ;;

  remove|forget|purge)
    remove_projects "$COMMAND" "${MAINTENANCE_ARGS[@]}"
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
      # Update to origin/main and rebuild changed images. Refuses to run over
      # local tracked edits unless --force; self-heals git's dubious-ownership
      # refusal; never touches untracked .env/secrets/data.
      if (( FORCE )); then
        ./scripts/deploy.sh --force
      else
        ./scripts/deploy.sh
      fi
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
    say "Up to date on main. Logs: ./start.sh logs   Status: ./start.sh status"
    ;;
esac
