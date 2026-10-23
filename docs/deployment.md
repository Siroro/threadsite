# Deployment

For a new server, use the [Caddy quickstart](#caddy-quickstart). If you already run a web server or hosting panel, see [existing server setup](#existing-server-setup).

## Prerequisites

- A Linux server
- Domain names pointing at the server for public hosting
- A Discord bot token and application ID
- Docker and Docker Compose (the quickstart can install these)

You only need Node 24 on the host for local development. The containers include it.

## Caddy quickstart

**Recommended for new servers.** The installer collects your settings, builds the services, sets up HTTPS and waits for the bot to connect to Discord.

First, [create a Discord bot](discord.md) and enable Message Content Intent. Point `sites.example.com`, `git.example.com` and `games.example.com` at your server, and make ports 80 and 443 reachable. Replace `example.com` below with your domain:

```bash
curl -fsSL https://raw.githubusercontent.com/Siroro/threadsite/main/scripts/caddy-quickstart.sh | bash -s -- \
  --domain example.com \
  --install-docker
```

The prompts work even when the script is piped into Bash. You can also download it and run it directly:

```bash
curl -fsSL https://raw.githubusercontent.com/Siroro/threadsite/main/scripts/caddy-quickstart.sh -o threadsite-setup.sh
bash threadsite-setup.sh --domain example.com --install-docker
```

It asks for:

- Your Discord bot token. Input is hidden, and the application ID is discovered automatically.
- A server ID for commands in one server, or a blank value for global commands. It prints an invite link and checks that the bot has joined a server.
- Optional extra admin user IDs. People with Manage Server already have admin access.
- The builder model and its provider key. The default comes from `.env.example`; anonymous OpenCode free models can be used without a key when available.

For OpenCode, OpenAI, Anthropic, OpenRouter and Google, the key is saved to the matching setting in `.env`. Surplus credentials are saved in the private `opencode/host/providers.json`, preserving other provider settings. Custom providers can be configured there before running the installer.

Secrets are stored in private files, and the internal OpenCode password is generated on first setup. The installer checks Discord credentials and intents before starting services, bootstraps Forgejo, checks that the selected model is available, then starts the bot and waits for `discord.ready`. The model check does not send an inference request or verify provider billing and quota.

The installer uses `scripts/bootstrap-forgejo.sh --no-restart-bot` so the bot starts after these checks. Running that script without the flag keeps its usual behavior of restarting an existing bot after refreshing its repository credentials.

### Running it again

Saved settings are reused, including credentials. The script rebuilds the services and recreates the bot so configuration changes take effect. It keeps existing projects, provider settings, volumes and private files. An existing checkout is reused without fetching or resetting Git; use `./start.sh` when you want to update the code.

A failed credential check stops before services start. If a later startup check fails, the saved configuration stays available for a retry. Use `--skip-bot` only when you deliberately want infrastructure without a working Discord bot.

### Unattended setup

Supply secrets through environment variables or private files to keep them out of shell history. The bot must already be invited and Message Content Intent must be enabled:

```bash
bash scripts/caddy-quickstart.sh \
  --domain example.com \
  --discord-token-file /path/to/discord-token \
  --guild-id 123456789012345678 \
  --model provider/model-id \
  --api-key-file /path/to/provider-key \
  --install-docker \
  --non-interactive
```

| Option | Purpose |
| --- | --- |
| `--domain` | Sets up `sites.`, `git.` and `games.` under this domain |
| `--sites-domain`, `--git-domain`, `--games-domain` | Choose individual hostnames instead; all three are needed for a public bot install |
| `--discord-token`, `--discord-token-file` | Bot token; also accepts `DISCORD_BOT_TOKEN` |
| `--app-id` | Optional application ID; checked against the token when provided |
| `--guild-id` | Optional Discord server ID for server-specific commands |
| `--admin-ids` | Optional comma-separated user IDs for extra admins |
| `--model` | Builder model in `provider/model-id` format |
| `--api-key`, `--api-key-file` | Provider key; also accepts `THREADSITE_API_KEY` or the provider's standard environment variable |
| `--install-docker` | Install Docker and missing Git, curl and jq tools |
| `--non-interactive` | Fail on missing settings instead of prompting |
| `--wait-seconds` | Service and Discord readiness timeout; default 180 seconds |
| `--skip-bot` | Infrastructure only; skips Discord and model checks |

### Manual Caddy setup

```bash
# .env
COMPOSE_PROFILES=caddy
SITES_DOMAIN=sites.example.com
PUBLIC_SITES_BASE_URL=https://sites.example.com

# Optional vhosts: copy and edit the tracked templates
cp caddy/vhosts/forgejo.caddy.example caddy/vhosts/forgejo.caddy
cp caddy/vhosts/games.caddy.example   caddy/vhosts/games.caddy

docker compose up -d forgejo opencode preview gameserver caddy
./scripts/bootstrap-forgejo.sh
docker compose up -d bot
```

How it fits together:

- `caddy/Caddyfile` (tracked) serves the publish root read-only with the same cache policy as [the Apache vhost](#serving-generated-sites-from-your-own-apache): versioned (`?v=`) assets immutable, everything else revalidating, `threadsite-version.json` never cached.
- `caddy/vhosts/*.caddy` (untracked, generated) add the optional Forgejo and relay vhosts; empty `vhosts/` is valid.
- Certificates live in the `caddy-data` volume and survive restarts; `CADDY_HTTP_PORT`/`CADDY_HTTPS_PORT` move the host ports, though 80/443 are required for certificate issuance.
- `SITES_DOMAIN=localhost` (the default) uses Caddy's internal certificate. `https://localhost` works locally with an expected browser warning.
- Day-2 operations are unchanged: `./start.sh` picks the profile up from `COMPOSE_PROFILES` in `.env`.

## Existing server setup

Use this route if you already have a web server or hosting panel and want to configure ThreadSite yourself:

```bash
git clone https://github.com/Siroro/threadsite.git
cd threadsite
./scripts/setup.sh
$EDITOR .env
```

### 1. Discord app setup

Follow the [Discord setup guide](discord.md) to create the bot, enable Message Content Intent and invite it with the right permissions. Put its token in `DISCORD_BOT_TOKEN` and its application ID in `DISCORD_APPLICATION_ID` in `.env`. The guide also explains the optional server ID and how to check the connection.

### 2. Start the agent service, Forgejo, and the relay

```bash
docker compose up -d forgejo opencode gameserver
./scripts/bootstrap-forgejo.sh
```

The bootstrap script creates two accounts when needed:

- a human Forgejo administrator from `FORGEJO_ADMIN_USER`; if `FORGEJO_ADMIN_PASSWORD` is blank, a generated password is written to `secrets/forgejo-admin-password`, and
- a **non-admin** service user from `FORGEJO_OWNER`, with a fresh API token written mode `0600` to `secrets/forgejo-token`. Only that token file is mounted into the Discord bot.

Forgejo registration is disabled. The service account owns the generated public repositories but cannot administer the instance. The automatic bootstrap assumes `FORGEJO_OWNER_TYPE=user`; if you set it to `org`, create the organization yourself and give the service account permission to create repositories in it.

### 3. Start the Discord bot

With your host Apache:

```bash
docker compose up -d bot
```

Or run the entire stack with the bundled static Apache on port 8080:

```bash
docker compose --profile bundled-static up -d
```

Then open:

- Forgejo: `http://localhost:3000` by default
- Generated-site index: `http://localhost:8080` with the bundled profile

The publish root gets an automatically generated `index.html` listing all ready sites and their source repos.

## OpenCode providers and credentials

Two supported paths:

1. **Preferred for unattended deployments**: configure credentials in the private host provider JSON described below. Built-in providers also accept standard `.env` keys such as `OPENCODE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `OPENROUTER_API_KEY`. The default project configuration uses `opencode/hy3-free`.
2. **Convenience**: as a Discord server admin, run `/site-admin token provider:<id> token:<secret>`. The response is ephemeral and the bot never echoes the token; it is stored in the agent platform's persistent auth volume. For Surplus, the provider ID is `surplus`.

The second path still sends the secret through Discord's interaction infrastructure. Host files and environment variables keep credentials outside Discord.

### Host provider configuration

ThreadSite uses OpenCode 2's native `providers` format, documented in [OpenCode providers](https://opencode.ai/v2/docs/providers/). Add built-in provider overrides or custom providers without changing the image or the bot:

1. Copy `opencode/host/providers.example.json` to `opencode/host/providers.json` and edit it. The example shows Surplus; replace or extend the `providers` map for your host. With no file, the bundled policy and Surplus catalog fetcher still work.
2. For optional extra provider environment variables, copy `.env.opencode.example` to `.env.opencode`. Standard variables explicitly forwarded in Compose, including `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`, still belong in `.env` and take precedence over this extra file. Surplus can be configured entirely in JSON.
3. Select a configured model using `OPENCODE_DEFAULT_MODEL=provider/model-id` or `/site-admin model`; subagent and browser QA models remain independently configurable.

`OPENCODE_HOST_CONFIG_DIR` changes the host directory mounted read-only at `/etc/threadsite/opencode`. `OPENCODE_ENV_FILE` changes the optional extra environment-file path. The local defaults are Git-ignored, excluded from the OpenCode build context and outside generated workspaces. Restart OpenCode after changing `providers.json`; recreate it after changing environment variables. Provider overrides cannot replace ThreadSite's agents, permissions, plugins or publication policy.

For example, a custom compatible provider with explicit prices and conservative text-only capabilities:

```json
{
  "providers": {
    "acme": {
      "name": "Host gateway",
      "package": "@ai-sdk/openai-compatible",
      "env": ["ACME_API_KEY"],
      "settings": { "baseURL": "https://llm.example.com/v1" },
      "models": {
        "coding-model": {
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
          "limit": { "context": 100000, "output": 8192 },
          "cost": { "input": 2, "output": 6, "cache": { "read": 0.5, "write": 2 } }
        }
      }
    }
  }
}
```

Put `ACME_API_KEY=...` in `.env.opencode`, or store the credential via `/site-admin token provider:acme`. The prices above are illustrative: use your provider's actual USD per million tokens. Native `settings`, `headers`, `body`, model aliases (`modelID`), variants and tiered `cost` arrays are passed through. Strings can reference `{env:VARIABLE}` or `{file:/etc/threadsite/opencode/key-file}`; keep key files in the mounted host directory and use absolute container paths. An explicit `settings.apiKey` takes precedence over stored credentials.

### Context caps for any provider or model

Add a `contextCaps` map to `opencode/host/providers.json`. It applies to built-in OpenCode models and custom/discovered models, including paid models, without requiring a `providers` or `catalogs` entry:

```json
{
  "contextCaps": {
    "openai": 100000,
    "anthropic": 100000,
    "surplus": 100000,
    "surplus/deepseek-v4.1-flash": 64000
  }
}
```

Provider keys cap all of that provider's models. Full `provider/model-id` keys override the provider cap for that model, including model IDs containing slashes. Values are non-negative integer token counts: `0` removes that host cap, while omission retains a bundled default if one exists. Surplus defaults to 100000; other providers have no bundled cap. This selection is explicit and applies equally to paid and free models; prices and usage accounting are unchanged.

The native plugin applies caps across OpenCode's resolved model catalog, including models never listed in the host file. It lowers context and any larger input ceiling while retaining smaller native windows and the output limit. Native auto-compaction and the bot's context meter use the capped window. Compaction reserves headroom (the bundled buffer is 20000 tokens), so its trigger is below the cap; very small caps leave little room for work. Existing `providers.<id>.models.<model>.limit` overrides remain supported, with host caps taking precedence over larger explicit limits. Legacy `catalogs.<id>.contextCap` also remains supported as an additional discovery-time ceiling; set it to `0` when moving entirely to `contextCaps`.

### Model discovery and accounting

Add a `catalogs` entry for any configured OpenAI-compatible provider to refresh its `GET <settings.baseURL>/models` at startup:

```json
{ "catalogs": { "acme": {} }, "contextCaps": { "acme": 100000 } }
```

This is an optional ThreadSite extension alongside the native `providers` map. Catalog requests use the configured headers and `settings.apiKey`, or the first populated variable from `env`. They do not read OpenCode's saved credential store; public catalogs such as Surplus work with saved credentials. Configured models remain available if discovery fails. Discovery excludes entries that explicitly lack tool support, carries context/output limits and advertised image input, and adds reasoning-effort variants. Configured models without declared/discovered image input default to text-only, including when overriding a built-in model; add image capability only when the route supports it. Set a catalog to `false` to disable discovery for that provider (including Surplus); independent `contextCaps` still apply.

Catalog `pricing.prompt`, `pricing.completion`, `pricing.input_cache_read` and `pricing.input_cache_write` values are interpreted as USD per token and converted to native OpenCode USD per million token costs. Explicit model configuration overrides discovered values. Discovery does not guess prices or image capability from model names.

OpenCode calculates request cost using its model pricing, and the bot records native usage from both live events and persisted history. Input, output, reasoning, cache, child-agent and failed-turn usage continue into the durable ledger and `/site-admin usage`; overlapping live/history records are reconciled. Providers that omit token counts remain unavailable. Models without pricing may report $0, which is not evidence that the provider is free; add explicit model costs when discovery or the built-in catalog lacks prices.

### Surplus Intelligence provider

Surplus remains the custom provider ID `surplus`, with its public model fetcher enabled by default. It uses the shared provider/catalog loader; it does not depend on OpenCode's built-in model library. The bundled `opencode/providers.json` contains its endpoint, fallback model map and context cap. Override them in the private `opencode/host/providers.json`:

```json
{
  "providers": {
    "surplus": {
      "settings": {
        "apiKey": "your-surplus-key",
        "baseURL": "https://api.surplusintelligence.ai/v1"
      },
      "models": { "glm-4.7": {}, "gpt-5.5": {} }
    }
  },
  "catalogs": { "surplus": {} },
  "contextCaps": { "surplus": 100000 }
}
```

When the agent container starts, its startup script calls the public Surplus `GET /v1/models`, keeps tool-capable (or capability-unspecified) models, and carries prices, context/output limits and advertised image-input support into the generated provider config. Discovery also runs when the key is stored through `/site-admin token`; omit `settings.apiKey` to use that stored credential. The `models` map adds fallback/extra entries, useful when a newly-added model is not returned by discovery yet.

```text
/site-admin model model:surplus/glm-4.7
/site-admin model model:surplus/gpt-5.5
```

Surplus environment settings are no longer read. Move existing credentials into `providers.surplus.settings.apiKey` (or use a `{file:...}` reference), endpoint overrides into `settings.baseURL`, extra model IDs into `models`, and the context ceiling into `contextCaps.surplus`. The ceiling defaults to 100000 tokens; `0` disables it. Host JSON overrides take precedence over bundled JSON defaults. Catalog pricing is imported when advertised, and host model costs can supply missing prices.

## Serving generated sites from your own Apache

A minimal separate-origin vhost is included at `apache/threadsite-vhost.conf.example`:

```apache
<VirtualHost *:443>
    ServerName sites.example.com
    DocumentRoot /var/www/sites

    <Directory /var/www/sites>
        Options -Indexes -ExecCGI
        AllowOverride None
        Require all granted
    </Directory>
</VirtualHost>
```

`AllowOverride None` is recommended even though ThreadSite rejects dotfiles. Do not enable PHP/CGI handlers in this vhost.

`SITES_HOST_PATH` is bind-mounted into the bot container at `/srv/sites`. Point it at the exact directory your host Apache serves at `PUBLIC_SITES_BASE_URL`.

### Cache headers

Add cache headers so republished sites reach returning visitors immediately (full copy with comments in the example file): HTML always revalidates, assets carrying the `?v=<hash>` ThreadSite appends on publish cache immutably, and any asset requested without a version revalidates instead of pinning an old copy.

```apache
<FilesMatch "\.(?:css|js|mjs)$">
    Header set Cache-Control "public, max-age=31536000, immutable" "expr=%{QUERY_STRING} =~ /^v=[0-9a-f]{10}$/"
    Header set Cache-Control "no-cache" "expr=%{QUERY_STRING} !~ /^v=/"
</FilesMatch>
<FilesMatch "\.html?$">
    Header set Cache-Control "no-cache"
</FilesMatch>
<FilesMatch "^threadsite-version\.json$">
    Header set Cache-Control "no-store"
</FilesMatch>
```

Every publish stamps a `threadsite-version.json` deploy marker into the site root and appends a tiny update-checker to every published page: the checker re-fetches the marker every 30 seconds (and on tab focus), and when the live deploy id differs from the one the page was served with, the page reloads itself. Hidden tabs reload immediately; visible tabs show an update notice for one second first. Republishing an unchanged site produces the same id, so nobody is reloaded for nothing.

If Cloudflare or another CDN fronts the sites hostname, set its **Browser Cache TTL** to **Respect Existing Headers**. A fixed CDN default overrides the origin's revalidation policy and visitors keep stale assets for hours after a republish.

If Apache runs as a non-root user, it only needs read access to generated files. The bot container writes the bind-mounted directory; published files use ordinary readable modes.

## Forgejo behind Virtualmin / Apache

Set the external URL independently from the internal Docker URL:

```dotenv
FORGEJO_PUBLIC_URL=https://git.example.com
FORGEJO_DOMAIN=git.example.com
FORGEJO_INTERNAL_URL=http://forgejo:3000
FORGEJO_PORT=3000
```

The bundled Compose file publishes Forgejo on `127.0.0.1:3000` only. Host Apache/Virtualmin should proxy `https://git.example.com/` to `http://127.0.0.1:3000/`, while containers continue to use `http://forgejo:3000`. Forgejo receives an explicit HTTPS `ROOT_URL` and an internal HTTP `LOCAL_ROOT_URL`.

In Virtualmin, use the directives from `apache/forgejo-virtualmin.conf.example` in the **HTTPS (`*:443`) virtual host** for the git hostname. If Virtualmin's "Proxy Website" feature already generated a `ProxyPass`, edit/replace that rule rather than adding a second competing one. The proxy must own the entire `/` path; `/assets/` must not fall through to the virtual server's `public_html`.

```apache
ProxyPreserveHost On
ProxyRequests Off
AllowEncodedSlashes NoDecode
RequestHeader set X-Forwarded-Proto "https"
RequestHeader set X-Forwarded-Port "443"
ProxyPass / http://127.0.0.1:3000/ nocanon
ProxyPassReverse / http://127.0.0.1:3000/
```

Enable the required modules once on Debian/Ubuntu hosts:

```bash
sudo a2enmod proxy proxy_http headers
sudo systemctl reload apache2
```

After recreating Forgejo and reloading Apache, verify both the root page and an actual generated JS asset:

```bash
./scripts/check-forgejo-proxy.sh
```

If the script reports that `http://127.0.0.1:3000/` works but the public asset fails, the problem is in the Virtualmin HTTPS vhost, not the Forgejo container.

Browser/source links use `FORGEJO_PUBLIC_URL`; API calls and git pushes from the bot use the internal URL. To use an already-existing external Forgejo instead of the bundled one, set both URLs to that service and put an access token in `FORGEJO_TOKEN` (or mount one at `FORGEJO_TOKEN_FILE`); you can then omit the bundled Forgejo service.

## Day-2 operations with start.sh

The root-level `start.sh` pulls the latest code, safely resets tracked files (`.env`, `secrets/`, and `data/` are untracked and untouched; never run `git clean` in this repo), rebuilds images when the code commit, `docker-compose.yml` or `.env` build args differ from the last successful build recorded under `data/`, brings the stack up, prunes the dangling images a rebuild strands, and waits for services to report healthy. A failed or interrupted build leaves no stamp, so the next start rebuilds it instead of reusing a stale image; the same applies after a manual `git pull`. `--no-update` skips Git but always checks builds through Docker's layer cache (an unchanged service is a cached no-op, never a rebuild); `restart` only restarts existing containers.

```bash
./start.sh                 # update to latest main, rebuild, up, wait healthy
./start.sh --no-update     # rebuild/start the current code without touching git
./start.sh --force         # update, discarding local edits to tracked files
./start.sh status          # service health overview
./start.sh logs [service]  # follow logs (default: bot)
./start.sh restart [svc]   # restart one service or the whole stack
./start.sh stop            # stop the stack (containers, data and .env kept)
./start.sh projects        # list projects with thread IDs and repositories
./start.sh games           # list registered games
./start.sh cleanup         # preview and remove selected projects interactively
```

This repository is **main-only**: every update force-checks out `origin/main`, sets its upstream, and removes stale local branches. `scripts/deploy.sh` does just the update+rebuild part.

### Updating pinned versions

The project intentionally pins the agent platform/SDK versions together in `opencode/Dockerfile` and `bot/package.json`. When updating one, update the other and rebuild:

```bash
docker compose build --pull opencode bot
docker compose up -d opencode bot
```

The multiplayer relay pins `ws` in `gameserver/package.json`; rebuild it with `docker compose build --pull gameserver` when bumping. Forgejo is pinned to the `15-rootless` LTS major tag by default; override `FORGEJO_IMAGE` to follow the current short-lived stable line.

For a bot-only change with dependencies already running: `docker compose up -d --build --no-deps bot`. Rebuild other affected services when shared configuration or dependencies change. Preserve `data/`, secrets, persistent volumes, and live project workspaces. Never use volume deletion or destructive resets as routine troubleshooting.

## Security notes

This is suitable for a private/friends Discord or a carefully permissioned server. It is not a hardened multi-tenant website builder.

- Generated browser JS is untrusted content. Use a dedicated origin/domain.
- The multiplayer relay is a shared, unauthenticated relay: any browser that can reach it can join any room code in any game. It rate-limits and size-caps every connection, but treat rooms as public spaces. Generated games are told to treat all received events as untrusted input. Use `GAMESERVER_ALLOWED_ORIGINS` on hostile networks and never put secrets into game traffic.
- Do not mount Docker's socket into the bot or agent containers.
- Do not mount your whole Apache config or document tree if only one generated-sites directory is needed.
- The agent service is intentionally not published as a host port in Compose and has HTTP basic auth even on the internal Docker network.
- The agent has no shell/network/external-directory permission and can only edit `site/**`.
- Git credentials exist only in the bot container and are supplied to `git push` via `GIT_ASKPASS`; the model/agent container never receives the Forgejo token. The human Forgejo admin password is not mounted into the bot container.
- A failed validation or git push leaves the previously published website in place.
- Site limits are controlled with `MAX_SITE_BYTES`, `MAX_SITE_FILES`, and `MAX_PROMPT_CHARS`.
