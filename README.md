# ThreadSite — Discord threads that become persistent websites & multiplayer games

ThreadSite is a small Discord harness for an AI coding agent. One Discord thread maps to one persistent static website **or static web game** and one public Forgejo repository.

Live turn cards show an active-subagent count while delegated work is running; child actions and reports stay out of the activity feed.

Projects default to **anyone can edit**. The human thread owner can use **Collaboration** on the pinned card or `/site collaboration` to select contributors or require approval of outside requests. Approval requests and their attachments survive restarts without starting agent work. See [collaboration settings](docs/commands.md#project-collaboration).

- `/site start prompt:"..."` creates a Discord thread, a workspace, an agent session, a public Forgejo repository, the first git commit, and a live static site.
- `/makegam dimension:<2d|3d> multiplayer:<arena|rooms|singleplayer> prompt:"..."` does the same for a **static browser game**. Games default to a shared-arena architecture; `rooms` builds invite-code rooms; `singleplayer` provisions no networking. `/site multiplayer` switches an existing game between the three live.

## How it works

The one deliberate runtime exception is the **harness-owned multiplayer relay**: the model never writes server code, it only uses a vendored browser client pointed at a shared multi-tenant WebSocket relay. Games stay fully playable solo when the relay is unreachable.

Networked games can also use harness-managed personal save slots and public best-score leaderboards through `net.saves` and `net.leaderboards`. Anonymous player progress survives browser sessions and relay restarts; saves use revision checks to prevent stale tabs overwriting newer progress. Scores are client-reported. See [player persistence](docs/multiplayer.md#personal-saves-and-leaderboards).

See [docs/architecture.md](docs/architecture.md) for the full pipeline, agent sandboxing, transport recovery, and persistence model.

## Public gallery

The static gallery includes search, 2D/3D/website and multiplayer filters, sorting, grid/list layouts, saved favourites, recently opened projects, shareable project details, play instructions and recent changes. It supports light/dark themes, keyboard navigation and a random-project picker. Favourites and history stay in the visitor's browser; direct project links also work without JavaScript. See [gallery behaviour and checks](docs/gallery.md).

## Stack

- Node 24 + discord.js bot
- Native OpenCode v2 + `@opencode/client`
- One shared Node 24 + `ws` multiplayer relay for all games (multi-tenant, with arena snapshots and SQLite player storage)
- Forgejo 15 LTS (SQLite, no separate database needed)
- Your existing Apache static directory (the default), an optional bundled `httpd:2.4-alpine` profile, or an optional Caddy edge with automatic HTTPS
- Playwright MCP preview service (CPU-rendered Chromium, no GPU required)

### Fresh server

Point DNS for your hostnames at the server, then:

```bash
curl -fsSL https://raw.githubusercontent.com/Siroro/threadsite/main/scripts/caddy-quickstart.sh | bash -s -- \
  --sites-domain sites.example.com \
  --git-domain git.example.com \
  --games-domain games.example.com \
  --install-docker
```

That installs Docker on request, clones this repository, writes `.env` (prompting for the Discord token/application ID when run interactively), creates the Caddy vhosts, brings the stack up behind Caddy with automatic HTTPS, and bootstraps Forgejo. Re-running is safe. All flags: [docs/deployment.md](docs/deployment.md#caddy-quickstart).

Running operations go through the root `start.sh` (update/rebuild/health/logs), which also exposes the project cleanup menu. Startup rebuilds only when image inputs changed since the last successful build (code, compose file, or `.env`) and prunes the dangling images a rebuild strands; `--no-update` always re-checks builds through Docker's layer cache. Proxying recipes for host Apache/Virtualmin and Cloudflare (sites vhost, cache headers, Forgejo, relay) are in [docs/deployment.md](docs/deployment.md) and [docs/multiplayer.md](docs/multiplayer.md).

## Configuration

All settings live in `.env` (see `.env.example` for the complete annotated list).

### Discord

| Setting | Purpose |
| --- | --- |
| `DISCORD_BOT_TOKEN` / `DISCORD_APPLICATION_ID` | Bot credentials |
| `DISCORD_GUILD_ID` | Register commands in one guild (dev); blank = global |
| `DISCORD_ADMIN_USER_IDS` | Extra admin user IDs (Manage Server is the default gate) |
| `DISCORD_ERROR_REPORT_USER_IDS` | Recipients of private error DMs |
| `PROGRESS_UPDATE_MS` | Minimum interval between live progress-card edits |
| `TURN_STALL_WARN_MS` | No-agent-activity duration before the card shows a stall warning |

### Agent service

| Setting | Purpose |
| --- | --- |
| `OPENCODE_URL` / `OPENCODE_SERVER_PASSWORD` | Internal agent service endpoint and basic auth password (username `opencode`) |
| `OPENCODE_DEFAULT_MODEL` | Model for new sessions (`provider/model-id`); changeable live via `/site-admin model` |
| `OPENCODE_SUBAGENT_MODEL` | V2 model for both general and explore subagents (`provider/model-id`); blank keeps `opencode/mimo-v2.6-flash-free`. Recreate opencode after changes. |
| `OPENCODE_BROWSER_QA_MODEL` | Dedicated v2 `browser-qa` vision model (`provider/model-id`); blank disables it. Browser-only, advisory inspection; supports background work while the builder continues. Independent of builder/general/explore models. |
| `OPENCODE_MAX_STEPS` | Builder step budget per turn (default 200); mandatory finish-up steer at 90%. Recreate bot and opencode after changes. |
| `CONTEXT7_ENABLED` / `CONTEXT7_API_KEY` | V2 library documentation MCP: enabled by default (`1`); set `0` to disable. Optional API key raises rate limits. Recreate opencode after changes. |
| `OPENCODE_RECONCILE_TIMEOUT_MS` / `OPENCODE_RECONCILE_POLL_MS` | Transport-failure recovery window and poll interval |
| `OPENCODE_QUOTA_BLOCK_MIN_RETRY_MS` | Retry delay that classifies as exhausted quota instead of backoff |
| `OPENCODE_FAILOVER_MODELS` | Backup models for quota blocks and persistent upstream errors; turns retry once on the first healthy entry. Changeable live via `/site-admin failover` |
| `OPENCODE_BLIP_NUDGES` | Quick same-model retries for transient upstream errors (5xx/overloaded/429) before failing or failing over (default 2; 0 disables) |
| `SESSION_IDLE_RESET_MS` / `SESSION_CONTEXT_COMPACT_THRESHOLD` | Fresh session after idle; auto-compaction threshold |
| `OPENCODE_API_KEY` and other provider keys | Provider credentials (or store later via `/site-admin token`) |

### Surplus Intelligence (optional provider)

| Setting | Purpose |
| --- | --- |
| `SURPLUS_API_KEY` / `SURPLUS_BASE_URL` | Buyer key and API base (`https://api.surplusintelligence.ai/v1`) |
| `SURPLUS_MODELS` | Comma-separated fallback/extra model IDs merged with live discovery |
| `SURPLUS_CONTEXT_CAP` | Context ceiling advertised for Surplus models (default 100000, `0` disables) |

### Forgejo

| Setting | Purpose |
| --- | --- |
| `FORGEJO_PUBLIC_URL` / `FORGEJO_DOMAIN` | Public browser/source URL |
| `FORGEJO_INTERNAL_URL` / `FORGEJO_PORT` | URL used by containers and the bot |
| `FORGEJO_OWNER` / `FORGEJO_ADMIN_USER` / `FORGEJO_ADMIN_PASSWORD` | Service account and admin bootstrap |
| `FORGEJO_WEBHOOK_ALLOWED_HOSTS` | Hosts Forgejo may call for push webhooks (default `bot`) |
| `EXTERNAL_PUSH_POLL_MS` / `WEBHOOK_ENABLED` | External-push detection fallback polling |

### Sites and publication

| Setting | Purpose |
| --- | --- |
| `SITES_HOST_PATH` | Host directory served by Apache, bind-mounted into the bot |
| `PUBLIC_SITES_BASE_URL` | Public base URL of the generated sites |
| `COMPOSE_PROFILES` / `SITES_DOMAIN` | Activate the optional Caddy edge (`caddy`) and its public hostname with automatic HTTPS |
| `MAX_SITE_BYTES` / `MAX_SITE_FILES` / `MAX_PROMPT_CHARS` | Publication and prompt limits |
| `COMMIT_BOT_NAME` / `COMMIT_BOT_EMAIL` | Committer identity for harness-made commits |

### Multiplayer relay

| Setting | Purpose |
| --- | --- |
| `MULTIPLAYER_ENABLED` | Provision netcode into new game projects |
| `GAMESERVER_PUBLIC_URL` / `GAMESERVER_INTERNAL_URL` / `GAMESERVER_PORT` | Relay endpoints |
| `GAMESERVER_ALLOWED_ORIGINS` | Browser origin allowlist (blank = any) |
| `GAMESERVER_MAX_PEERS_PER_ROOM` / `GAMESERVER_MAX_ROOMS_PER_GAME` | Tenancy caps |
| `GAMESERVER_RATE_PER_SECOND` / `GAMESERVER_RATE_BURST` | Per-connection rate limits |
| `GAMESERVER_ROOM_TTL_MS` / `GAMESERVER_HOST_STALL_MS` | Empty-room GC and host-stall authority loss |
| `GAMESERVER_STATE_DIR` / `GAMESERVER_PERSIST_INTERVAL_MS` | Arena snapshot persistence |
| `GAMESERVER_MAX_SAVED_PLAYERS_PER_GAME` / `GAMESERVER_MAX_SAVE_BYTES_PER_GAME` | Personal save and leaderboard capacity; stored under `GAMESERVER_STATE_DIR` |

### Preview service

| Setting | Purpose |
| --- | --- |
| `PREVIEW_CPUS` / `PREVIEW_MEMORY` | CPU render throughput and memory (main perf knobs) |
| `PREVIEW_BUILD_CONCURRENCY` / `PREVIEW_SNAPSHOT_CACHE` | Concurrent in-memory builds / cached builds |
| `BROWSER_QA_ENABLED` / `BROWSER_QA_TIMEOUT_MS` | Disable or bound the post-build browser QA pass |

## Documentation

- [docs/commands.md](docs/commands.md) — Discord workflow, all `/site`, `/makegam`, and `/site-admin` commands, live progress cards, repo push keys
- [docs/architecture.md](docs/architecture.md) — pipeline, static-only boundary, harness build, preview/browser QA, transport recovery, persistence
- [docs/multiplayer.md](docs/multiplayer.md) — relay architecture, multiplayer protocol, relay configuration and proxying
- [docs/gallery.md](docs/gallery.md) — gallery discovery, public metadata, local collections and browser checks
- [docs/deployment.md](docs/deployment.md) — full deployment walkthrough, one-command Caddy quickstart, Apache/Cloudflare proxying, cache headers, `start.sh`, security notes
- [docs/maintenance.md](docs/maintenance.md) — project cleanup, regression checks, integration tests
- [docs/opencode-v2.md](docs/opencode-v2.md) — v2 runtime, scripted integration checks and a live free-model throughput test
