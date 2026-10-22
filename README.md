# ThreadSite — Discord threads that become persistent websites & multiplayer games

ThreadSite is a small Discord harness for an AI coding agent. One Discord thread maps to one persistent static website **or static web game** and one public Forgejo repository.

- `/site start prompt:"..."` creates a Discord thread, a workspace, an agent session, a public Forgejo repository, the first git commit, and a live static site.
- `/makegam dimension:<2d|3d> multiplayer:<arena|rooms|singleplayer> prompt:"..."` does the same for a **static browser game**. Games default to a shared-arena architecture; `rooms` builds invite-code rooms; `singleplayer` provisions no networking. `/site multiplayer` switches an existing game between the three live.
- Every normal message in a registered thread becomes the next mutation of the same site. **Reply while a turn runs to steer it live.** When the agent asks a question mid-turn, the requester gets pinged: quick buttons for simple choices, select menus for longer lists, and a multi-question answer form with drafts, custom answers and retry-safe delivery.
- The harness validates the result, commits and **pushes git first**, and only then publishes to Apache. A failed push or validation does not replace the previously published site. Each publish stamps a content-derived deploy id into the site; pages reload themselves when a newer deploy goes live.
- All project cards use **Discord Components V2**: a pinned project front page with a screenshot thumbnail and request forms, a compact live Turn panel whose full plan, files, usage, history and the model's raw thinking open in private paginated detail panels, and a separate Play/Open card with a full-width screenshot. Buttons, selects and modals keep project links, Stop, answers and commit details at hand, and stay working on old turns. Pinned cards refresh after turns and at startup.
- Naming survives restarts: a failed title model is replaced by another available model, with a readable fallback if models are unavailable. The Discord title, Forgejo repo and links must synchronize before the next builder turn. Final repo names use the project slug without temporary `site-`/`game-` prefixes; old links redirect.

The result is a public gallery (`index.html` at the publish root) listing every ready site and its source repository.

## How it works

The model never runs builds, shell, or git. Projects are authored in **TypeScript under `site/src/`**; the harness runs the only esbuild bundle before every publish, validates the static tree, and enforces publication boundaries (no symlinks, dotfiles, or server-executable files; size caps). Game engines (three.js + Rapier for 3D, Excalibur for 2D) are installed by the harness like dependencies and type-checked against their real declarations.

2D games default to native-size rendering with HiDPI support, adapting the camera and layout on resize instead of stretching a low-resolution canvas. Pixel-art assets use nearest-neighbor filtering and integer zoom for crisp pixels.

The one deliberate runtime exception is the **harness-owned multiplayer relay**: the model never writes server code, it only uses a vendored browser client pointed at a shared multi-tenant WebSocket relay. Games stay fully playable solo when the relay is unreachable.

A `preview` service gives vision models Playwright MCP browser access — screenshots, clicks, console/network diagnostics — against an in-memory build of the current source. Text-only models receive no browser MCP tools; the harness still runs its advisory browser QA pass after each build and supplies diagnostics to subsequent turns.

At 90% of `OPENCODE_MAX_STEPS` (normally 180/200), the bot sends a mandatory finish-up steer to the running task. It asks the agent to complete current edits, run required checks, update todos and summarize. See [docs/agent-turns.md](docs/agent-turns.md) for step tracking, browser permissions and game-design guidance.

See [docs/architecture.md](docs/architecture.md) for the full pipeline, agent sandboxing, transport recovery, and persistence model.

## Stack

- Node 24 + discord.js bot
- OpenCode agent server + `@opencode-ai/sdk`
- One shared Node 24 + `ws` multiplayer relay for all games (multi-tenant, in-memory)
- Forgejo 15 LTS (SQLite, no separate database needed)
- Your existing Apache static directory, or an optional bundled `httpd:2.4-alpine` profile
- Playwright MCP preview service (CPU-rendered Chromium, no GPU required)

## Deployment

```bash
./scripts/setup.sh
$EDITOR .env

# Discord app: create the bot, invite it (permissions listed in docs/deployment.md),
# enable Message Content Intent, put the token/ID in .env.

docker compose up -d forgejo opencode gameserver
./scripts/bootstrap-forgejo.sh   # creates Forgejo admin + service account/token

docker compose up -d bot         # with your host Apache
# or the whole stack with bundled static Apache on :8080:
docker compose --profile bundled-static up -d
```

Day-2 operations go through the root `start.sh` (update/rebuild/health/logs), which also exposes the project cleanup menu. Proxying recipes for host Apache/Virtualmin and Cloudflare (sites vhost, cache headers, Forgejo, relay) are in [docs/deployment.md](docs/deployment.md) and [docs/multiplayer.md](docs/multiplayer.md).

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
| `OPENCODE_URL` / `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` | Internal agent service endpoint and basic auth |
| `OPENCODE_DEFAULT_MODEL` | Model for new sessions (`provider/model-id`); changeable live via `/site-admin model` |
| `OPENCODE_MAX_STEPS` | Builder step budget per turn (default 200); mandatory finish-up steer at 90%. Recreate bot and opencode after changes. |
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
- [docs/deployment.md](docs/deployment.md) — full deployment walkthrough, Apache/Cloudflare proxying, cache headers, `start.sh`, security notes
- [docs/maintenance.md](docs/maintenance.md) — project cleanup, regression checks, integration tests
