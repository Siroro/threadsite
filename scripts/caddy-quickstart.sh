#!/usr/bin/env bash
# Install ThreadSite with Caddy. Run directly or through curl | bash.
# See --help for unattended installation and docs/discord.md for Discord setup.
set -euo pipefail
umask 077

ORIGIN="${THREADSITE_ORIGIN:-https://github.com/Siroro/threadsite.git}"
CLONE_DIR="${THREADSITE_DIR:-$HOME/threadsite}"
BASE_DOMAIN=""
SITES_EXPLICIT=0
GIT_EXPLICIT=0
GAMES_EXPLICIT=0
SITES_DOMAIN="${SITES_DOMAIN:-}"
GIT_DOMAIN=""
GAMES_DOMAIN=""
DISCORD_TOKEN="${DISCORD_BOT_TOKEN:-}"
APP_ID="${DISCORD_APPLICATION_ID:-}"
GUILD_ID="${DISCORD_GUILD_ID:-}"
ADMIN_IDS="${DISCORD_ADMIN_USER_IDS:-}"
MODEL="${OPENCODE_DEFAULT_MODEL:-}"
API_KEY="${THREADSITE_API_KEY:-}"
INSTALL_DOCKER=0
SKIP_BOT=0
NON_INTERACTIVE=0
WAIT_SECONDS=180
PROMPT_FD=""

say() { printf '\n==> %s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die() { warn "$*"; exit 1; }
usage() {
  cat <<'HELP'
Usage: scripts/caddy-quickstart.sh [options]

Run with no options for guided setup, including through curl | bash.
Press Enter to keep saved settings. Secrets are read without echoing them.

  --domain DOMAIN          Use sites.DOMAIN and git.DOMAIN
  --sites-domain HOST      Public hostname for generated sites
  --git-domain HOST        Public hostname for source repositories
  --games-domain HOST      Optional separate hostname for multiplayer
  --games-on-sites         Use the sites hostname, replacing a saved games host
  --discord-token TOKEN    Discord bot token (or DISCORD_BOT_TOKEN)
  --discord-token-file FILE Read the Discord token from a private file
  --app-id ID              Optional; discovered from the bot token
  --guild-id ID            Register commands in one Discord server
  --admin-ids IDS          Extra admin user IDs, separated by commas
  --model PROVIDER/MODEL   Builder model; defaults to .env.example
  --api-key KEY            Model provider key (or THREADSITE_API_KEY)
  --api-key-file FILE      Read the provider key from a private file
  --install-docker         Install Docker and missing git/curl/jq dependencies
  --non-interactive       Never prompt; fail if required settings are missing
  --wait-seconds N         Startup timeout, in seconds (default 180)
  --skip-bot               Set up infrastructure without Discord/model checks
  -h, --help              Show this help

Use environment variables, private files or prompts for secrets so they do
not appear in your shell history. Discord setup: docs/discord.md.
HELP
}
need_value() { [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die "Missing value for $1"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain|--sites-domain|--git-domain|--games-domain|--discord-token|--discord-token-file|--app-id|--guild-id|--admin-ids|--model|--api-key|--api-key-file|--wait-seconds) need_value "$@" ;;
  esac
  case "$1" in
    --domain) BASE_DOMAIN="$2"; shift 2 ;;
    --sites-domain) SITES_DOMAIN="$2"; SITES_EXPLICIT=1; shift 2 ;;
    --git-domain) GIT_DOMAIN="$2"; GIT_EXPLICIT=1; shift 2 ;;
    --games-domain) GAMES_DOMAIN="$2"; GAMES_EXPLICIT=1; shift 2 ;;
    --games-on-sites) GAMES_DOMAIN=""; GAMES_EXPLICIT=1; shift ;;
    --discord-token) DISCORD_TOKEN="$2"; shift 2 ;;
    --discord-token-file) [[ -r "$2" ]] || die "Cannot read Discord token file"; DISCORD_TOKEN="$(cat -- "$2")"; shift 2 ;;
    --app-id) APP_ID="$2"; shift 2 ;;
    --guild-id) GUILD_ID="$2"; shift 2 ;;
    --admin-ids) ADMIN_IDS="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --api-key) API_KEY="$2"; shift 2 ;;
    --api-key-file) [[ -r "$2" ]] || die "Cannot read provider key file"; API_KEY="$(cat -- "$2")"; shift 2 ;;
    --install-docker) INSTALL_DOCKER=1; shift ;;
    --skip-bot) SKIP_BOT=1; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --wait-seconds) WAIT_SECONDS="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option; see --help (option values use a separate argument)" ;;
  esac
done
[[ "$WAIT_SECONDS" =~ ^[1-9][0-9]*$ ]] || die "--wait-seconds must be a positive integer"

# Open the terminal separately: stdin may still be the downloaded script.
if (( ! NON_INTERACTIVE )); then
  if [[ -t 0 ]]; then PROMPT_FD=0
  elif { exec 3<> /dev/tty; } 2>/dev/null; then PROMPT_FD=3
  fi
fi
ask() {
  local variable="$1" prompt="$2" secret="${3:-0}" reply=""
  [[ -n "$PROMPT_FD" ]] || return 0
  if [[ "$secret" == 1 ]]; then
    printf '%s: ' "$prompt" >&2
    read -r -s -u "$PROMPT_FD" reply || die "Input closed while reading $variable"
    printf '\n' >&2
  else
    printf '%s%s: ' "$prompt" "${!variable:+ [${!variable}]}" >&2
    read -r -u "$PROMPT_FD" reply || die "Input closed while reading $variable"
  fi
  [[ -z "$reply" ]] || printf -v "$variable" '%s' "$reply"
}
as_root() {
  if (( EUID == 0 )); then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else die "Root access or sudo is needed to install dependencies"
  fi
}
ensure_tools() {
  local missing=() tool answer=""
  for tool in "$@"; do command -v "$tool" >/dev/null 2>&1 || missing+=("$tool"); done
  (( ${#missing[@]} )) || return 0
  if (( ! INSTALL_DOCKER )); then
    ask answer "Install missing tools (${missing[*]})? [y/N]"
    [[ "$answer" == y || "$answer" == Y ]] || die "Install ${missing[*]} or rerun with --install-docker"
  fi
  if command -v apt-get >/dev/null 2>&1; then
    as_root apt-get update
    as_root apt-get install -y "${missing[@]}" ca-certificates
  elif command -v dnf >/dev/null 2>&1; then as_root dnf install -y "${missing[@]}" ca-certificates
  elif command -v apk >/dev/null 2>&1; then as_root apk add "${missing[@]}" ca-certificates
  else die "Install ${missing[*]} with your package manager, then rerun"
  fi
}

if [[ -n "$PROMPT_FD" ]]; then
  say "ThreadSite setup"
  printf 'I will ask for your hostnames, Discord bot and AI model settings.\n'
  printf 'Press Enter to keep a value shown in brackets. Secret input is hidden.\n'
  printf 'Point your chosen hostnames at this server and allow ports 80 and 443.\n'
fi

# Locate the checkout without replacing existing edits or passing secrets to a
# second process's command line. An existing standalone install is reused.
script_file="${BASH_SOURCE[0]:-}"
if [[ -f "$script_file" && -f "$(dirname "$script_file")/../scripts/caddy-quickstart.sh" && -f "$(dirname "$script_file")/../docker-compose.yml" ]]; then
  cd "$(dirname "$script_file")/.."
elif [[ ! -f docker-compose.yml || ! -f scripts/caddy-quickstart.sh ]]; then
  ensure_tools git
  if [[ ! -d "$CLONE_DIR/.git" ]]; then
    [[ ! -e "$CLONE_DIR" ]] || die "Install directory already exists and is not a Git checkout: $CLONE_DIR"
    git clone "$ORIGIN" "$CLONE_DIR"
  fi
  cd "$CLONE_DIR"
  # Continue this script in the checkout, preserving file-option paths relative
  # to the caller and supporting an installer downloaded ahead of a release.
  [[ -f docker-compose.yml && -f scripts/setup.sh ]] || die "Not a ThreadSite checkout: $CLONE_DIR"
fi
[[ -f .env.example && -f scripts/setup.sh && -f scripts/bootstrap-forgejo.sh && -f caddy/vhosts/games.caddy.example ]] || die "The install directory does not contain ThreadSite's setup files"

ensure_tools curl jq
get_env() {
  local key="$1" line value
  [[ -f .env ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == "$key="* ]] || continue
    value="${line#*=}"
    value="${value%$'\r'}"
    if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then value="${value:1:${#value}-2}"; fi
    printf '%s' "$value"
    return
  done < .env
}
reuse() { [[ -n "${!1}" ]] || printf -v "$1" '%s' "$(get_env "$2")"; }
reuse SITES_DOMAIN SITES_DOMAIN
reuse DISCORD_TOKEN DISCORD_BOT_TOKEN
reuse APP_ID DISCORD_APPLICATION_ID
reuse GUILD_ID DISCORD_GUILD_ID
reuse ADMIN_IDS DISCORD_ADMIN_USER_IDS
reuse MODEL OPENCODE_DEFAULT_MODEL
if [[ -z "$GIT_DOMAIN" ]]; then
  GIT_DOMAIN="$(get_env FORGEJO_DOMAIN)"
  [[ "$GIT_DOMAIN" != localhost ]] || GIT_DOMAIN=""
fi
if (( ! GAMES_EXPLICIT )); then
  GAMES_DOMAIN="$(get_env GAMESERVER_PUBLIC_URL)"
  if [[ "$GAMES_DOMAIN" == wss://* ]]; then
    GAMES_DOMAIN="${GAMES_DOMAIN#wss://}"
    GAMES_DOMAIN="${GAMES_DOMAIN%%/*}"
    [[ "$GAMES_DOMAIN" != localhost* ]] || GAMES_DOMAIN=""
    [[ "${GAMES_DOMAIN,,}" != "$(get_env SITES_DOMAIN)" ]] || GAMES_DOMAIN=""
  else GAMES_DOMAIN=""
  fi
fi
if [[ -n "$BASE_DOMAIN" ]]; then
  # An explicit base domain replaces saved hostnames; individual flags win.
  (( SITES_EXPLICIT )) || SITES_DOMAIN="sites.$BASE_DOMAIN"
  (( GIT_EXPLICIT )) || GIT_DOMAIN="git.$BASE_DOMAIN"
fi
if (( ! SITES_EXPLICIT )) && [[ -z "$BASE_DOMAIN" ]]; then
  ask SITES_DOMAIN "Sites hostname (for example lab.example.com)"
fi
[[ -n "$SITES_DOMAIN" ]] || die "Provide --domain or --sites-domain (DNS must point at this server)"
if (( ! SKIP_BOT )); then
  if (( ! GIT_EXPLICIT )) && [[ -z "$BASE_DOMAIN" ]]; then
    ask GIT_DOMAIN "Git hostname (for example git.example.com)"
  fi
  [[ -n "$GIT_DOMAIN" ]] || die "Provide --git-domain for source repositories, or use --domain"
  if (( ! GAMES_EXPLICIT )); then
    if [[ -n "$GAMES_DOMAIN" ]]; then
      ask GAMES_DOMAIN "Games hostname (Enter keeps the saved host; - shares the sites hostname)"
    else
      ask GAMES_DOMAIN "Games hostname (optional; Enter shares the sites hostname)"
    fi
    [[ "$GAMES_DOMAIN" != - ]] || GAMES_DOMAIN=""
  fi
fi
valid_domain() {
  local label labels=()
  [[ "$1" == localhost ]] && return 0
  [[ ${#1} -le 253 && "$1" =~ ^[a-zA-Z0-9.-]+$ && "$1" != *..* && "$1" != *. && "$1" == *.* ]] || return 1
  IFS=. read -r -a labels <<< "$1"
  for label in "${labels[@]}"; do
    [[ ${#label} -le 63 && "$label" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$ ]] || return 1
  done
}
for host in "$SITES_DOMAIN" "$GIT_DOMAIN" "$GAMES_DOMAIN"; do
  [[ -z "$host" ]] || valid_domain "$host" || die "Invalid hostname: $host (use a hostname without https:// or a path)"
done
SITES_DOMAIN="${SITES_DOMAIN,,}"
GIT_DOMAIN="${GIT_DOMAIN,,}"
GAMES_DOMAIN="${GAMES_DOMAIN,,}"
[[ "$GAMES_DOMAIN" != "$SITES_DOMAIN" ]] || GAMES_DOMAIN=""
[[ -z "$GIT_DOMAIN" || "$GIT_DOMAIN" != "$SITES_DOMAIN" ]] || die "Sites and repositories need different hostnames"
[[ -z "$GAMES_DOMAIN" || ( "$GAMES_DOMAIN" != "$SITES_DOMAIN" && "$GAMES_DOMAIN" != "$GIT_DOMAIN" ) ]] || die "Multiplayer needs its own hostname"

INVITE_URL=""
if (( ! SKIP_BOT )); then
  if [[ -z "$DISCORD_TOKEN" && -n "$PROMPT_FD" ]]; then
    say "Connect your Discord bot"
    printf 'Create a bot at https://discord.com/developers/applications\n'
    printf 'On its Bot page, enable Message Content Intent and copy the bot token.\n'
  fi
  [[ -n "$DISCORD_TOKEN" ]] || ask DISCORD_TOKEN "Discord bot token (Developer Portal > Bot > Reset Token)" 1
  [[ -n "$DISCORD_TOKEN" && "$DISCORD_TOKEN" =~ ^[a-zA-Z0-9._-]+$ ]] || die "A raw Discord bot token is required (without a Bot prefix)"
  discord_get() {
    printf 'header = "Authorization: Bot %s"\n' "$DISCORD_TOKEN" | \
      curl --config - --fail --silent --show-error --connect-timeout 10 --max-time 30 "https://discord.com/api/v10/$1"
  }
  say "Checking Discord credentials"
  application="$(discord_get oauth2/applications/@me)" || die "Discord rejected the token or could not be reached; no services have been started"
  discovered_id="$(jq -er '.id | select(type == "string" and test("^[0-9]{17,20}$"))' <<< "$application")" || die "Discord returned an invalid application response"
  [[ -z "$APP_ID" || "$APP_ID" == "$discovered_id" ]] || die "The application ID does not match this bot token"
  APP_ID="$discovered_id"
  # These flags indicate Message Content access for verified and smaller bots.
  flags="$(jq -er '(.flags // 0) | numbers' <<< "$application")" || die "Cannot read Discord application flags"
  if (( (flags & 786432) == 0 )); then
    die "Enable Message Content Intent at https://discord.com/developers/applications/$APP_ID/bot and rerun"
  fi
  [[ "$(jq -r '.interactions_endpoint_url // ""' <<< "$application")" == "" ]] || die "Clear Interactions Endpoint URL in the Discord Developer Portal; ThreadSite uses the Gateway"
  [[ "$(jq -r '.bot_require_code_grant // false' <<< "$application")" == false ]] || die "Disable Requires OAuth2 Code Grant on the Discord Bot page"
  ask GUILD_ID "Discord server ID (optional; blank registers global commands)"
  ask ADMIN_IDS "Extra admin user IDs, comma-separated (optional; Manage Server already grants access)"
  [[ -z "$GUILD_ID" || "$GUILD_ID" =~ ^[0-9]{17,20}$ ]] || die "Discord server ID must be a numeric server ID"
  [[ -z "$ADMIN_IDS" || "$ADMIN_IDS" =~ ^[0-9]{17,20}(,[0-9]{17,20})*$ ]] || die "Admin IDs must be numeric user IDs separated by commas"
  # View/send/history, links/files, create/manage/send threads, and pin messages.
  permissions=$(( (1<<10) | (1<<11) | (1<<14) | (1<<15) | (1<<16) | (1<<34) | (1<<35) | (1<<38) | (1<<51) ))
  INVITE_URL="https://discord.com/oauth2/authorize?client_id=$APP_ID&scope=bot%20applications.commands&permissions=$permissions&integration_type=0"
  [[ -z "$GUILD_ID" ]] || INVITE_URL+="&guild_id=$GUILD_ID&disable_guild_select=true"
  say "Discord invite (open this as a server administrator)"
  printf '%s\n' "$INVITE_URL"
  bot_installed() {
    if [[ -n "$GUILD_ID" ]]; then discord_get "guilds/$GUILD_ID" >/dev/null 2>&1
    else discord_get users/@me/guilds | jq -e 'type == "array" and length > 0' >/dev/null
    fi
  }
  if ! bot_installed; then
    answer=""
    ask answer "Invite the bot using the link above, then press Enter to check again"
    bot_installed || die "The bot cannot access a Discord server; finish the invite and rerun"
  fi
  [[ -n "$MODEL" ]] || MODEL="$(sed -n 's/^OPENCODE_DEFAULT_MODEL=//p' .env.example)"
  ask MODEL "Builder model (provider/model-id)"
  [[ "$MODEL" =~ ^[a-zA-Z0-9._-]+/[^[:space:]\'\"\`\$]+$ ]] || die "Model must use provider/model-id format"
  provider="${MODEL%%/*}"
  key_env=""
  case "$provider" in
    opencode) key_env=OPENCODE_API_KEY ;;
    openai) key_env=OPENAI_API_KEY ;;
    anthropic) key_env=ANTHROPIC_API_KEY ;;
    openrouter) key_env=OPENROUTER_API_KEY ;;
    google) key_env=GOOGLE_GENERATIVE_AI_API_KEY ;;
    surplus) ;;
    *) [[ -z "$API_KEY" ]] || die "Configure custom provider credentials in opencode/host/providers.json (see docs/deployment.md)" ;;
  esac
  if [[ -n "$key_env" ]]; then
    [[ -n "$API_KEY" ]] || API_KEY="${!key_env:-$(get_env "$key_env")}"
  fi
  host_config="$(get_env OPENCODE_HOST_CONFIG_DIR)"
  host_config="${host_config:-./opencode/host}/providers.json"
  if [[ "$provider" == surplus && -z "$API_KEY" && -f "$host_config" ]]; then
    API_KEY="$(jq -r '.providers.surplus.settings.apiKey // ""' "$host_config")"
  fi
  if [[ -n "$key_env" || "$provider" == surplus ]]; then
    [[ -n "$API_KEY" ]] || ask API_KEY "API key for $provider (blank only for anonymous opencode free models)" 1
    if [[ -z "$API_KEY" && ( "$provider" != opencode || "$MODEL" != *-free ) ]]; then
      die "An API key is required for $provider; supply --api-key-file or THREADSITE_API_KEY"
    fi
  fi
fi

# Reject values that cannot be represented consistently in both Compose's
# dotenv parser and bootstrap-forgejo.sh's shell environment.
for value in "$API_KEY" "$DISCORD_TOKEN" "$MODEL"; do
  [[ "$value" != *\'* && "$value" != *\\* && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "Installer settings cannot contain single quotes, backslashes or newlines"
done
if ! docker info >/dev/null 2>&1; then
  if command -v docker >/dev/null 2>&1; then die "Docker is installed but not usable; check the daemon and your Docker group membership"; fi
  answer=""
  if (( INSTALL_DOCKER )); then answer=y; else ask answer "Install Docker now? [y/N]"; fi
  [[ "$answer" == y || "$answer" == Y ]] || die "Install Docker or pass --install-docker"
  say "Installing Docker"
  # Download first so a failed download cannot be hidden by a successful shell.
  docker_installer="$(mktemp)"
  curl --fail --silent --show-error https://get.docker.com -o "$docker_installer"
  as_root sh "$docker_installer"
  rm -f -- "$docker_installer"
  docker info >/dev/null 2>&1 || die "Docker is not usable yet; check the daemon/group membership and rerun"
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"

say "Saving configuration"
bash ./scripts/setup.sh >/dev/null
chmod 600 .env
set_env() {
  local key="$1" value="$2" temporary line found=0
  temporary="$(mktemp .env.install.XXXXXX)"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$key="* ]]; then
      if (( ! found )); then printf "%s='%s'\n" "$key" "$value"; found=1; fi
    else printf '%s\n' "$line"
    fi
  done < .env > "$temporary"
  if (( ! found )); then printf "%s='%s'\n" "$key" "$value" >> "$temporary"; fi
  chmod 600 "$temporary"
  mv -- "$temporary" .env
}
set_env COMPOSE_PROFILES caddy
set_env SITES_DOMAIN "$SITES_DOMAIN"
set_env PUBLIC_SITES_BASE_URL "https://$SITES_DOMAIN"
if [[ -n "$GIT_DOMAIN" ]]; then
  set_env FORGEJO_PUBLIC_URL "https://$GIT_DOMAIN"
  set_env FORGEJO_DOMAIN "$GIT_DOMAIN"
fi
RELAY_DOMAIN="${GAMES_DOMAIN:-$SITES_DOMAIN}"
set_env GAMESERVER_PUBLIC_URL "wss://$RELAY_DOMAIN/ws"
set_env GAMESERVER_ALLOWED_ORIGINS "https://$SITES_DOMAIN"
password="$(get_env OPENCODE_SERVER_PASSWORD)"
if [[ -z "$password" || "$password" == change-this-internal-password ]]; then
  set_env OPENCODE_SERVER_PASSWORD "$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
fi
if (( ! SKIP_BOT )); then
  set_env DISCORD_BOT_TOKEN "$DISCORD_TOKEN"
  set_env DISCORD_APPLICATION_ID "$APP_ID"
  set_env DISCORD_GUILD_ID "$GUILD_ID"
  set_env DISCORD_ADMIN_USER_IDS "$ADMIN_IDS"
  set_env OPENCODE_DEFAULT_MODEL "$MODEL"
  if [[ -n "$API_KEY" && -n "$key_env" ]]; then set_env "$key_env" "$API_KEY"; fi
  if [[ "$provider" == surplus && -n "$API_KEY" ]]; then
    mkdir -p "$(dirname "$host_config")"
    [[ -f "$host_config" ]] || printf '{}\n' > "$host_config"
    export THREADSITE_INSTALL_PROVIDER_KEY="$API_KEY"
    temporary="$(mktemp "$(dirname "$host_config")/.providers.install.XXXXXX")"
    jq '.providers.surplus.settings.apiKey = env.THREADSITE_INSTALL_PROVIDER_KEY' "$host_config" > "$temporary"
    chmod 600 "$temporary"
    mv -- "$temporary" "$host_config"
    unset THREADSITE_INSTALL_PROVIDER_KEY
  fi
fi
mkdir -p caddy/vhosts
if [[ -n "$GIT_DOMAIN" ]]; then
  sed "s|git\.example\.com|$GIT_DOMAIN|g" caddy/vhosts/forgejo.caddy.example > caddy/vhosts/forgejo.caddy
fi
if [[ -n "$GAMES_DOMAIN" ]]; then
  sed -e "s|games\.example\.com|$GAMES_DOMAIN|g" -e "s|sites\.example\.com|$SITES_DOMAIN|g" caddy/vhosts/games.caddy.example > caddy/vhosts/games.caddy
elif [[ -f caddy/vhosts/games.caddy ]]; then
  rm -f -- caddy/vhosts/games.caddy
fi
export COMPOSE_PROFILES=caddy
# The saved values take precedence over stale exported configuration.
export -n SITES_DOMAIN DISCORD_BOT_TOKEN DISCORD_APPLICATION_ID DISCORD_GUILD_ID \
  DISCORD_ADMIN_USER_IDS OPENCODE_DEFAULT_MODEL OPENCODE_SERVER_PASSWORD \
  OPENCODE_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY OPENROUTER_API_KEY GOOGLE_GENERATIVE_AI_API_KEY
say "Building and starting services"
docker compose config --quiet
docker compose build
docker compose up -d --wait --wait-timeout "$WAIT_SECONDS" forgejo opencode preview gameserver caddy
bash ./scripts/bootstrap-forgejo.sh --no-restart-bot
if (( ! SKIP_BOT )); then
  say "Checking the selected model (no inference request)"
  docker compose run --rm --no-deps -T --entrypoint node bot --input-type=module - <<'CHECK_MODEL'
import { OpenCodeV2Harness as OpenCodeHarness } from './dist/opencode-v2.js';
const available = await new OpenCodeHarness().listSelectableModels();
if (!available.includes(process.env.OPENCODE_DEFAULT_MODEL)) {
  console.error('The selected model is unavailable. Check its ID and provider credentials, then rerun the installer.');
  process.exit(1);
}
process.exit(0);
CHECK_MODEL
  say "Starting the Discord bot"
  docker compose up -d --force-recreate --wait --wait-timeout "$WAIT_SECONDS" bot
  deadline=$((SECONDS + WAIT_SECONDS))
  until docker compose logs --no-color bot | grep 'INFO discord.ready' >/dev/null; do
    (( SECONDS < deadline )) || die "Discord did not connect before the timeout. Check: docker compose logs bot"
    sleep 2
  done
  say "Bot connected to Discord"
else
  say "Infrastructure is running; bot startup was skipped"
fi
printf 'Sites: https://%s\n' "$SITES_DOMAIN"
[[ -z "$GIT_DOMAIN" ]] || printf 'Source: https://%s\n' "$GIT_DOMAIN"
printf 'Multiplayer: wss://%s/ws\n' "$RELAY_DOMAIN"
[[ -z "$INVITE_URL" ]] || printf 'Discord invite: %s\n' "$INVITE_URL"
(( SKIP_BOT )) || printf 'Try /site start in a text channel.\n'
printf 'Forgejo admin password (if generated): secrets/forgejo-admin-password\n'
