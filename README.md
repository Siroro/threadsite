# ThreadSite V2.5 — Discord threads that become persistent websites & multiplayer games

ThreadSite is a small Discord harness for an AI coding agent. One Discord thread maps to one persistent static website **or static web game** and one public Forgejo repository.

- `/site start prompt:"..."` in a text channel creates a Discord thread, a workspace, an agent session, a public Forgejo repository, the first git commit, and a live static site. Every project thread also gets a **pinned project card** — type (site/2D/3D), game engine, multiplayer setting, original request, advisory Browser QA status, lifetime usage, and links — that updates itself after every turn. Settings appear above the request; older pinned cards refresh on the next bot restart. Model routing and spend details stay in admin views.
- `/makegam dimension:<2d|3d> multiplayer:<arena|rooms|singleplayer> prompt:"..."` does the same for a **static browser game** and writes a mode-specific `AGENTS.md` before the agent session starts. Games default to a **shared-arena** architecture; `rooms` builds invite-code rooms, and `singleplayer` provisions no networking at all. `/site multiplayer` switches an existing game between the three live — the agent investigates the netcode, asks the user about the difficulties it finds, then rewrites.
- Networked games are built **multiplayer-first**: the harness provides one shared multi-tenant WebSocket relay, ThreadSite Multiplayer Protocol v4, and a TypeScript-authored browser client, so games get authoritative host migration, buffered transforms, shared clocks and reconnect safety with zero game server code (see below).
- Every normal message in that registered thread becomes the next mutation of the same site. **Reply while a turn runs to steer it live** — the message is submitted straight into the running agent turn and folded into the current work instead of waiting for the next pass. When the agent asks a question mid-turn, the requester gets pinged with answer buttons.
- The harness validates the result, commits and **pushes git first**, and only then publishes it to Apache. A failed push does not replace the previously published site. Each publish also stamps a content-derived deploy id into the site and pages reload themselves when a newer deploy goes live.
- `/site-admin model` changes the model globally for the next turn in every thread.
- `/site-admin token` stores/replaces a provider API token in the agent platform's own persistent auth storage. The bot does not write the LLM token to its state file.
- `/site info` shows the live URL, source repository, model, and last error.
- `/site republish` republishes the current static tree without spending model tokens.
- `/site sync` pulls commits that were pushed to the repository from outside the bot (e.g. with a repo push key) into the workspace, rebases any local-only commits on top, rebuilds, and republishes from the result. It is the manual recovery path when a push from Discord was rejected because the remote had moved ahead.
- `/site pushkey` issues repo-scoped git push credentials for this thread's repository; pushes made with them are detected by a poller and offered to the thread with Publish/Dismiss buttons, and a rejected bot push rebases on top of them automatically on the next commit.
- `/site compact` asks the agent to compact this thread's session context immediately (see below).
- `/site stop` interrupts the running turn — even when its live status message was deleted or never rendered — while keeping the agent session, workspace, edits, and history. `/site queue` shows the messages waiting for the next update pass and offers a cancel button for each waiting entry.
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

When restart recovery sends a continuation prompt, this window limits inactivity rather than total build time. Tool activity, generation, and plan/file updates extend it; waiting for a user answer pauses it. Status heartbeats alone do not extend the deadline, so a stuck continuation is still aborted and its partial edits are preserved.

Generated workspaces may live under the server's ThreadSite checkout and may have different host/container ownership. The bot pins Git operations to each workspace's own `.git` directory and worktree, and trusts only that workspace for each invocation. A missing or redirected project `.git` is rejected rather than falling back to the server repository; no global `safe.directory=*` setting is needed.

Provider retries are classified before waiting on them. A retry with no action, or one scheduled to resume within `OPENCODE_QUOTA_BLOCK_MIN_RETRY_MS` (default 10 minutes), is transient backoff: the turn waits it out and the progress line shows the next-attempt ETA. A retry carrying a quota action — e.g. the OpenCode free tier's `free_tier_limit`, whose next attempt is the daily UTC-midnight reset — is an exhausted quota, not backoff: the thread only sees a generic "AI provider unavailable" line with the resume time, the stalled turn is aborted instead of parking the Discord thread and the project queue for hours, and further prompts to that provider fail fast until it lifts. The quota reason, subscribe pitch, and link go to administrators only — one incident DM per block (repeat fail-fast incidents stay in `/site-admin errors` without re-DMing) and the `Provider quota:` line in `/site-admin status`.

V2.1 also recursively serializes `Error.cause` into the private JSONL log and administrator DMs. Docker warn/error log lines are emitted as JSON strings so nested causes such as `ECONNRESET`, `UND_ERR_SOCKET`, DNS, TLS, or timeout information are not collapsed to Node's `[Object]` display.

## Why static-only

This harness intentionally does **not** let the model run `npm install`, unrestricted shell commands, git writes, or server code. Games are also static web deliverables: HTML/CSS/static browser JavaScript/assets only, with no Node or game server at runtime. The `sitebuilder` agent can edit `site/**` and inspect the workspace; external directories stay denied and shell commands use an explicit allowlist. `webfetch` and `websearch` are allowed for broad web research, while media downloads go through the guarded `asset_download` tool. Configured subagents, LSP, curated skills, questions, and OpenCode's repeated-tool-call recovery guard are enabled.

### TypeScript sources, harness-owned build

Projects are authored in **TypeScript under `site/src/`**. The model never runs a build; the *harness* runs the only one before every publish. It bundles and minifies each top-level `site/src/*.ts` entry into browser JavaScript under the gitignored `site/js/` workspace directory with **esbuild** (imports followed, modules merged and tree-shaken, code-split chunks under `js/chunks/`). Forgejo stores authored source, HTML/CSS and assets—not compiler output. Apache receives the runtime boundary: minified bundles, HTML/CSS and assets, with `site/src/` and the unbundled networking client excluded. There is no runtime or deferred build. Bundler failures surface as code-framed `file:line:col` errors and feed the same one-shot repair round-trip as validation errors.

Game repos get their **engine installed the way a dependency manager would**: 3D games get a curated stack — three.js (r185) plus `@dimforge/rapier3d-compat` (0.12) for physics and `three-mesh-bvh` (0.9) for BVH-accelerated queries against static geometry — and 2D games get Phaser 4.2.1, all in a harness-managed `node_modules/` at the workspace root (gitignored, never published, re-seeded on drift). Authored code imports the bare package names (`import * as THREE from "three"`, `import RAPIER from "@dimforge/rapier3d-compat"`, `import * as Phaser from "phaser"`) and esbuild resolves them by walking up from `site/src/` exactly like normal npm usage. Three.js remains tree-shakeable; Phaser is seeded from its official minified ESM distribution so its framework baseline stays well inside the static-site budget; Rapier is the `-compat` build whose WASM is base64-inlined into the single ESM file, so it bundles with no `.wasm` asset handling. Every package ships its **real TypeScript declarations**, so the agent's editor and the validation gate check engine usage against the actual APIs — wrong argument types and misspelled members fail the turn. Each game repo also carries a per-kind **engine playbook as an OpenCode skill** — `.opencode/skills/game-2d` + `phaser-4` for Phaser, `game-3d` for three.js — seeded and re-checked on the same schedule as the engine package (gitignored with the rest of `.opencode/`, never published), so the agent loads the deep engine how-to (bootstrap patterns, lighting and batching budgets, physics and character-controller discipline, disposal, asset pipelines) on demand while AGENTS.md stays the compact rulebook; site projects get no skill.

The one deliberate runtime exception is the **harness-owned multiplayer relay**: the model never writes server code, it only uses the vendored browser client (`site/net/threadsite-net.js`) pointed at the shared relay whose URL and game id the harness injects. The relay is part of the infrastructure, not part of any generated deliverable, and games must stay fully playable solo when it is unreachable.

The bot then applies a second publication boundary: `site/index.html` is required; symlinks, dotfiles (including `.htaccess`), and non-static/server-executable file extensions are rejected; total files and bytes are capped. This makes it a much better fit for an existing Apache static host than running arbitrary model-generated build scripts.

This is still user-generated HTML/JS. **Serve generated sites from a separate origin such as `sites.example.com`, not the same origin that carries sensitive login cookies or admin apps.** Browser JavaScript can be hostile even when the filesystem side is static-only.

## Stack

- Node 24 + discord.js bot
- OpenCode agent server (the internal `opencode` service) + `@opencode-ai/sdk`
- One shared Node 24 + `ws` multiplayer relay for all games (multi-tenant, in-memory)
- Forgejo 15 LTS by default (SQLite, no separate database needed)
- Your existing Apache static directory, or an optional bundled `httpd:2.4-alpine` profile

The agent SDK supports a headless client/server integration and explicit per-message model selection. Provider credentials can also be persisted through its auth service.

## Browser and visual feedback

The `preview` service runs Microsoft's [Playwright MCP](https://github.com/microsoft/playwright-mcp), connected to OpenCode as `playwright`. Agents can open the current workspace, inspect screenshots, click canvas/WebGL coordinates, use keyboard controls, resize the viewport and read browser console/network diagnostics before finishing a turn. Browser instructions are included in every project's `AGENTS.md`.

A small ThreadSite preview server compiles the current `site/src/` graph **in memory** with the production esbuild settings whenever the browser navigates to or reloads `http://127.0.0.1:8080/<guild-id>/<thread-id>/`. This lets the model inspect edits before the final harness build. It does not write generated bundles, commit or publish anything. Broken builds show their diagnostics instead of the previous preview. Static projects without TypeScript also work.

After each validated build the harness also runs its own browser pass through the same service: it loads the preview, parses the MCP tools' plain-text console and network diagnostics, checks for rendered content, and captures the screenshot posted to the thread. **Browser QA is advisory and fail-open:** timeouts, unavailable checks, blank renders, missing assets and runtime exceptions produce warnings with the actual cause, rather than blocking publication or starting another repair turn. Confirmed runtime findings are distinguished from preview/network limitations. Diagnostics are saved in the project record and included in the next mutation or recovery prompt so the agent can address genuine defects. A later clean check clears them. Compiler, type, static-output and publication boundaries remain mandatory.

If the browser pass exceeds `BROWSER_QA_TIMEOUT_MS` (default 90 seconds), its requests are cancelled and browser cleanup runs separately. The warning identifies the stage and reason, such as navigation timing out or a screenshot being unavailable; the final Discord result also carries a concise warning. `BROWSER_QA_ENABLED=0` disables the pass entirely.

Screenshots are returned as actual MCP images. The selected model/provider must accept image input; text-only models can inspect accessibility snapshots and runtime diagnostics but cannot judge pixels. Surplus discovery preserves image support from `architecture.input_modalities` **or** `supported_features: ["vision"]`, including when credentials are stored through `/site-admin token`. No vision capability is inferred from a model name.

The service has read-only workspace access, temporary browser output, no credentials or exposed host port, a dedicated internal Docker network and separate browser contexts per MCP connection. Only the local preview origin is allowed; external services and the multiplayer relay are unavailable, so preview games in solo mode. Final build/type/static validation and publication still run normally. Compose waits for preview health before starting OpenCode, and OpenCode health before starting the bot. Existing deployments need `docker compose up -d --build preview opencode bot`; starting `opencode` also starts its preview dependency.

No GPU is required: Chromium renders through SwiftShader on the CPU. Because that makes browser startup the most expensive step of a browser turn, the service launches a browser at boot and keeps it warm for every later MCP session (each still gets its own context), so the agent's first navigation and the harness QA pass do not pay a cold start. Software rasterization scales with cores, so `PREVIEW_CPUS` (default 4) is the main throughput knob — give it roughly half the host's threads and leave the rest for OpenCode's language servers and type-checker. Lower `PREVIEW_MEMORY` (default 3g) on a small host.

Multiple threads can preview at the same time. Every MCP session gets its own browser context, so pages, storage and screenshots are isolated per thread; only the browser process and its SwiftShader rasterizer are shared. Builds queue behind `PREVIEW_BUILD_CONCURRENCY` (default 4) instead of failing, and `PREVIEW_SNAPSHOT_CACHE` (default 16) keeps one cached build per active thread.

To verify locally, run `npm --prefix preview ci && npm --prefix preview test`. The browser smoke test additionally needs Docker: `docker build -t threadsite-preview-test:local ./preview`, then `npm --prefix preview run test:browser`; `npm --prefix preview run test:warmup` checks the boot-time warm-up (browser already running before the first client, surviving client disconnects, and still isolating per-client storage). To also verify screenshot delivery through the pinned OpenCode server without spending model tokens, build `docker build -t threadsite-opencode-test:local ./opencode` and run the browser test with `PREVIEW_TEST_OPENCODE_IMAGE=threadsite-opencode-test:local` in its environment.

For the complete Docker integration check, run **`npm --prefix preview run test:docker`**. It builds the production bot, OpenCode and preview images through the real Compose file, then uses an isolated Compose project and a scripted provider to exercise website, Phaser and three.js projects. The real bot SDK harness drives agent file edits, browser forms/clicks/keyboard/navigation/scroll, desktop/mobile screenshots and reloads after source changes; the test checks screenshot bytes reach the provider, compares preview JavaScript with the final bot build byte for byte, runs static/type validation, publishes and fetches the result from Apache. It also verifies terminal assistant failures are rejected rather than treated as empty success. No real Discord login or paid model inference is used, and the fixture containers, volumes and temporary workspaces are removed afterward. Preview and bot esbuild versions must match; the unit suite checks this to prevent compiler drift.

## 1. Discord app setup

Create a Discord application/bot and invite it with permissions to:

- View channels
- Send messages
- Create public threads
- Send messages in threads
- Embed Links (recommended for live progress cards; text fallback is automatic)
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
OPENCODE_MAX_STEPS=200

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

`OPENCODE_MAX_STEPS` sets the builder's step budget per turn (positive integer, default **200**). OpenCode applies it when the container starts; the title agent keeps its separate one-step limit. After changing this value in `.env`, run `docker compose up -d opencode` to recreate the service with the new environment. The startup log reports the effective limit. Invalid values stop startup with a clear error.

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

When the agent container starts, its startup script calls the public Surplus `GET /v1/models`, keeps tool-capable (or capability-unspecified) models suitable for an agent, and carries context/output limits and advertised image-input support into the generated provider config. Discovery also runs when the key is stored in OpenCode auth. `SURPLUS_MODELS` is a comma-separated fallback/extra list and is useful when a newly-added model is not returned by discovery yet.

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

The public catalog is still discovered in that mode; if discovery fails, the agent platform uses the fallback IDs from `SURPLUS_MODELS`. To add an ID absent from the catalog, add it to `SURPLUS_MODELS` and recreate the agent container (fallback entries do not guess image support). If `SURPLUS_API_KEY` is set in the environment, that environment key is explicitly placed in the generated provider configuration and therefore should be treated as the authoritative Surplus credential.

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

`dimension` is the first `/makegam` option and is restricted to `2d` or `3d`; the optional `multiplayer` option picks the architecture — **Arena** (the default: one game-wide shared world), **Rooms** (invite-code rooms with a join lobby), or **Singleplayer only** (no net client, no relay wiring, an explicit no-netcode rulebook). The harness stores the project type and architecture, creates a matching `AGENTS.md`, and wraps the first model request in a matching generation prompt. `/site multiplayer mode:<...>` switches the architecture later; an optional `prompt:` note rides the switch. The game must still publish as ordinary static web files under `site/`; subsequent normal thread messages keep the same 2D/3D rules.

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

While a turn runs, its Discord message updates in place as a live status card:

- a **Prepare → Build → Check → Publish** stage rail, with the current activity and its duration during longer operations;
- the request being handled and a short excerpt of the agent's public update;
- the actual todo plan, with completed, current, pending and skipped work;
- changed-file counts, added/removed lines and relative filenames;
- input/output tokens, cache share, context-window usage, model steps and generation speed when available (the model name itself is never shown);
- a timestamped recent-activity trail, action counts, saved requests waiting for the next pass, and project links.

Questions switch to a shorter amber card with the question, option descriptions and answer/skip buttons close at hand, including on mobile. The selected answer and responder remain visible afterward. The Stop button remains available while work runs. A full context window is shown as context usage, not a percentage estimate of how close the whole job is to completion. Provider spend, the model name and private reasoning are never included in the public card.

Because HTTP request timeouts to the agent service are disabled by design, a provider that stops emitting events would otherwise leave the card heartbeating forever. The card therefore tracks real agent activity (not its own heartbeat) and, after `TURN_STALL_WARN_MS` without any event, switches to an amber **No progress for Nm** state that points at `/site stop`. The warning is suppressed while the thread is queued or waiting for an answer, where idleness is expected. It is a visible watchdog, not an automatic abort.

`/site stop` (and the Stop button) aborts only the running agent turn: the session, workspace, partial edits, and git history are kept. It is deliberately not queued, so it still works when the turn is wedged on an unreachable agent or when the live status message was deleted before the button could be pressed. A stop lands in every phase: while the turn prepares, while it runs, while recovery waits, and even mid-reconcile — none of them resurrect the stopped turn. `/site queue` lists the backlog with its authors and offers **Cancel N** buttons; cancelling withdraws one waiting request from both the in-memory batch and SQLite and marks its acknowledgement message cancelled. Requests already being prepared by a drain are reported as in-flight instead of being silently removed.

### Steering a running turn

A reply sent while a turn is running is not queued — it **steers the live turn**. The message is submitted straight into the busy agent session (the same delivery path the agent platform's own TUI uses), where the model reads it mid-turn as an amendment to the current task and folds it into the work in progress. Nothing is aborted and nothing restarts; the acknowledgement says so and the status card shows the steering line. Steers that cannot land — no live turn, a turn in its build/commit/publish tail, messages carrying images, or the agent service rejecting the submission — fall back to the normal queue untouched, so a steering attempt can never lose a message.

When the agent asks a question mid-turn, the person who requested the turn gets a Discord ping pointing at the answer buttons on the status card, so a parked question (which holds the turn and the thread's queue open) cannot sit unseen.

Edits respect `PROGRESS_UPDATE_MS`, coalesce rapid events and serialize Discord requests. Quiet turns retain a heartbeat, and stale live throughput estimates disappear. Closing a feed waits for its last edit before posting the final result so a late update cannot overwrite it. Servers without **Embed Links** permission automatically get a compact text version with the same controls. Final messages clear the live card and retain the agent's outcome summary; successful browser-QA screenshots are still posted normally.

### AI-generated thread titles

When `/site start` or `/makegam` creates a new thread and no explicit `name` option was given, a parallel `titler` session generates a concise title. After the first successful build, that title becomes the Discord thread name, source repository name and public site URL. Explicit names get the same URL treatment. For example, **Sumo Shove** becomes repository `site-sumo-shove` and `https://…/sumo-shove/`; a short unique suffix is added only when the name is already taken. If title generation fails or times out, the original name remains.

Use **`/site rename name:"Fresh Name"`** in an existing project thread to rename the project and refresh both links without asking the model. The bot updates the repository, git remote, README and gallery. Existing site links redirect to the new address, including existing subpages, query strings and fragments; Forgejo keeps its repository redirects. Renames preserve the multiplayer tenant and its world state. A durable rename record lets delivery resume after a disconnect or restart, and the bot checks repository IDs before resuming so an unrelated repository is never adopted. Thread-title changes that fail are retried after restart.

Rename commits are metadata, not an additional agent turn: `/site revert` undoes the complete previous agent turn while preserving the current project name and links, including in projects renamed by older versions.

### `/site compact` and `/site revert`

- `/site compact` requests on-demand compaction for the thread's session using the model the session last used (or the globally configured model). Useful after very long threads even with automatic compaction. The published site is untouched.
- `/site revert` undoes the prior turn end-to-end: the agent conversation is reverted to before the last request (the model will not remember the undone turn), the workspace is reset to the previous commit, the commit is force-pushed away from the public Forgejo repository, and the previously published site is restored. If the last turn had failed before publishing, only its conversation is removed and git is left alone. Reverting below the initial creation commit is refused.

### Repo push keys (`/site pushkey`)

Forgejo has no per-repository HTTP tokens, so a ThreadSite push key is a dedicated **restricted Forgejo account** (username `push-xxxxxx`, random password) with Write permission on exactly one project repository. Restricted accounts can see nothing else on the instance, so handing out a key is scoped to that repo's git history only.

- `/site pushkey` in a project thread issues (or re-shows) that thread's key as a clone URL plus username/password. `/site pushkey rotate: true` replaces it — the old account is deleted, which revokes the old credentials immediately.
- Push-key holders push to `main` like any collaborator. **A push does not go live by itself**: the bot detects it and posts an **External push detected** message in the thread with **Publish** / **Dismiss** buttons. Detection uses a Forgejo push webhook by default, with polling of each ready repo's `main` tip every `EXTERNAL_PUSH_POLL_MS` (default 60 s) as a safety net for hook setup or delivery failures. `WEBHOOK_ENABLED=0` uses polling alone; `EXTERNAL_PUSH_POLL_MS=0` disables polling. Webhook setup failures are logged but do not stop project creation or renaming. Forgejo will not call a private address unless it is allowlisted, so `FORGEJO_WEBHOOK_ALLOWED_HOSTS` (default `bot`) must name the host in `WEBHOOK_PUBLIC_URL`; change the two together.
  - **Publish** syncs the workspace to the pushed commit, rebuilds, validates, and publishes through the normal pipeline. If validation fails, the live site keeps the previous version, the workspace rolls back to the last published commit, and the thread sees the validation errors (the commit stays in the repo).
  - **Dismiss** adopts the commit into the workspace and git history only; the live site is unchanged and the next thread message builds on the pushed code.
- The bot's own pushes rebase on top of any external commits first, so an accepted external push never breaks the next Discord turn.
- `/site sync` is the manual counterpart: it pulls whatever is on `main` into the workspace (rebasing a rejected local commit on top), pushes, rebuilds, and republishes — the recovery path when a bot push was rejected with non-fast-forward, when the external push predates the poller's marker, or when the Publish button message is gone. It refuses while an agent turn is live and while the workspace still holds uncommitted edits from a failed turn.
- Keys require `secrets/forgejo-admin-token` (created by `./scripts/bootstrap-forgejo.sh` alongside the service token); the admin token is used solely to create/delete the restricted push accounts. Credentials are stored in the bot's private state file and are visible to anyone who can read the thread, which is the intended audience.
- Deleting the project (thread deletion) deletes the repo; the push account itself can be removed by rotating or deleting it in the Forgejo admin UI.

Each accepted message does this:

```text
Discord thread message
  -> same persistent agent session + same workspace
  -> load persistent project AGENTS.md when present (2D/3D game + multiplayer rules)
  -> harness re-checks the multiplayer client/config files, the engine packages in node_modules, and the engine playbook skill under .opencode/skills/
  -> edit site/** only (browser code authored in TypeScript under site/src/)
  -> harness build: bundle/minify site/src/ -> gitignored site/js/ (esbuild, tree-shaken)
  -> validate static tree (bundle errors and type errors get one repair round-trip)
  -> bot writes README metadata
  -> commit/push authored source + the vendored net client (site/net/) to public Forgejo (no site/js or build manifest)
  -> atomically replace the published Apache directory with runtime files (no site/src or site/net)
  -> refresh the public all-sites index
```

The git commit is deliberately performed by the harness rather than by the model. Commits read like real history: the subject is the Discord request itself (truncated to one line), the **author** is the Discord user who sent it (display name, with a `@username@users.noreply.discord.com` noreply email), and the bot is the committer plus a `Co-authored-by:` trailer — `ThreadBot` by default, configurable with `COMMIT_BOT_NAME`/`COMMIT_BOT_EMAIL` (set the email to the Forgejo service account's address to link its avatar in Forgejo).

### `/makegam` game profiles

Both profiles are deliberately **static-web only** and go through the same validation, git-push-first, and Apache publication boundary as normal sites. Their default architecture is **shared-arena multiplayer** through the relay (see the next section): the agent gets the vendored net client, this game's tenant config, and the full sync guide in its `AGENTS.md`. `multiplayer:rooms` swaps the AGENTS.md guidance for invite-code rooms with a join lobby, and `multiplayer:singleplayer` provisions no networking at all — the net files are never written, or removed when switching — and the rulebook forbids adding any. `/site multiplayer` rewrites the architecture on an existing game whenever the design should change.

- **2D**: builds on the installed Phaser 4.2.1 engine package by default for action/arcade/sprite-heavy games, using its Scenes/input/cameras/Arcade Physics before hand-rolling engine infrastructure, with Canvas 2D or DOM/SVG also allowed for board/puzzle/UI-heavy games. Its `AGENTS.md` asks for responsive controls, game states, scoring/progression, collision discipline, frame-rate-independent animation, and lightweight game feel.
- **3D**: requires a genuine 3D play space using WebGL, built on the installed three.js engine package, with Rapier (`@dimforge/rapier3d-compat`) for anything needing rigid bodies or robust character collision and `three-mesh-bvh` for fast raycasts/spatial queries on complex static meshes. It forbids npm/Vite/webpack/build pipelines of the agent's own and vendoring second physics engines, asks for conservative geometry/effects, camera and input guidance, fixed-timestep physics with interpolated rendering, and a visible fallback when WebGL cannot initialize.

The generated `AGENTS.md` is committed to the public project repository but is outside `site/`, so the agent can read it but cannot edit it under the supplied permissions. The agent platform discovers project-root `AGENTS.md` files as persistent project instructions.

## Multiplayer games — one shared multi-tenant relay

Games default to **shared-arena multiplayer** (or invite-code **rooms**, or none at all — chosen at `/makegam` and switchable with `/site multiplayer`). Networked games share one `gameserver` container for the whole deployment; there is no per-game instance, process, or provisioning step. Multi-tenancy is addressed by two ids the harness controls:

- **game id** — the published site slug, injected into each game as its tenant key;
- **room code** — a short code (for example `AB3CK`) namespaced *per game*, so the same code in two games is two different rooms.

A single relay therefore serves any number of games and any number of rooms per game, bounded only by configured caps.

### What the harness injects into every game project

On creation — and re-checked before every mutation, in case the agent removed them:

- the committed `site/net/threadsite-net.js` + declarations — regenerated from the harness's TypeScript networking source and bundled into the minified game output. The zero-dependency client owns reconnects, half-open detection, bounded backpressure, expiring reliable events, relay clocks, transform interpolation/extrapolation, room generations, authority epochs and safe host handoff. `createAuthoritativeSession()` and the typed `world`, `transforms`, `intents`, `events`, `presence`, `clock`, `run`, and `entities` facades remove routine synchronization decisions and stable-ID reconciliation from generated games. `net-config.js` carries this game's tenant identity. The unbundled client and config stay visible in the Forgejo repo but are never copied to Apache.
- the engine packages in the harness-managed workspace `node_modules/` — three.js (r185) + Rapier compat + three-mesh-bvh for 3D projects, Phaser 4.2.1 for 2D projects — imported by bare package name and type-checked against their real declarations; the harness seeds Phaser's official compact ESM build into the published bundle.
- the `AGENTS.md` multiplayer section — the full protocol reference, the authority-selection rules (host-authoritative shared world by default for real-time action games with shared enemies/damage/pickups while player controls stay locally responsive; peer-owned state only when players are genuinely independent), stable live peer identity vs reconnect cid, relay-time interpolation, background-tab host handoff, host-migration notes, untrusted-input validation rules, and the required lobby/room-code/offline-fallback UX. Agents are told to design **multiplayer-first**, treating solo play as the same game with one player.

The first-turn prompt and the `sitebuilder` agent configuration both reinforce this: use the provided client, never write server code, and never invent other runtime network endpoints.

### ThreadSite Multiplayer Protocol (summary)

Protocol v4 uses JSON text frames over one WebSocket per player. The relay owns a random room generation, explicit `hostId`, monotonically increasing authority epoch and world-state sequence. Only the current host for that generation and epoch can publish the shared world. Host disconnect and `yield-host` both migrate authority with the latest cached snapshot attached, so the new host restores before simulating. Hosts receive cache acknowledgements too, allowing a reconnecting client to restore and republish the last complete world if a relay restart erased room memory.

Player transforms are transient latest-wins state with monotonic relay timestamps and are never replayed after reconnect. Application events carry reload-safe unique IDs, expire after a short TTL, retry once after rate limiting, and are deduplicated per sender without a gap/resend protocol. The relay remains game-agnostic: it stores the newest complete world and live peers' newest player state, stamps relay time, and never interprets or simulates gameplay.

Generated games use explicit channels: reliable events are TTL/retry/dedupe protected, ephemeral signals drop instead of building stale backlogs, host-routed intents automatically carry the accepted run ID and are rejected before game code when stale, and slow-changing presence is cached separately from high-frequency transforms. Stable-ID `syncCollection()` controllers reconcile guest entity views from complete snapshots without embedding game rules in the relay.

### Operating the relay

```dotenv
MULTIPLAYER_ENABLED=true
GAMESERVER_PUBLIC_URL=ws://localhost:8090/ws
GAMESERVER_INTERNAL_URL=http://gameserver:8090
GAMESERVER_PORT=8090
GAMESERVER_MAX_PEERS_PER_ROOM=16
GAMESERVER_MAX_ROOMS_PER_GAME=256
GAMESERVER_MAX_MESSAGE_BYTES=270336
GAMESERVER_MAX_BUFFERED_BYTES=1048576
GAMESERVER_RATE_PER_SECOND=60
GAMESERVER_RATE_BURST=120
GAMESERVER_ROOM_TTL_MS=600000
# A host silent this long while another peer waits loses authority.
GAMESERVER_HOST_STALL_MS=15000
# permessage-deflate kill switch (0 = off); snapshots compress, hot transforms do not.
GAMESERVER_PERMESSAGE_DEFLATE=1
GAMESERVER_ALLOWED_ORIGINS=
GAMESERVER_STATE_DIR=/data/threadsite-relay
GAMESERVER_PERSIST_INTERVAL_MS=1000
```

- The bundled/local default `ws://localhost:8090/ws` works out of the box next to the bundled static Apache profile.
- For production behind host Apache, proxy `wss://games.example.com/ws` using `apache/gameserver-vhost.conf.example`, set `GAMESERVER_PUBLIC_URL` to that URL, and optionally lock browsers down with `GAMESERVER_ALLOWED_ORIGINS=https://sites.example.com`.
- `./scripts/check-gameserver-proxy.sh` verifies both legs: the internal health endpoint and a real WebSocket upgrade through the public URL.
- Cloudflare's proxy (orange cloud) works for the relay: WebSockets are supported on every plan, and the net client's 10-second heartbeat keeps connections alive below Cloudflare's idle cutoff. Requirements: SSL/TLS mode **Full (strict)** — Flexible terminates at port 80 and never reaches the `/ws` directives in the HTTPS vhost — and the public URL must use standard port 443 (Cloudflare does not proxy port 8090). Proxied hostnames also complicate Let's Encrypt HTTP-01 renewal; use a bypass rule for `/.well-known/acme-challenge/*`, DNS-01 validation via the Cloudflare API, or a Cloudflare Origin CA certificate. `./scripts/check-gameserver-proxy.sh` verifies the handshake through Cloudflare unchanged.

### Relay behind Virtualmin / Apache

Same drill as the Forgejo vhost, for a new hostname such as `games.example.com`:

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
   GAMESERVER_PUBLIC_URL=wss://games.example.com/ws
   GAMESERVER_ALLOWED_ORIGINS=https://sites.example.com
   ```

   `GAMESERVER_ALLOWED_ORIGINS` is a comma-separated list of browser origins (scheme + host, no path) — normally just your `PUBLIC_SITES_BASE_URL` origin. Leave it blank to allow any origin.
5. Verify with `./scripts/check-gameserver-proxy.sh`; it reports the internal health check and the public WebSocket upgrade separately, so a failure tells you whether to look at Docker or at the vhost.
- `GET /health` and `GET /stats` on the relay return games/rooms/clients counts; `/site-admin status` shows a one-line summary.
- Every connection is token-bucket rate-limited, frames and pending send buffers are size-capped, rooms have peer caps, and empty rooms are garbage-collected after `GAMESERVER_ROOM_TTL_MS`. Slow consumers are disconnected and recover through the normal reconnect/latest-state path rather than accumulating an obsolete relay backlog.
- **Shared arenas are durable; private rooms are not.** The relay periodically snapshots the latest authoritative world of each game's single-mode arena (one small JSON file per game under `GAMESERVER_STATE_DIR`, written atomically via temp-file + rename) and replays it to the first joiner after the room empties or the relay restarts. Only the opaque game snapshot is kept — peer ids, authority epochs, generations and sequences die with the session that created them, so stale pre-restart frames never validate. The compose file binds `./data/gameserver` so arena worlds survive container recreation; room-code sessions stay in-memory only and recover through the client's auto-reconnect plus snapshot resync, or fall back to solo play.

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

Add cache headers so republished sites reach returning visitors immediately (full copy with comments in the example file): HTML always revalidates, assets carrying the `?v=<hash>` ThreadSite appends on publish cache immutably, and any asset requested without a version revalidates instead of pinning an old copy for the cache lifetime. Every publish also stamps a `threadsite-version.json` deploy marker into the site root and appends a tiny update-checker to every published page: the checker re-fetches the marker every 30 seconds (and whenever the tab regains focus), and when the live deploy id differs from the one the page was served with, the page reloads itself — hidden tabs immediately, visible tabs behind a one-second "New version available — updating…" notice. Visitors therefore land on the newest build without manually refreshing, and republishing an unchanged site produces the same id, so nobody is reloaded for nothing.

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

If Cloudflare or another CDN fronts the sites hostname, set its **Browser Cache TTL** to **Respect Existing Headers** — a fixed CDN default (four hours) overrides the origin's revalidation policy and visitors keep stale assets for hours after a republish, `?v=` busting notwithstanding.

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

For a deployment behind such a proxy, use:

```dotenv
FORGEJO_PUBLIC_URL=https://git.example.com
FORGEJO_DOMAIN=git.example.com
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

Every accepted thread update is saved before it is marked queued, including its author and image attachments. Starting a batch atomically moves only its consumed requests into the in-flight turn record, leaving overflow and newly arrived requests queued. Startup restores queued requests even when no agent turn was running; replacement status messages retain the original request IDs so deleted Discord messages do not cause duplicate work. `/site queue` lists the waiting entries and can withdraw one from both the in-memory batch and SQLite; entries already claimed by a drain are reported as in-flight rather than removed under the running turn.

- Discord thread -> project/session mappings live in SQLite at `data/bot/state.db`. A legacy `STATE_FILE` ending in `.json` is imported once into the adjacent `.db`; the JSON file is kept as a backup.
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

## Removing stale project registrations

### Cleanup through start.sh

After updating the checkout and rebuilding the bot image, use the numbered cleanup menu:

```bash
./start.sh cleanup
```

Select one or more project numbers, then choose full removal or registration-only cleanup. The menu previews the exact selection and asks you to type `DELETE` before applying it. These commands list registered resources without updating Git or restarting services:

```bash
./start.sh projects
./start.sh threads
./start.sh repos
./start.sh games
./start.sh cleanup --kind games
```

Each entry shows the Discord thread ID, project kind/status, display name and Forgejo repository. Listings cover registered projects; they do not discover unrelated Discord channels or Forgejo repositories. A game selection removes that game's linked project resources.

For direct selection, names match exactly and options can be repeated. Commands preview by default; `--apply` executes the selected action:

```bash
./start.sh remove --thread 123456789012345678
./start.sh remove --game "My Game" --apply
./start.sh remove --repo site-my-game --apply
./start.sh forget --repo site-deleted-game --apply
```

Full removal deletes the selected Discord thread, Forgejo repository, workspace, published site/aliases and SQLite registration, then refreshes the site index. It saves a SQLite backup first; that backup contains metadata, not a copy of the deleted source files. Registration-only cleanup keeps the thread, repository and files. Existing agent session history and relay snapshots are retained.

Cleanup refuses queued/interrupted work, active agent turns, shared resources, unexpected workspace locations and paths through symlinks. Stop unfinished work with `/site stop`, clear `/site queue`, or let recovery finish first. During `--apply`, start.sh temporarily stops a running bot and restores its running state afterward, including on failure. Other services stay running. A failed removal retains the registration so the same selection can be retried; resources already deleted during that attempt are treated as absent on retry. Cleanup does not update the checkout, prune Docker volumes or remove unrelated data.

### Standalone stale-registration script

Deleting a repository directly in Forgejo does not remove its Discord project registration from SQLite. A webhook warning for that repository can therefore persist across bot restarts. A 404 can also mean lost access, so confirm the repository was intentionally deleted before removing its registration.

The maintenance script previews exact repository-name matches by default. It runs inside the existing bot image and needs no host Node installation:

```bash
docker compose run --rm --no-deps -T --entrypoint node bot --input-type=module - --repo DELETED_REPO < scripts/forget-projects.mjs
```

Repeat `--repo NAME` to select several repositories. After reviewing the preview, stop the bot and apply the removal:

```bash
docker compose stop bot
docker compose run --rm --no-deps -T --entrypoint node bot --input-type=module - --repo DELETED_REPO --apply < scripts/forget-projects.mjs
docker compose up -d --no-deps bot
```

The script uses `STATE_DB_FILE`/`STATE_FILE` from the container, or an explicit `--db FILE`. It saves a full SQLite backup alongside the database before deleting rows, refuses projects with pending work, and rolls back if a selected record changes during cleanup. It removes only the selected registrations; workspaces, published files, Forgejo repositories, and settings remain. The backup contains private state and is created with restrictive permissions.

## Local regression checks

Run `npm --prefix bot test` for production import containment, restart-safe queue handoff, clean naming, collisions, interrupted renames and revert coverage. Run `npm --prefix bot run build` for the bot compiler check and `npm --prefix preview test` for preview regression checks. Tests use temporary files, local git repositories and a fake agent/Forgejo service; no Discord login or paid inference is needed.

## Updating pinned versions

The one server command is the root-level `start.sh`: it pulls the latest code from GitHub, safely resets tracked files (`.env`, `secrets/`, and `data/` are untracked and untouched — never run `git clean` in this repo), rebuilds and recreates only the containers whose code changed, brings the stack up, and waits for services to report healthy. It also covers day-2 operations:

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

This repository is **main-only**: every update force-checks out `origin/main`, sets its upstream (so plain `git pull` also works), and removes stale local branches. The finer-grained `scripts/deploy.sh` does just the update+rebuild part (`--force` to discard local tracked edits). The project intentionally pins the agent platform/SDK versions together in `opencode/Dockerfile` and `bot/package.json`. When updating one, update the other and rebuild:

```bash
docker compose build --pull opencode bot
docker compose up -d opencode bot
```

The multiplayer relay pins `ws` in `gameserver/package.json`; rebuild it with `docker compose build --pull gameserver` when bumping.

Forgejo is pinned to the `15-rootless` LTS major tag by default so patch releases arrive without silently crossing a major upgrade boundary. Override `FORGEJO_IMAGE` if you prefer the current short-lived stable line.
