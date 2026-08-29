# ThreadSite V2.3 — Discord threads that become persistent websites & multiplayer games

ThreadSite is a small Discord harness for an AI coding agent. One Discord thread maps to one persistent static website **or static web game** and one public Forgejo repository.

- `/site start prompt:"..."` in a text channel creates a Discord thread, a workspace, an agent session, a public Forgejo repository, the first git commit, and a live static site.
- `/makegam dimension:<2d|3d> prompt:"..."` does the same for a **static browser game** and writes a mode-specific `AGENTS.md` before the agent session starts.
- Every game is built **multiplayer-first**: the harness provides one shared multi-tenant WebSocket relay, a documented wire protocol (ThreadSite Multiplayer Protocol v1), and a vendored browser client, so games get rooms, live sync, and host migration with zero server code and zero per-game instances (see below).
- Every normal message in that registered thread becomes the next mutation of the same site.
- The harness validates the result, commits and **pushes git first**, and only then publishes it to Apache. A failed push does not replace the previously published site.
- `/site-admin model` changes the model globally for the next turn in every thread.
- `/site-admin token` stores/replaces a provider API token in the agent platform's own persistent auth storage. The bot does not write the LLM token to its state file.
- `/site info` shows the live URL, source repository, model, and last error.
- `/site republish` republishes the current static tree without spending model tokens.
- `/site compact` asks the agent to compact this thread's session context immediately (see below).
- `/site revert` undoes the last accepted turn: it reverts the agent conversation, resets git to the previous commit, force-pushes the repository, and republishes the previous site.
- The publish root also gets an automatically generated `index.html` listing all ready sites and their source repos.

## V2.1 transport recovery

V2.1 fixes a failure mode where the Discord bot can lose its HTTP/streaming connection to the agent service while the agent server and model turn continue running normally.

Before each prompt the harness snapshots the persisted agent message IDs. If the synchronous SDK request fails with a transport-shaped error such as `fetch failed`, `ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`, or an Undici socket error, ThreadSite now:

1. does **not** immediately classify the event as a provider failure;
2. reconnects the agent event stream when possible;
3. polls the session's persisted message history and status;
4. identifies a new terminal `sitebuilder` assistant message that was not present in the pre-prompt snapshot;
5. resumes validation/git/publishing from that persisted result without re-sending the user prompt;
6. only emits a private incident if it can prove the turn failed or recovery itself fails.

ThreadSite intentionally does not blindly retry the prompt after an ambiguous transport failure, because doing so could create duplicate model turns. The agent platform's status map is used only as supporting state; a persisted completed assistant message wins even if the status endpoint temporarily remains `busy`.

The recovery window defaults to 30 minutes and can be adjusted with:

```dotenv
OPENCODE_RECONCILE_TIMEOUT_MS=1800000
OPENCODE_RECONCILE_POLL_MS=1500
```

If the recovery window expires while the agent service still reports the session busy, ThreadSite attempts an HTTP session abort. If that abort cannot be confirmed, it preserves the worktree instead of resetting files underneath a potentially still-running agent.

V2.1 also recursively serializes `Error.cause` into the private JSONL log and administrator DMs. Docker warn/error log lines are emitted as JSON strings so nested causes such as `ECONNRESET`, `UND_ERR_SOCKET`, DNS, TLS, or timeout information are not collapsed to Node's `[Object]` display.

## Why static-only

This harness intentionally does **not** let the model run `npm install`, shell commands, git, or server code. Games are also static web deliverables: HTML/CSS/browser JavaScript/assets only, with no Node or game server at runtime. The agent platform is configured so the `sitebuilder` agent can edit `site/**` and inspect the workspace, while shell, external directories, arbitrary web fetching, subagents, LSP, skills, and questions are denied. `websearch` is explicitly allowed, and media downloads go through a guarded `asset_download` tool.

The one deliberate runtime exception is the **harness-owned multiplayer relay**: the model never writes server code, it only uses the vendored browser client (`site/js/threadsite-net.js`) pointed at the shared relay whose URL and game id the harness injects. The relay is part of the infrastructure, not part of any generated deliverable, and games must stay fully playable solo when it is unreachable.

The bot then applies a second publication boundary: `site/index.html` is required; symlinks, dotfiles (including `.htaccess`), and non-static/server-executable file extensions are rejected; total files and bytes are capped. This makes it a much better fit for an existing Apache static host than running arbitrary model-generated build scripts.

This is still user-generated HTML/JS. **Serve generated sites from a separate origin such as `sites.example.com`, not the same origin that carries sensitive login cookies or admin apps.** Browser JavaScript can be hostile even when the filesystem side is static-only.

## Stack

- Node 22 + discord.js bot
- OpenCode agent server (the internal `opencode` service) + `@opencode-ai/sdk`
- One shared Node 22 + `ws` multiplayer relay for all games (multi-tenant, in-memory)
- Forgejo 15 LTS by default (SQLite, no separate database needed)
- Your existing Apache static directory, or an optional bundled `httpd:2.4-alpine` profile

The agent SDK supports a headless client/server integration and explicit per-message model selection. Provider credentials can also be persisted through its auth service.

## 1. Discord app setup

Create a Discord application/bot and invite it with permissions to:

- View channels
- Send messages
- Create public threads
- Send messages in threads
- Read message history
- Use application commands

Enable the **Message Content Intent** in the Discord developer portal. ThreadSite needs it because ordinary replies inside a registered site thread are the edit prompts.

Copy the bot token and application/client ID into `.env`.

For development, set `DISCORD_GUILD_ID` so slash-command changes appear immediately in that guild. Leave it blank for global commands.

## 2. Configure

```bash
./scripts/setup.sh
$EDITOR .env
```

Important values:

```dotenv
DISCORD_BOT_TOKEN=...
DISCORD_APPLICATION_ID=...

# Current default: the free Hy3 model.
OPENCODE_DEFAULT_MODEL=opencode/hy3-free

# Optional Surplus Intelligence marketplace access.
SURPLUS_API_KEY=
SURPLUS_BASE_URL=https://api.surplusintelligence.ai/v1
SURPLUS_MODELS=claude-opus-4.8,claude-sonnet-4.6,gpt-5.5,glm-4.7

FORGEJO_PUBLIC_URL=https://git.example.com
FORGEJO_DOMAIN=git.example.com
FORGEJO_INTERNAL_URL=http://forgejo:3000
FORGEJO_OWNER=sitebot
FORGEJO_ADMIN_USER=forgeadmin
# `admin` is reserved by Forgejo; leave this as forgeadmin or choose another normal username.
# Leave blank to have bootstrap generate secrets/forgejo-admin-password
FORGEJO_ADMIN_PASSWORD=

# Existing host Apache example:
SITES_HOST_PATH=/var/www/sites
PUBLIC_SITES_BASE_URL=https://sites.example.com
```

`SITES_HOST_PATH` is bind-mounted into the bot container at `/srv/sites`. Point it at the exact directory your host Apache serves at `PUBLIC_SITES_BASE_URL`.

If you do not have Apache already, leave the defaults and use the bundled static profile later.

### LLM credentials

There are two supported paths:

1. Preferred for unattended deployments: set a provider environment variable in `.env`, such as `OPENCODE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or `SURPLUS_API_KEY`. The default project configuration uses `opencode/hy3-free`.
2. Convenience: as a Discord server admin, run `/site-admin token provider:<id> token:<secret>`. The response is ephemeral and the bot never echoes the token It is stored in the agent platform's persistent auth volume. For Surplus, the provider ID is `surplus`.

The second path still sends the secret through Discord's interaction infrastructure. For higher-assurance deployments, use `.env`/Docker secrets instead.

### Surplus Intelligence provider

Surplus Intelligence is wired into the agent platform as the custom provider ID `surplus` using its OpenAI-compatible provider adapter. The canonical API base URL is:

```text
https://api.surplusintelligence.ai/v1
```

Set a buyer key in `.env` when you want to use it:

```dotenv
SURPLUS_API_KEY=inf_your_key_here
SURPLUS_BASE_URL=https://api.surplusintelligence.ai/v1
```

When the agent container starts with `SURPLUS_API_KEY` set, its startup script calls Surplus `GET /v1/models`, keeps tool-capable (or capability-unspecified) models suitable for an agent, and carries context/output limits through when the catalog provides them, and merges that live catalog into the generated provider config. `SURPLUS_MODELS` is a comma-separated fallback/extra list and is useful when a newly-added model is not returned by discovery yet.

Examples:

```text
/site-admin model model:surplus/glm-4.7
/site-admin model model:surplus/claude-sonnet-4.6
/site-admin model model:surplus/gpt-5.5
```

You can also leave `SURPLUS_API_KEY` blank and store a key later with:

```text
/site-admin token provider:surplus token:inf_...
```

In that mode the agent platform uses the fallback IDs from `SURPLUS_MODELS`; if you want another model ID, add it to `SURPLUS_MODELS` and recreate the agent container. If `SURPLUS_API_KEY` is set in the environment, that environment key is explicitly placed in the generated provider configuration and therefore should be treated as the authoritative Surplus credential.

## 3. Start the agent service and Forgejo, then bootstrap the Forgejo bot user

```bash
docker compose up -d forgejo opencode gameserver
./scripts/bootstrap-forgejo.sh
```

The bootstrap script creates two accounts when needed:

- a human Forgejo administrator from `FORGEJO_ADMIN_USER`; if `FORGEJO_ADMIN_PASSWORD` is blank, a generated password is written to `secrets/forgejo-admin-password`, and
- a **non-admin** service user from `FORGEJO_OWNER`, with a fresh API token written mode `0600` to `secrets/forgejo-token`. Only that token file is mounted into the Discord bot.

Forgejo registration is disabled. The service account owns the generated public repositories but cannot administer the Forgejo instance.

The automatic bootstrap assumes `FORGEJO_OWNER_TYPE=user`. If you set `FORGEJO_OWNER_TYPE=org`, create that organization yourself and give the service account permission to create repositories in it.

## 4. Start the Discord bot

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

## Discord workflow

In a normal text channel, create a site:

```text
/site start prompt: make a deeply unserious 1998 fan site for capybaras name: Capybara Internet
```

Or create a static web game:

```text
/makegam dimension:2d prompt: make a frantic top-down capybara delivery game with combo scoring name: Capybara Courier
```

```text
/makegam dimension:3d prompt: make a tiny low-poly hovercraft obstacle course with checkpoints name: Hover Yard
```

`dimension` is the first `/makegam` option and is restricted to `2d` or `3d`. The harness stores that project type, creates a matching `AGENTS.md`, and wraps the first model request in a matching game-generation prompt. The game must still publish as ordinary static web files under `site/`; subsequent normal thread messages keep the same 2D/3D rules.

The bot creates a new public thread. Inside the created thread, just talk to the site or game:

```text
make everything Comic Sans and add a fake visitor counter
```

```text
add a leaderboard for the top 10 capybaras
```

```text
now make the visual design look like a financial terminal without losing the jokes
```

### Live progress during a turn

While the model works, the thread's status message is edited in place with a compact rolling view:

- a short tail of the last few activity lines (tool use, web research, asset downloads, file edits, retries, compaction), newest at the bottom, including the current todo item (`🗺️ 3/7 — add particle effects`),
- a summary line of what the model is currently narrating (`💭 Refactoring player controls and collision logic…`), condensed from the streamed text,
- a small subtext line with session context usage (`🧠 context 62.4k / 100k · this turn 19.5k tok · compacted 2×`), where the ceiling is the model's advertised context window (including the Surplus cap), `this turn … tok` counts the tokens generated while handling the current Discord request (it is not a number of turns), and the compaction count is session-lifetime.

The edit cadence is unchanged (`PROGRESS_UPDATE_MS`); streaming text is only re-rendered on that cadence, not per token. When the turn finishes, the final status message keeps up to ~1600 characters of the agent's own summary, using most of Discord's 2000-character message allowance.

### AI-generated thread titles

When `/site start` or `/makegam` creates a new thread and no explicit `name` option was given, the thread starts with the usual prompt slug and a parallel tiny `titler` agent session generates a concise 3–6 word title from the request. If the first build succeeds, the AI title is adopted end-to-end: the Discord thread is renamed **and** the Forgejo repository and the published directory are renamed to match, keeping the unique thread-id suffix (so `Sumo Shove` becomes repo `site-sumo-shove-abc123` and `https://…/sumo-shove-abc123/`). The old published directory is removed and Forgejo leaves a redirect from the old repo name; if any rename step fails, the original slug simply stays. If title generation fails or times out, the slug name remains everywhere.

### `/site compact` and `/site revert`

- `/site compact` requests on-demand compaction for the thread's session using the model the session last used (or the globally configured model). Useful after very long threads even with automatic compaction. The published site is untouched.
- `/site revert` undoes the prior turn end-to-end: the agent conversation is reverted to before the last request (the model will not remember the undone turn), the workspace is reset to the previous commit, the commit is force-pushed away from the public Forgejo repository, and the previously published site is restored. If the last turn had failed before publishing, only its conversation is removed and git is left alone. Reverting below the initial creation commit is refused.

Each accepted message does this:

```text
Discord thread message
  -> same persistent agent session + same workspace
  -> load persistent project AGENTS.md when present (2D/3D game + multiplayer rules)
  -> harness re-checks the multiplayer client/config files
  -> edit site/** only
  -> validate static tree
  -> bot writes README metadata
  -> git commit --allow-empty
  -> git push to public Forgejo
  -> atomically replace the published Apache directory
  -> refresh the public all-sites index
```

The git commit is deliberately performed by the harness rather than by the model. Commits read like real history: the subject is the Discord request itself (truncated to one line), the **author** is the Discord user who sent it (display name, with a `@username@users.noreply.discord.com` noreply email), and the bot is the committer plus a `Co-authored-by:` trailer — `ThreadBot` by default, configurable with `COMMIT_BOT_NAME`/`COMMIT_BOT_EMAIL` (set the email to the Forgejo service account's address to link its avatar in Forgejo).

### `/makegam` game profiles

Both profiles are deliberately **static-web only** and go through the same validation, git-push-first, and Apache publication boundary as normal sites. Both are also built **multiplayer-first** through the shared relay (see the next section): the agent gets the vendored net client, this game's tenant config, and the full sync guide in its `AGENTS.md`.

- **2D**: prefers Canvas 2D for action games, with DOM/SVG also allowed for board/puzzle/UI-heavy games. Its `AGENTS.md` asks for responsive controls, game states, scoring/progression, collision discipline, frame-rate-independent animation, and lightweight game feel.
- **3D**: requires a genuine 3D play space using WebGL/browser-side rendering. It forbids npm/Vite/webpack/build pipelines, asks for conservative geometry/effects, camera and input guidance, and a visible fallback when WebGL or an optional pinned CDN module cannot initialize.

The generated `AGENTS.md` is committed to the public project repository but is outside `site/`, so the agent can read it but cannot edit it under the supplied permissions. The agent platform discovers project-root `AGENTS.md` files as persistent project instructions.

## Multiplayer games — one shared multi-tenant relay

Every game ThreadSite generates is built **multiplayer-first**. The harness runs a single `gameserver` container for the whole deployment; there is no per-game instance, process, or provisioning step. Multi-tenancy is addressed by two ids the harness controls:

- **game id** — the published site slug, injected into each game as its tenant key;
- **room code** — a short code (for example `AB3CK`) namespaced *per game*, so the same code in two games is two different rooms.

A single relay therefore serves any number of games and any number of rooms per game, bounded only by configured caps.

### What the harness injects into every game project

On creation — and re-checked before every mutation, in case the agent removed them:

- `site/js/threadsite-net.js` — a vendored, zero-dependency browser client for the protocol (connect/reconnect, room join, peer roster, host flag, snapshots, events, RTT).
- `site/js/net-config.js` — harness-owned config: `export const NET_CONFIG = Object.freeze({ protocol, game, url })`.
- the `AGENTS.md` multiplayer section — the full protocol reference, the recommended **peer-owned-state** sync model (every player simulates their own entity locally and broadcasts it at 10–20 Hz, so controls never route through a host; interactions are events the target applies to itself; shared-world entities get a single owner), the host-authoritative alternative for shared-physics games, host-migration notes, untrusted-input validation rules, and the required lobby/room-code/offline-fallback UX. Agents are told to design **multiplayer-first**, treating solo play as the same game with one player.

The first-turn prompt and the `sitebuilder` agent configuration both reinforce this: use the provided client, never write server code, and never invent other runtime network endpoints.

### ThreadSite Multiplayer Protocol (summary)

JSON text frames over one WebSocket per player:

- client → relay: `join` (game/room/create/name), `pstate` (publish **your own** player's state — no host round trip), `event` (broadcast or `to` a peer), `state` (publish a shared-world room snapshot), `state-req`, `ping`;
- relay → client: `welcome` (your id, room code, peers with their latest player states, host, newest room snapshot for late joiners), `peer-join`/`peer-leave` (with automatic **host migration** to the oldest remaining peer), relayed `pstate`/`event`/`state`/`state-req`, `pong`, `error`, `bye`.

The relay stores only the newest room snapshot and each peer's newest player state (in memory) and hands them to late joiners; it never interprets game state.

### Operating the relay

```dotenv
MULTIPLAYER_ENABLED=true
GAMESERVER_PUBLIC_URL=ws://localhost:8090/ws
GAMESERVER_INTERNAL_URL=http://gameserver:8090
GAMESERVER_PORT=8090
GAMESERVER_MAX_PEERS_PER_ROOM=16
GAMESERVER_MAX_ROOMS_PER_GAME=256
GAMESERVER_MAX_MESSAGE_BYTES=65536
GAMESERVER_RATE_PER_SECOND=60
GAMESERVER_RATE_BURST=120
GAMESERVER_ROOM_TTL_MS=600000
GAMESERVER_ALLOWED_ORIGINS=
```

- The bundled/local default `ws://localhost:8090/ws` works out of the box next to the bundled static Apache profile.
- For production behind host Apache, proxy `wss://games.example.com/ws` using `apache/gameserver-vhost.conf.example`, set `GAMESERVER_PUBLIC_URL` to that URL, and optionally lock browsers down with `GAMESERVER_ALLOWED_ORIGINS=https://sites.example.com`.
- `./scripts/check-gameserver-proxy.sh` verifies both legs: the internal health endpoint and a real WebSocket upgrade through the public URL.
- Cloudflare's proxy (orange cloud) works for the relay: WebSockets are supported on every plan, and the net client's 10-second heartbeat keeps connections alive below Cloudflare's idle cutoff. Requirements: SSL/TLS mode **Full (strict)** — Flexible terminates at port 80 and never reaches the `/ws` directives in the HTTPS vhost — and the public URL must use standard port 443 (Cloudflare does not proxy port 8090). Proxied hostnames also complicate Let's Encrypt HTTP-01 renewal; use a bypass rule for `/.well-known/acme-challenge/*`, DNS-01 validation via the Cloudflare API, or a Cloudflare Origin CA certificate. `./scripts/check-gameserver-proxy.sh` verifies the handshake through Cloudflare unchanged.

### Relay behind Virtualmin / Apache

Same drill as the Forgejo vhost, for a new hostname such as `games.siroro.co.uk`:

1. Point DNS for the hostname at the host box and create a matching Virtualmin virtual server with a Let's Encrypt certificate. The relay container is published on `127.0.0.1:8090` only, so browsers can only reach it through this proxy.
2. Enable the modules once: `sudo a2enmod proxy proxy_http proxy_wstunnel headers && sudo systemctl reload apache2`.
3. In the virtual server's **HTTPS (`*:443`) virtual host** (Webmin → Servers → Apache Webserver → Edit Directives), add the directives from `apache/gameserver-vhost.conf.example`:

   ```apache
   ProxyPreserveHost On
   ProxyRequests Off
   RequestHeader set X-Forwarded-Proto "https"
   ProxyPass /ws ws://127.0.0.1:8090/ws
   ProxyPassReverse /ws ws://127.0.0.1:8090/ws
   <Location "/">
       Require all denied
   </Location>
   <Location "/ws">
       Require all granted
   </Location>
   ```

   Do **not** use Virtualmin's "Proxy Website" feature for this host — it generates a blanket `ProxyPass /` that would shadow the `/ws` route and expose `/health` and `/stats`. If it is already enabled, disable it and use the directives above instead.
4. Set in `.env` and recreate the relay:

   ```dotenv
   GAMESERVER_PUBLIC_URL=wss://games.siroro.co.uk/ws
   GAMESERVER_ALLOWED_ORIGINS=https://sites.siroro.co.uk
   ```

   `GAMESERVER_ALLOWED_ORIGINS` is a comma-separated list of browser origins (scheme + host, no path) — normally just your `PUBLIC_SITES_BASE_URL` origin. Leave it blank to allow any origin.
5. Verify with `./scripts/check-gameserver-proxy.sh`; it reports the internal health check and the public WebSocket upgrade separately, so a failure tells you whether to look at Docker or at the vhost.
- `GET /health` and `GET /stats` on the relay return games/rooms/clients counts; `/site-admin status` shows a one-line summary.
- Every connection is token-bucket rate-limited, frames are size-capped, rooms have peer caps, and empty rooms are garbage-collected after `GAMESERVER_ROOM_TTL_MS`.
- Room state is in-memory only: a relay restart clears rooms. Games recover through the client's auto-reconnect plus snapshot resync, or fall back to solo play — by design, not data loss worth paging anyone over.

Set `MULTIPLAYER_ENABLED=false` to stop provisioning multiplayer files and rules into new game projects (existing published games keep working against the relay if it still runs).

## Admin commands

`/site-admin status` shows the active model, agent-service health, web/asset status, multiplayer relay health, private-error recipient count, and log path.

`/site-admin model model:provider/model-id` changes the model for all future turns, including existing site threads. Use `default` to go back to the platform's default selection.

`/site-admin token provider:anthropic token:...` replaces the persisted provider credential. `/site-admin token-clear` removes it.

The command is registered with Discord's **Manage Server** default permission and is also runtime-checked. `DISCORD_ADMIN_USER_IDS` can add explicit user IDs. Detailed failure DMs go only to `DISCORD_ERROR_REPORT_USER_IDS` (or the explicit admin-ID list when the error list is left blank). `/site-admin errors` is additionally restricted to those configured private error recipients, so other server managers do not get provider diagnostics.

## Existing Apache configuration

A minimal separate-origin vhost is included at `apache/threadsite-vhost.conf.example` and looks like:

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

If Apache runs as a non-root user, it only needs read access to generated files. The bot container writes the bind-mounted directory; the published files use ordinary readable modes inherited from the generated workspace.

## Forgejo behind Virtualmin / Apache

Set the external URL independently from the internal Docker URL, and set the bare public hostname separately:

```dotenv
FORGEJO_PUBLIC_URL=https://git.example.com
FORGEJO_DOMAIN=git.example.com
FORGEJO_INTERNAL_URL=http://forgejo:3000
FORGEJO_PORT=3000
```

The bundled Compose file deliberately publishes Forgejo as `127.0.0.1:3000`, not on every host interface. Host Apache/Virtualmin should therefore proxy `https://git.example.com/` to `http://127.0.0.1:3000/`, while containers continue to use `http://forgejo:3000`. Forgejo receives an explicit HTTPS `ROOT_URL` and an internal HTTP `LOCAL_ROOT_URL`.

For the current `git.siroro.co.uk` deployment, use:

```dotenv
FORGEJO_PUBLIC_URL=https://git.siroro.co.uk
FORGEJO_DOMAIN=git.siroro.co.uk
FORGEJO_INTERNAL_URL=http://forgejo:3000
FORGEJO_PORT=3000
```

In Virtualmin, use the directives from `apache/forgejo-virtualmin.conf.example` in the **HTTPS (`*:443`) virtual host** for the git hostname. If Virtualmin's “Proxy Website” feature already generated a `ProxyPass`, edit/replace that rule rather than adding a second competing `ProxyPass`. The important part is that the proxy owns the entire `/` path; `/assets/` must not fall through to the virtual server's `public_html` directory. The resulting proxy section is:

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

After recreating Forgejo and reloading Apache, verify both the root page and its actual generated JS asset with:

```bash
./scripts/check-forgejo-proxy.sh
```

If the script reports that `http://127.0.0.1:3000/` works but the public asset fails, the problem is still in the Virtualmin HTTPS vhost rather than the Forgejo container.

The browser/source links use `FORGEJO_PUBLIC_URL`; API calls and git pushes from the bot use the internal URL.

To use an already-existing external Forgejo instead of the bundled one, set both URLs to that service and put an access token in `FORGEJO_TOKEN` (or mount a token at `FORGEJO_TOKEN_FILE`). You can then omit/start only the services you want.

## Long-running sessions and automatic compaction

Automatic compaction is explicitly enabled in the agent platform's config (`opencode/opencode.json`). The pinned V1-compatible configuration keeps a recent context tail, reserves headroom before the model window fills, and prunes stale tool output:

```json
"compaction": {
  "auto": true,
  "prune": true,
  "preserve_recent_tokens": 15000,
  "reserved": 20000
}
```

The agent platform decides a session is "full" (and therefore when auto-compaction fires) against each model's advertised `limit.context`. For Surplus models, ThreadSite caps that advertised window with `SURPLUS_CONTEXT_CAP` (default **100000** tokens; `0` disables the cap), so long Discord threads compact early instead of growing into huge provider windows. This is a context-management ceiling, not a provider-side billing limit:

```dotenv
SURPLUS_CONTEXT_CAP=100000
```

Project files plus `AGENTS.md` remain the durable source of truth, so after compaction the agent simply re-reads the workspace. When the agent service emits `session.compacted`, the Discord progress message briefly reports **Context compacted — continuing automatically** and the event is written to the private log.

## Persistence and recovery

- Discord thread -> project/session mappings live in `data/bot/state.json`.
- Project git worktrees live in `data/workspaces/<guild>/<thread>`.
- Published sites live at `SITES_HOST_PATH`.
- Agent auth/session state is in the `opencode-data` Docker volume.
- Forgejo data is in the `forgejo-data` Docker volume.
- Multiplayer rooms are intentionally **not persisted**: they live only in the relay's memory and clear on restart; games resync or fall back to solo play.

If a session ID disappears but the workspace remains, the bot detects a not-found error, creates a new agent session against the same files, updates its mapping, and retries the message. The site state therefore lives primarily in the files/git history, not only in model conversation memory.

## V2.1.1 downloader behavior

`asset_download` no longer filters by filename extension or HTTP Content-Type. The agent may locally vendor arbitrary public HTTP(S) files beneath `site/assets/` (for example `.js`, JSON/data, shaders, uncommon model formats, archives, or extensionless resources). SSRF/private-network blocking, path containment, redirect limits, timeouts, and `ASSET_MAX_BYTES` remain enforced.

Publication also accepts arbitrary static extensions now, but still blocks obvious server-executable formats such as PHP, CGI, shell/server scripts. This matters because the final tree is served by your host Apache rather than merely existing inside the agent container.

## Security notes

This is suitable for a private/friends Discord or a carefully permissioned server. It is not a hardened multi-tenant website builder.

- Generated browser JS is untrusted content. Use a dedicated origin/domain.
- The multiplayer relay is a shared, unauthenticated relay: any browser that can reach it can join any room code in any game. It rate-limits and size-caps every connection, but treat rooms as public spaces — generated games are told to treat all received events as untrusted input. Use `GAMESERVER_ALLOWED_ORIGINS` on hostile networks, and do not put secrets into game traffic.
- Do not mount Docker's socket into the bot or agent containers.
- Do not mount your whole Apache config or document tree if only one generated-sites directory is needed.
- The agent service is intentionally not published as a host port in Compose.
- The agent server has HTTP basic auth even on the internal Docker network.
- The agent has no shell/network/external-directory permission and can only edit `site/**`.
- Git credentials exist only in the bot container and are supplied to `git push` via `GIT_ASKPASS`; the model/agent container never receives the Forgejo token. The human Forgejo admin password is not mounted into the bot container.
- A failed validation or git push leaves the previous published website in place.
- Site limits are controlled with `MAX_SITE_BYTES`, `MAX_SITE_FILES`, and `MAX_PROMPT_CHARS`.

## Updating pinned versions

The project intentionally pins the agent platform/SDK versions together in `opencode/Dockerfile` and `bot/package.json`. When updating one, update the other and rebuild:

```bash
docker compose build --pull opencode bot
docker compose up -d opencode bot
```

The multiplayer relay pins `ws` in `gameserver/package.json`; rebuild it with `docker compose build --pull gameserver` when bumping.

Forgejo is pinned to the `15-rootless` LTS major tag by default so patch releases arrive without silently crossing a major upgrade boundary. Override `FORGEJO_IMAGE` if you prefer the current short-lived stable line.
