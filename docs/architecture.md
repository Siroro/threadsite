# Architecture

How ThreadSite turns a Discord thread into a persistent static site or game.

## The core loop

One registered Discord thread owns one project: an agent session, a workspace, a git repository, and a published site. Every normal message in the thread becomes the next mutation of that project.

Each accepted message runs through this pipeline:

```text
Discord thread message
  -> same persistent agent session + same workspace
  -> load persistent project AGENTS.md (2D/3D game + multiplayer rules)
  -> harness re-checks net client, engine packages, and engine skill
  -> agent edits site/** only (TypeScript under site/src/)
  -> harness build: bundle/minify site/src/ -> site/js/ (esbuild)
  -> validate static tree (bundle/type errors get one repair round-trip)
  -> commit/push authored source to public Forgejo
  -> atomically replace the published Apache directory
  -> refresh the public all-sites index
```

Git commits are made by the harness, not the model: the subject is the Discord request, the author is the Discord user who sent it, and the bot is the committer with a `Co-authored-by:` trailer (`COMMIT_BOT_NAME`/`COMMIT_BOT_EMAIL`).

A finished turn is presented in two messages: the turn's own message becomes the technical card (the agent's full report, the commit, the usage) and a reply to it carries the playable card (the browser-QA screenshot, what the project is and how to play it, what this turn changed, and the play link). The card text comes from two documents the agent maintains in the project root, `DESCRIPTION.md` and `CHANGELOG.md`, which the harness reads after every turn, so nothing has to be generated after the fact. The agent also maintains `README.agent.md`: after every turn the harness regenerates `README.md` with its ownership marker, live link, original request and submitter, then appends that section. See [commands.md](commands.md).

## Why static-only

The agent cannot run `npm install`, unrestricted shell commands, git writes, or server code. Every deliverable (sites and games alike) is HTML/CSS/static browser JavaScript/assets. The `sitebuilder` agent may edit `site/**` and inspect the workspace; external directories are denied and shell commands use an allowlist. `webfetch` and `websearch` are allowed for research, with the search provider pre-selected in the agent service (`OPENCODE_WEBSEARCH_PROVIDER`) so its first-use consent prompt never reaches users; media downloads go through the guarded `asset_download` tool (SSRF/private-network blocking, path containment, redirect limits, timeouts, and `ASSET_MAX_BYTES` all enforced), and files users attach in Discord are installed through `asset_import`, which copies them from the upload area under `scratch/uploads/` into `site/assets/` with provenance recorded.

A second publication boundary applies before anything goes live: `site/index.html` is required; symlinks, dotfiles (including `.htaccess`), and server-executable extensions (PHP, CGI, shell scripts) are rejected; total files and bytes are capped (`MAX_SITE_FILES`, `MAX_SITE_BYTES`). Publication accepts arbitrary static extensions otherwise.

**Serve generated sites from a dedicated origin** (e.g. `sites.example.com`), never an origin carrying login cookies or admin apps: generated browser JavaScript is untrusted content even though the filesystem side is static-only.

## TypeScript sources, harness-owned build

Projects are authored in TypeScript under `site/src/`. The model never runs a build; the harness runs the only one before every publish. esbuild bundles and minifies each top-level `site/src/*.ts` entry into browser JavaScript under the gitignored `site/js/` directory (imports followed, tree-shaken, code-split chunks under `js/chunks/`). Forgejo stores authored source only; Apache receives minified bundles, HTML/CSS and assets. Bundler failures surface as `file:line:col` errors and feed the same one-shot repair round-trip as validation errors.

Game repos get engines installed the way a dependency manager would, in a harness-managed `node_modules/` at the workspace root (gitignored, never published, re-seeded on drift):

- **3D**: three.js 0.186.1, `@dimforge/rapier3d-compat` 0.21.0 for physics, `three-mesh-bvh` 0.9.16 for accelerated spatial queries.
- **2D**: Excalibur 0.32.0, seeded from its official browser ESM distribution and complete TypeScript declaration graph.

2D games render at their displayed canvas size by default (`FillContainer` or `FillScreen`), with automatic HiDPI backing resolution. Instructions avoid stretching a fixed low-resolution framebuffer; resize changes framing/layout instead. Pixel art uses nearest-neighbor filtering, pixel snapping and integer zoom rather than blended or fractional scaling.

Authored code imports bare package names (`import * as THREE from "three"`) and esbuild resolves them by walking up from `site/src/`. Every package ships real TypeScript declarations, so type validation checks engine usage against actual APIs. Each game kind also carries an engine playbook as an OpenCode skill (`.opencode/skills/game-2d` + `excalibur`, or `game-3d`), re-checked on the same schedule as the engine package; site projects get no skill.

The generated `AGENTS.md` is committed to the public repository but sits outside `site/`, so the agent can read it but cannot edit it.

## The multiplayer exception

The runtime exception to static-only is the harness-owned game service: the model never writes server code. Multiplayer gameplay uses the vendored `site/net/threadsite-net.js`; global rankings in both multiplayer and singleplayer use the small, independent `site/leaderboards/threadsite-leaderboards.js`. The harness injects their shared stable game identity and service URL. Score requests never join multiplayer rooms, and games stay fully playable offline when the service is unreachable. See [multiplayer.md](multiplayer.md).

## Preview and browser QA

The `preview` service runs Microsoft's [Playwright MCP](https://github.com/microsoft/playwright-mcp), connected to OpenCode as `playwright`. Agents can open the current workspace, inspect screenshots, click canvas/WebGL coordinates, use keyboard controls, resize the viewport, and read browser console/network diagnostics before finishing a turn.

A small preview server compiles the current `site/src/` graph in memory with the production esbuild settings whenever the browser navigates to `http://127.0.0.1:8080/<guild-id>/<thread-id>/`. It writes no bundles, commits nothing, publishes nothing. Broken builds show diagnostics instead of the previous preview. Static projects without TypeScript also work.

After each validated build, the harness runs its own browser pass through the same service: it loads the preview, parses console/network diagnostics, checks for rendered content, and captures the screenshot posted to the thread. **Browser QA is advisory and fail-open**: findings never block publication or start a repair turn. Only confirmed application defects become findings (uncaught exceptions, same-origin asset failures, and a blank render that a second probe confirms), and they are saved in the project record and included in the next prompt so the agent can address them; a later clean check clears them. Everything that describes the preview environment instead of the application (offline external origins, the unreachable relay, browser lifecycle, browser quirks, preview-server availability) is dropped before it can reach the agent or the thread, so a pass never sends the model after a problem it cannot fix. `BROWSER_QA_TIMEOUT_MS` (default 90 s) caps the pass; `BROWSER_QA_ENABLED=0` disables it.

Screenshots are returned as MCP images, so the selected model must accept image input. Vision support is taken from `architecture.input_modalities` or `supported_features: ["vision"]`, never inferred from a model name. Text-only models receive no browser MCP tools, including snapshots and scratch inspection; they use source checks and harness-provided diagnostics. At 90% of the builder step budget, the bot sends a mandatory finish-up steer. See [agent-turns.md](agent-turns.md).

### Preview service notes

- No GPU required: Chromium renders through SwiftShader on the CPU. A browser is launched at boot and kept warm so the first navigation pays no cold start. `PREVIEW_CPUS` (default 4) is the main throughput knob, roughly half the host's threads; lower `PREVIEW_MEMORY` (default 3g) on a small host.
- Multiple threads can preview concurrently: every MCP session gets its own browser context (isolated pages, storage, screenshots); only the browser process is shared. Builds queue behind `PREVIEW_BUILD_CONCURRENCY` (default 4); `PREVIEW_SNAPSHOT_CACHE` (default 16) keeps one cached build per active thread.
- The service has read-only workspace access, temporary browser output, no credentials, no exposed host port, and a dedicated internal Docker network. Only the local preview origin is allowed: external services and the multiplayer relay are unavailable, so previewed games run in solo mode.
- Compose waits for preview health before starting OpenCode, and OpenCode health before starting the bot.

## Transport recovery

The bot can lose its HTTP/streaming connection to the agent service while the agent turn continues running normally. Before each prompt the harness snapshots persisted message IDs and assigns a stable submission ID. If the submission response is lost, ThreadSite:

1. does not immediately classify the event as a provider failure;
2. reconnects the agent event stream when possible;
3. reconciles that submission ID against the native inbox and persisted history, then polls execution status;
4. waits for a persisted execution outcome rather than an intermediate assistant stop;
5. resumes validation/git/publishing from that persisted result without re-sending the prompt;
6. only emits a private incident if it can prove the turn failed or recovery failed.

The prompt is never blindly retried after an ambiguous transport failure; that could create duplicate model turns. A persisted successful execution outcome establishes completion; background browser QA also has to be reviewed before delivery releases the turn.

The recovery window defaults to 30 minutes (`OPENCODE_RECONCILE_TIMEOUT_MS`, poll interval `OPENCODE_RECONCILE_POLL_MS`). If the window expires while the agent service still reports the session busy, ThreadSite attempts an HTTP session abort; if that cannot be confirmed, it preserves the worktree rather than resetting files under a possibly running agent.

When restart recovery sends a continuation prompt, this window limits inactivity, not total build time: tool activity and generation extend it, waiting for a user answer pauses it, status heartbeats alone do not. A stuck continuation is aborted and its partial edits preserved.

Provider retries are classified before waiting: a retry with no action or resuming within `OPENCODE_QUOTA_BLOCK_MIN_RETRY_MS` (default 10 min) is transient backoff: the turn waits and the progress line shows the next-attempt ETA. A retry carrying a quota action (e.g. a free-tier daily reset) is an exhausted quota: the stalled turn is aborted instead of parking the thread and queue for hours, and further prompts fail fast until the reset. Quota details go to administrators only.

Errors are serialized with their full `Error.cause` chains into the private JSONL log and admin DMs; Docker warn/error lines are emitted as JSON strings so nested causes are not collapsed to `[Object]`.

## Session context management

Automatic compaction is enabled in the agent platform config (`opencode/opencode.json`): a recent context tail is kept, headroom is reserved before the model window fills, and stale tool output is pruned. The platform decides when a session is "full" against each model's advertised limits. Hosts can cap context and larger input windows through the `contextCaps` map in their private provider config, keyed by provider or `provider/model-id`; model entries override provider entries. These caps apply to native and custom catalogs, independently of discovery. Surplus has a bundled JSON default of 100000 tokens (`0` disables), so long threads compact early. See [context cap configuration](deployment.md#context-caps-for-any-provider-or-model).

Project files plus `AGENTS.md` are the durable source of truth, so after compaction the agent re-reads the workspace. `/site compact` forces compaction on demand.

Additionally, a thread idle longer than `SESSION_IDLE_RESET_MS` (default 1 h) gets a fresh agent session on its next message, and a turn ending with the context more than `SESSION_CONTEXT_COMPACT_THRESHOLD` (default 0.5) full compacts before the next turn starts.

## Persistence and recovery

Project collaboration defaults to open editing. The persisted human owner, selected contributors and editing mode authorize Discord messages, live steers and controls through a shared policy. In approval mode, outside requests and attachment bytes stay in the private SQLite `project_approvals` table until an owner/admin decision; they never trigger agent work or write workspace files before approval. Queue admission and removal of the pending approval share one SQLite transaction. Approved requests then use the ordinary durable queue and recovery path. Project teardown deletes pending approvals; maintenance refuses unfinished approval queues. See [collaboration settings](commands.md#project-collaboration).

Every accepted thread update is saved before it is marked queued, including its author and attachments. Images travel with the request as data URIs when the next turn's model can see them; every other attachment type is downloaded at message receipt into the workspace under `scratch/uploads/` (gitignored, never published) and the prompt names the saved paths, so the agent reads reference material in place and installs binaries into `site/assets/` with the `asset_import` tool. Starting a batch atomically moves only its consumed requests into the in-flight turn record; startup restores queued requests even when no agent turn was running, and replacement status messages retain original request IDs so deleted Discord messages do not cause duplicate work.

- Discord thread → project/session mappings: SQLite at `data/bot/state.db` (`STATE_DB_FILE`).
- Usage ledger: indexed SQLite at `USAGE_DB_FILE` (default `data/bot/usage-log.jsonl.sqlite`).
- Project worktrees: `data/workspaces/<guild>/<thread>`.
- Published sites: `SITES_HOST_PATH`.
- Agent auth/session state: the `opencode-data` Docker volume.
- Forgejo data: the `forgejo-data` Docker volume.
- Arena worlds, deletion tombstones and rename redirects persist alongside personal save slots and leaderboards in one `relay.sqlite` under `GAMESERVER_STATE_DIR`; room-code worlds remain ephemeral (see [multiplayer.md](multiplayer.md#personal-saves-and-leaderboards)).

If a session ID disappears but the workspace remains, the bot creates a new agent session against the same files, updates its mapping, and retries the message. Site state lives primarily in the files/git history, not in model conversation memory.

## Git safety

Generated workspaces may live under the server's ThreadSite checkout with different host/container ownership. The bot pins every Git operation to each workspace's own `.git` directory and worktree and trusts only that workspace per invocation. A missing or redirected project `.git` is rejected rather than falling back to the server repository; no global `safe.directory=*` is used. All generated-workspace Git operations route through `bot/src/git.ts`. Git credentials exist only in the bot container and are supplied to `git push` via `GIT_ASKPASS`; the model/agent container never receives the Forgejo token.
