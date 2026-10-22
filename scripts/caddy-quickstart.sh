#!/usr/bin/env bash
#
# One-shot Caddy deployment for a fresh server. Installs Docker on request,
# clones this repository when run standalone (e.g. via curl | bash), writes
# .env, creates the Caddy vhosts for the generated sites (plus optional
# Forgejo and multiplayer-relay hostnames), brings up the whole stack behind
# Caddy with automatic HTTPS, and bootstraps Forgejo.
#
# Host Apache stays the default publication path; this is the fresh-server
# shortcut using the optional `caddy` Compose profile.
#
#   scripts/caddy-quickstart.sh --sites-domain sites.example.com \
#       [--git-domain git.example.com] [--games-domain games.example.com] \
#       [--discord-token <token>] [--app-id <id>] [--install-docker] [--skip-bot]
#
# Or as a true one-liner on a fresh server (it clones the repository first):
#
#   curl -fsSL https://raw.githubusercontent.com/Siroro/threadsite/main/scripts/caddy-quickstart.sh | \
#     bash -s -- --sites-domain sites.example.com --install-docker
#
# Safe to re-run: only the deployment settings it needs are touched in .env
# (COMPOSE_PROFILES, SITES_DOMAIN, PUBLIC_SITES_BASE_URL, the Forgejo and relay
# public URLs, and the Discord credentials when supplied); data/, secrets/,
# and volumes are never modified. Every domain's DNS must
# already point at this server — Caddy obtains Let's Encrypt certificates on
# first start, which needs ports 80 and 443 reachable.
#
set -euo pipefail

ORIGIN="${THREADSITE_ORIGIN:-https://github.com/Siroro/threadsite.git}"
CLONE_DIR="${THREADSITE_DIR:-$HOME/threadsite}"

SITES_DOMAIN=""
GIT_DOMAIN=""
GAMES_DOMAIN=""
DISCORD_TOKEN=""
APP_ID=""
INSTALL_DOCKER=0
SKIP_BOT=0

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m -> \033[0m%s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  if [[ -f "$0" ]]; then
    sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'
  else
    echo "usage: caddy-quickstart.sh --sites-domain HOST [--git-domain HOST] [--games-domain HOST]"
    echo "                               [--discord-token TOKEN] [--app-id ID] [--install-docker] [--skip-bot]"
  fi
}

valid_domain() {
  [[ "$1" == "localhost" ]] && return 0
  [[ "$1" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$ ]]
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sites-domain) SITES_DOMAIN="${2:-}"; shift 2 ;;
    --git-domain) GIT_DOMAIN="${2:-}"; shift 2 ;;
    --games-domain) GAMES_DOMAIN="${2:-}"; shift 2 ;;
    --discord-token) DISCORD_TOKEN="${2:-}"; shift 2 ;;
    --app-id) APP_ID="${2:-}"; shift 2 ;;
    --install-docker) INSTALL_DOCKER=1; shift ;;
    --skip-bot) SKIP_BOT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

# --- locate (or clone) the repository --------------------------------------
#
# curl | bash runs with no checkout around it; clone and re-exec inside.
if [[ ! -f docker-compose.yml || ! -x scripts/caddy-quickstart.sh ]]; then
  command -v git >/dev/null 2>&1 || die \
    "git is required to clone $ORIGIN — install it, or clone the repository and run scripts/caddy-quickstart.sh from inside it"
  if [[ -d "$CLONE_DIR/.git" ]]; then
    say "Updating existing checkout at $CLONE_DIR"
    git -C "$CLONE_DIR" fetch origin
    git -C "$CLONE_DIR" checkout -f -B main origin/main >/dev/null
  else
    say "Cloning $ORIGIN into $CLONE_DIR"
    git clone "$ORIGIN" "$CLONE_DIR"
  fi
  cd "$CLONE_DIR"
  exec ./scripts/caddy-quickstart.sh \
    --sites-domain "$SITES_DOMAIN" \
    --git-domain "$GIT_DOMAIN" \
    --games-domain "$GAMES_DOMAIN" \
    --discord-token "$DISCORD_TOKEN" \
    --app-id "$APP_ID" \
    $( (( INSTALL_DOCKER )) && echo --install-docker ) \
    $( (( SKIP_BOT )) && echo --skip-bot )
fi
cd "$(dirname "$0")/.."

# --- Docker -----------------------------------------------------------------

if ! docker info >/dev/null 2>&1; then
  if command -v docker >/dev/null 2>&1; then
    die "docker is installed but not usable as $(whoami) — run as root or add yourself to the docker group, then re-run"
  fi
  answer=""
  if (( INSTALL_DOCKER )); then answer=y
  elif [[ -t 0 ]]; then
    read -r -p "Docker is not installed. Install it now via get.docker.com? [y/N] " answer
  fi
  [[ "$answer" == "y" || "$answer" == "Y" ]] || die \
    "docker is required — install it (https://docs.docker.com/engine/install/) and re-run"
  command -v curl >/dev/null 2>&1 || die "curl is required to install Docker"
  say "Installing Docker via get.docker.com"
  sudo_=""
  (( EUID != 0 )) && sudo_="sudo"
  ${sudo_} sh -c 'curl -fsSL https://get.docker.com | sh'
  if ! docker info >/dev/null 2>&1; then
    (( EUID == 0 )) || ${sudo_} usermod -aG docker "$(whoami)" || true
    docker info >/dev/null 2>&1 || die \
      "Docker was installed but this shell cannot use it yet — log out and back in (docker group), then re-run this script; everything done so far is kept"
  fi
fi

# --- gather answers interactively when flags were not given -----------------

if [[ -t 0 ]]; then
  if [[ -z "$SITES_DOMAIN" ]]; then
    read -r -p "Public hostname for the generated sites (e.g. sites.example.com): " SITES_DOMAIN
  fi
  if [[ -z "$GIT_DOMAIN" ]]; then
    read -r -p "Hostname for the Forgejo source browser (Enter to keep it loopback-only): " GIT_DOMAIN
  fi
  if [[ -z "$GAMES_DOMAIN" ]]; then
    read -r -p "Hostname for the multiplayer relay (Enter to keep ws://localhost:8090): " GAMES_DOMAIN
  fi
  if [[ -z "$DISCORD_TOKEN" && $SKIP_BOT -eq 0 ]]; then
    read -r -s -p "Discord bot token (Enter to skip starting the bot): " DISCORD_TOKEN
    printf '\n'
  fi
  if [[ -n "$DISCORD_TOKEN" && -z "$APP_ID" ]]; then
    read -r -p "Discord application ID: " APP_ID
  fi
fi

[[ -n "$SITES_DOMAIN" ]] || die "a sites hostname is required (--sites-domain, or run interactively)"
valid_domain "$SITES_DOMAIN" || die "invalid sites hostname: $SITES_DOMAIN"
if [[ -n "$GIT_DOMAIN" ]]; then
  valid_domain "$GIT_DOMAIN" || die "invalid git hostname: $GIT_DOMAIN"
fi
if [[ -n "$GAMES_DOMAIN" ]]; then
  valid_domain "$GAMES_DOMAIN" || die "invalid games hostname: $GAMES_DOMAIN"
fi
if [[ "$SITES_DOMAIN" == "localhost" && ( -n "$GIT_DOMAIN" || -n "$GAMES_DOMAIN" ) ]]; then
  warn "SITES_DOMAIN=localhost cannot front other public hostnames; use a real hostname for Let's Encrypt"
fi

# --- .env and directory layout ----------------------------------------------

say "Preparing directories and .env"
./scripts/setup.sh

set_env() {
  local key="$1" value="$2" esc="${2//\\/\\\\}"
  esc="${esc//&/\\&}"
  esc="${esc//|/\\|}"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${esc}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

say "Writing Caddy settings into .env"
set_env COMPOSE_PROFILES caddy
set_env SITES_DOMAIN "$SITES_DOMAIN"
set_env PUBLIC_SITES_BASE_URL "https://${SITES_DOMAIN}"
if [[ -n "$GIT_DOMAIN" ]]; then
  set_env FORGEJO_PUBLIC_URL "https://${GIT_DOMAIN}"
  set_env FORGEJO_DOMAIN "$GIT_DOMAIN"
fi
if [[ -n "$GAMES_DOMAIN" ]]; then
  set_env GAMESERVER_PUBLIC_URL "wss://${GAMES_DOMAIN}/ws"
  set_env GAMESERVER_ALLOWED_ORIGINS "https://${SITES_DOMAIN}"
fi

# --- Caddy vhosts ------------------------------------------------------------

mkdir -p caddy/vhosts
if [[ -n "$GIT_DOMAIN" ]]; then
  say "Writing caddy/vhosts/forgejo.caddy for ${GIT_DOMAIN}"
  sed "s|git\.example\.com|${GIT_DOMAIN}|g" \
    caddy/vhosts/forgejo.caddy.example > caddy/vhosts/forgejo.caddy
fi
if [[ -n "$GAMES_DOMAIN" ]]; then
  say "Writing caddy/vhosts/games.caddy for ${GAMES_DOMAIN}"
  sed -e "s|games\.example\.com|${GAMES_DOMAIN}|g" \
      -e "s|sites\.example\.com|${SITES_DOMAIN}|g" \
    caddy/vhosts/games.caddy.example > caddy/vhosts/games.caddy
fi

# --- bring the stack up -------------------------------------------------------

export COMPOSE_PROFILES=caddy
say "Starting forgejo, opencode, preview, gameserver and caddy"
docker compose up -d forgejo opencode preview gameserver caddy

say "Bootstrapping Forgejo (admin + service account)"
./scripts/bootstrap-forgejo.sh

# --- bot (needs the Discord credentials) --------------------------------------

if (( SKIP_BOT )); then
  warn "--skip-bot: start it later with 'docker compose up -d bot'"
else
  [[ -n "$DISCORD_TOKEN" ]] && set_env DISCORD_BOT_TOKEN "$DISCORD_TOKEN"
  [[ -n "$APP_ID" ]] && set_env DISCORD_APPLICATION_ID "$APP_ID"
  token="$(grep -m1 '^DISCORD_BOT_TOKEN=' .env | cut -d= -f2- || true)"
  appid="$(grep -m1 '^DISCORD_APPLICATION_ID=' .env | cut -d= -f2- || true)"
  if [[ -n "$token" && -n "$appid" ]]; then
    say "Starting the Discord bot"
    docker compose up -d bot
  else
    warn "DISCORD_BOT_TOKEN / DISCORD_APPLICATION_ID are not set — everything else is up."
    warn "Add them to .env, then run: docker compose up -d bot"
  fi
fi

# --- summary -------------------------------------------------------------------

echo
say "Deployment summary"
echo "  Sites index:   https://${SITES_DOMAIN}"
[[ -n "$GIT_DOMAIN" ]] && echo "  Forgejo:       https://${GIT_DOMAIN}"
[[ -n "$GAMES_DOMAIN" ]] && echo "  Relay (WSS):   wss://${GAMES_DOMAIN}/ws"
[[ "$SITES_DOMAIN" == "localhost" ]] && \
  warn "SITES_DOMAIN=localhost uses Caddy's internal certificate (browser warning expected); set a real hostname for Let's Encrypt"
echo
docker compose ps
echo
say "Next steps"
echo "  - Invite the bot to Discord (permissions: docs/deployment.md) if not done yet"
echo "  - Logs: ./start.sh logs    Status: ./start.sh status    Updates: ./start.sh"
