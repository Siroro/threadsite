# Deployment

## Prerequisites

- Docker and Docker Compose
- Node 24 (service images use it; local test runs should match)
- A Discord application/bot token
- Either an existing host Apache (or Virtualmin) serving a static directory, or the bundled `httpd:2.4-alpine` profile

## Quick start

```bash
git clone <this repository>
cd threadsite
./scripts/setup.sh
$EDITOR .env
```

### 1. Discord app setup

Create a Discord application/bot and invite it with permissions to:

- View channels
- Send messages
- Create public threads
- Send messages in threads
- Embed Links (recommended for live progress cards; a text fallback is automatic)
- Read message history
- Use application commands

Enable the **Message Content Intent** in the Discord developer portal — ordinary replies inside a registered thread are the edit prompts.

Copy the bot token and application/client ID into `.env`. For development, set `DISCORD_GUILD_ID` so slash-command changes appear immediately in that guild; leave it blank for global commands.

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

## LLM credentials

Two supported paths:

1. **Preferred for unattended deployments**: set a provider environment variable in `.env`, such as `OPENCODE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or `SURPLUS_API_KEY`. The default project configuration uses `opencode/hy3-free`.
2. **Convenience**: as a Discord server admin, run `/site-admin token provider:<id> token:<secret>`. The response is ephemeral and the bot never echoes the token; it is stored in the agent platform's persistent auth volume. For Surplus, the provider ID is `surplus`.

The second path still sends the secret through Discord's interaction infrastructure; for higher-assurance deployments use `.env`/Docker secrets instead.

### Surplus Intelligence provider

Surplus Intelligence is wired into the agent platform as the custom provider ID `surplus` via its [OI]-compatible provider adapter. Canonical API base URL: `https://api.surplusintelligence.ai/v1`.

```dotenv
SURPLUS_API_KEY=inf_your_key_here
SURPLUS_BASE_URL=https://api.surplusintelligence.ai/v1
```

When the agent container starts, its startup script calls the public Surplus `GET /v1/models`, keeps tool-capable (or capability-unspecified) models, and carries context/output limits and advertised image-input support into the generated provider config. Discovery also runs when the key is stored through `/site-admin token`. `SURPLUS_MODELS` is a comma-separated fallback/extra list, useful when a newly-added model is not returned by discovery yet.

```text
/site-admin model model:surplus/glm-4.7
/site-admin model model:surplus/gpt-5.5
```

If `SURPLUS_API_KEY` is set in the environment, that key is placed in the generated provider configuration and should be treated as the authoritative credential. `SURPLUS_CONTEXT_CAP` (default 100000, `0` disables) caps the context window advertised for Surplus models so long threads compact early.

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

Every publish stamps a `threadsite-version.json` deploy marker into the site root and appends a tiny update-checker to every published page: the checker re-fetches the marker every 30 seconds (and on tab focus), and when the live deploy id differs from the one the page was served with, the page reloads itself — hidden tabs immediately, visible tabs behind a one-second "New version available — updating…" notice. Republishing an unchanged site produces the same id, so nobody is reloaded for nothing.

If Cloudflare or another CDN fronts the sites hostname, set its **Browser Cache TTL** to **Respect Existing Headers** — a fixed CDN default overrides the origin's revalidation policy and visitors keep stale assets for hours after a republish.

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

The root-level `start.sh` pulls the latest code, safely resets tracked files (`.env`, `secrets/`, and `data/` are untracked and untouched — never run `git clean` in this repo), rebuilds and recreates only the containers whose code changed, brings the stack up, and waits for services to report healthy:

```bash
./start.sh                 # update to latest main, rebuild, up, wait healthy
./start.sh --no-update     # start the current code without touching git
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

For a bot-only change with dependencies already running: `docker compose up -d --build --no-deps bot`. Rebuild other affected services when shared configuration or dependencies change. Preserve `data/`, secrets, persistent volumes, and live project workspaces — never use volume deletion or destructive resets as routine troubleshooting.

## Security notes

This is suitable for a private/friends Discord or a carefully permissioned server. It is not a hardened multi-tenant website builder.

- Generated browser JS is untrusted content. Use a dedicated origin/domain.
- The multiplayer relay is a shared, unauthenticated relay: any browser that can reach it can join any room code in any game. It rate-limits and size-caps every connection, but treat rooms as public spaces — generated games are told to treat all received events as untrusted input. Use `GAMESERVER_ALLOWED_ORIGINS` on hostile networks and never put secrets into game traffic.
- Do not mount Docker's socket into the bot or agent containers.
- Do not mount your whole Apache config or document tree if only one generated-sites directory is needed.
- The agent service is intentionally not published as a host port in Compose and has HTTP basic auth even on the internal Docker network.
- The agent has no shell/network/external-directory permission and can only edit `site/**`.
- Git credentials exist only in the bot container and are supplied to `git push` via `GIT_ASKPASS`; the model/agent container never receives the Forgejo token. The human Forgejo admin password is not mounted into the bot container.
- A failed validation or git push leaves the previously published website in place.
- Site limits are controlled with `MAX_SITE_BYTES`, `MAX_SITE_FILES`, and `MAX_PROMPT_CHARS`.
