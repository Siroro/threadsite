# V2.3

- Removed public references to the underlying agent platform from everything players and server members see: Discord command descriptions and replies, live progress lines, `/site-admin status` output, generated project READMEs, and the `AGENTS.md` profiles now say "the agent"/"agent service" instead of naming the tool. Internal identifiers (env vars, Docker service name, file paths, logs) are unchanged.

- AI thread titles are now adopted end-to-end: when the `titler` agent's title lands after a successful first build, the harness renames the Forgejo repository and the published site directory to match (keeping the unique thread-id suffix), repoints the workspace git remote, rewrites the README, removes the old published directory, and refreshes the public index. Previously only the Discord thread name changed while repo/slug names stayed on the original prompt slug.

- Multiplayer UX: protocol v2 adds **peer-owned state** as the recommended sync model for casual games. Each player simulates their own entity locally and broadcasts it (`pstate` frames, 10–20 Hz) — controls no longer route through the host, so input latency is exactly local play and losing the host never affects anyone's controls. Interactions become events the target applies to itself; shared-world entities get a single owner. The relay retains each peer's newest player state and hands them to late joiners in `welcome`. Host-authoritative simulation remains documented as the option for shared-physics/competitive games.

- Redesigned final turn messages: the ✅/❌ status line with project name, commit, and file count comes first; the agent's summary follows with its meta opener ("Implemented a complete … game in site/") stripped; and the play/open + source links moved to the bottom with the Forgejo URL in angle brackets so it never embeds. The "V2.1 game-specific AGENTS.md" boilerplate line is gone, and the `sitebuilder` prompt now asks for summaries that start with substance instead of restating the deliverable.

- Richer live progress: the status message keeps a short rolling tail of the last few activity steps instead of only the newest one, the narration summary line can run to ~180 characters, the per-turn token counter is labeled `this turn … tok` (tokens generated for the current Discord request, not a turn count), and final turn messages keep up to ~1600 characters of the agent's summary instead of 700.

- Real git history: commit subjects are the actual Discord request (single line, 72 chars) instead of repeated "Update game from Discord". The Discord user who sent the request is the commit author (display name + `@users.noreply.discord.com` noreply email), and the bot is the committer with a `Co-authored-by:` trailer (`COMMIT_BOT_NAME`, default ThreadBot; `COMMIT_BOT_EMAIL` defaults to `FORGEJO_BOT_EMAIL` so Forgejo links the service account avatar).

- Multiplayer games: a single shared **multi-tenant relay** (`gameserver` service) hosts every generated game. Tenancy is the game id (the site slug) plus per-game room codes, so any number of games run on one container with no per-game instances or provisioning.
- **ThreadSite Multiplayer Protocol v1**: a small documented JSON-over-WebSocket protocol (join/welcome, peer join/leave with server-side host migration, relayed events, room snapshots with late-joiner handoff, state requests, ping/pong) implemented by the relay and by a vendored zero-dependency browser client.
- The harness now provisions every game project with `site/js/threadsite-net.js` (the protocol client) and `site/js/net-config.js` (that game's tenant id + relay URL), and re-checks both every turn in case the agent removed them.
- Game `AGENTS.md` profiles gained a **multiplayer-first** section: every game is designed as a multiplayer game first, with solo play as the same game with one player (plus optional bots). It documents the full wire protocol, the recommended host-authoritative sync model (snapshots at 8–15 Hz, input intents with sequence numbers, interpolation, host-migration recovery), the lighter last-writer-wins alternative, untrusted-input validation, and the required lobby/room-code/offline-fallback UX.
- The first-turn game instruction and the OpenCode `sitebuilder` agent prompt both push multiplayer-first and forbid any other runtime network endpoint or self-written server code.
- `/site-admin status` now reports relay health (games/rooms/players) from the new `/health` and `/stats` endpoints.
- Relay hardening: per-connection token-bucket rate limiting, frame size caps via WebSocket `maxPayload`, per-room peer caps, per-game room caps, join timeouts, dead-peer heartbeat, empty-room garbage collection with TTL, and an optional `GAMESERVER_ALLOWED_ORIGINS` origin allowlist.
- Production wiring example for host Apache (`apache/gameserver-vhost.conf.example`) proxying `wss://…/ws`; the bundled/local default is `ws://localhost:8090/ws`.
- Room state is in-memory only: relay restarts clear rooms, and games are expected to recover through reconnect + snapshot resync or the solo fallback.

# V2.2

- Live progress now shows information streamed from OpenCode itself: the current todo item with plan progress, a one-line public summary of the model's narration (`💭 …`), and a small subtext line with session context usage (`🧠 context 62.4k / 100k · turn 8.1k · compacted 2×`). The status message stays minimal: only the current activity line is shown and older activity is dropped.
- AI-generated thread titles: when ThreadSite creates a new thread without an explicit `name`, a tiny `titler` agent session generates a concise title in parallel with the first build, and the thread is renamed after the build succeeds. Failures keep the slug name silently.
- `/site compact` triggers OpenCode's on-demand session compaction using the session's last model (or the configured global model).
- `/site revert` undoes the prior turn end-to-end: OpenCode conversation revert, `git reset --hard HEAD~1`, force-push to Forgejo, and republication of the previous site. Failed-but-unpublished turns only have their conversation reverted; reverting below the initial commit is refused.
- Surplus models are capped at a `SURPLUS_CONTEXT_CAP` artificial context window (default 100000 tokens, `0` disables). Auto-compaction fires relative to this ceiling, keeping long threads compact before provider windows fill.
- `ProjectRecord` now tracks `lastCommit` for safe reverts.

# V2.1.1

- Removed `asset_download` extension and MIME-type allowlists. The guarded downloader can now save any public HTTP(S) response beneath `site/assets/`, including JavaScript vendor modules, JSON/data, shaders, uncommon model formats, archives, and extensionless files.
- Kept URL/SSRF protection, redirect limits, destination traversal protection, download timeout, and `ASSET_MAX_BYTES`.
- Changed publication validation from a narrow static-extension allowlist to a small server-executable denylist. Unknown/arbitrary static file extensions are now allowed, while obvious Apache/server executable formats such as PHP/CGI/server-side scripts remain blocked.

# ThreadSite V2.1 changes

- Transport-aware OpenCode prompt recovery: `fetch failed`/socket/DNS/timeout failures no longer automatically become provider failures.
- Pre-prompt message snapshots plus persisted-message read-repair recover an already-running/completed OpenCode turn without re-sending the prompt.
- Event stream reconnect progress is shown publicly while detailed transport diagnostics remain private.
- OpenCode `/session/status` is treated as advisory; a persisted terminal assistant message wins over stale `busy` state.
- Recovery timeout attempts an HTTP session abort; if stop cannot be confirmed, ThreadSite skips rollback rather than racing a still-running agent.
- Recursive `Error.cause` serialization is included in JSONL logs and administrator DMs.
- Warn/error Docker log records use JSON output so nested causes are visible instead of `[Object]`.
- New `OPENCODE_RECONCILE_TIMEOUT_MS` and `OPENCODE_RECONCILE_POLL_MS` settings.

# ThreadSite V2 changes

- Live Discord progress message driven by OpenCode events and harness stages.
- Public failures show only an incident reference; detailed diagnostics are written to a private JSONL log and optionally DM'd to configured error-report users.
- `/site-admin errors` is restricted to explicit private error recipients.
- Provider retry/auth/rate-limit/billing/upstream failures are surfaced with clearer logging and hints.
- Site, 2D game, and 3D game `AGENTS.md` profiles strongly encourage sensible multi-file front-end architecture.
- OpenCode web search is enabled through Exa.
- Guarded `asset_download` custom tool can save public HTTPS image/audio/video/font/3D media into `site/assets/`, blocks local/private network targets, caps file size, and records provenance.
- 2D and 3D game guidance expanded for game loops, input, responsive/mobile behavior, performance, rendering structure, media research, and asset provenance.
- Automatic OpenCode context compaction is explicit; successful compaction is shown in progress and logged.
- Surplus Intelligence is available as the `surplus` custom OpenAI-compatible provider with startup model discovery and model-limit metadata when available.
- Forgejo is bound to loopback for host reverse proxying; Virtualmin/Apache proxy example and proxy checker included.
- Forgejo bootstrap no longer defaults to reserved username `admin`; default human admin is `forgeadmin`.
