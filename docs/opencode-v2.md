# OpenCode 2 migration

ThreadSite defaults to `OPENCODE_API_VERSION=v2`, running OpenCode 2.1.3 with the separately implemented `bot/src/opencode-v2.ts` and pinned `@opencode/client` 2.1.3. Set `OPENCODE_API_VERSION=v1` to use the retained original OpenCode 1.18.27 server and adapter (`bot/src/opencode-v1.ts`). The old package's `/v2` SDK entrypoint still targets the v1 server API; it is unrelated to OpenCode 2.

The bot's application interface remains stable: prompts with images and reasoning effort, questions and answers, live narration/private reasoning, plans and tools, root and child usage, finish-up steering, provider failover, titles, compaction, conversation revert, stop/reset and project deletion. The v2 adapter accepts an injected native client for contract testing. It uses native inbox submission and persisted execution outcomes instead of treating a prompt HTTP response as a completed turn. Persisted messages and live billing describe overlapping spend and are reconciled rather than added.

## Enable and roll back

First test a separate deployment with copied project state. Let active turns finish and drain the queue before switching an existing deployment. Back up the bot SQLite database and the OpenCode volume before the switch. The setting is deployment-wide; it does not route different projects to different server generations.

V2 is selected when the setting is absent. If an existing `.env` explicitly selects v1, update it:

```dotenv
OPENCODE_API_VERSION=v2
```

Then rebuild both affected services:

```bash
docker compose up -d --build --no-deps opencode bot
docker compose ps opencode bot
docker compose logs --tail=100 opencode bot
```

The existing password setting is translated to v2's `OPENCODE_PASSWORD`; v2's HTTP Basic username is always `opencode`. `OPENCODE_SERVER_USERNAME` applies to v1. The v2 Docker healthcheck uses `/api/info`, and each project turn checks that the ThreadSite native plugin loaded successfully before submitting work.

V2 stores agent state in `/opencode-data/v2`, retaining v1 state in its original location. It intentionally does not migrate v1 conversation history or credentials. Workspaces, repositories, static publications and the bot's usage ledger remain in their existing locations. After switching, reset idle project sessions with the existing session-reset controls; use `/site-admin reset` to reset all sessions. This preserves project source and starts sessions against the selected backend. Configure the desired builder, subagent and title models, and re-enter provider credentials in v2 if they were saved through the admin command rather than supplied through environment variables. Never reset a project while its old backend is still building.

To roll back, drain turns, set `OPENCODE_API_VERSION=v1`, rebuild both services with the same command and reset idle project sessions. V1's retained state remains available, but a conversation from one backend cannot continue in the other. Do not delete the persistent volume or project workspaces.

## V2 runtime and commands

`opencode/v2/config.mjs` produces native v2 configuration from the existing builder settings, preserving the independent general/explore models, step limit, project brief, MCP timeouts, compaction limits and Surplus catalog. `snapshots` are disabled: the harness owns Git and rollback. The native plugin supplies the three guarded tools (`asset_download`, `js_syntax_check`, `project_notes`) and `todoread`; v2's experimental `todowrite` is explicitly enabled. Unknown built-in tools, including worktree and terminal management, are removed. Shell commands and subagents run in the foreground so publication waits for their work to finish, matching the original turn lifecycle.

V2 adds `rg`, scoped `find` and `rm` for explicit editable paths inside `site/` or `scratch/`. The plugin rejects destructive find actions, traversal, rm shell operators/globs, symlinks, and removal of harness inputs such as `site/net/` or generated `site/js/`. Dependencies, Git writes, build ownership, publication exclusions, symlink checks and static-site limits are unchanged. These command permissions are application policy, not an operating-system sandbox.

Browser tools are absent for text-only or unknown models, checked both through session permissions and at each native model request. General/explore agents always have browser access disabled. Harness browser QA is independent and remains advisory.

### Language servers and documentation

Native v2 accepts `lsp` configuration but does not run servers itself. ThreadSite
restores the `lsp` navigation tool and diagnostics after edits using the MIT-licensed
[LSP bridge](https://github.com/christensenjairus/opencode-v2-lsp-support), vendored
at commit `4a17bc8379e572ab104ec26b55f92ee9b51dce37`. It is composed into the native
ThreadSite plugin; no runtime download or separate plugin installation is needed.
TypeScript, HTML, CSS and JSON servers are already installed in the image and start
lazily per project. Only harness-supplied settings select commands; generated
project configuration is never consulted by the bridge. Navigation rejects paths
and symlinks outside the current project, and servers shut down when the plugin
unloads. TypeScript uses lenient ES2022 inferred-project settings without creating
a `tsconfig.json` or downloading additional types. LSP diagnostics are advisory;
the mandatory compiler/build/static gates remain authoritative.

[Context7](https://github.com/upstash/context7) is enabled for v2 as a remote,
read-only documentation MCP at `https://mcp.context7.com/mcp`. Only its
`resolve-library-id` and `query-docs` tools are admitted, including for text models
and general/explore subagents. Browser permissions are independent. Indexed docs
may not cover an installed version, so project instructions prioritize installed
declarations and compiler results. Queries should contain public API questions,
never private source, credentials or user conversation text.

No Context7 key is required; optionally set `CONTEXT7_API_KEY` for higher limits.
The key is passed as a bearer header, kept out of checked-in config and tool
results. Set `CONTEXT7_ENABLED=0` to disable the connection. Recreate `opencode`
after either setting changes. Connection, rate-limit or documentation failures
must not block work; agents can use installed declarations and other docs. V1's
configuration and LSP runtime are unchanged.

The `websearch` tool's provider is pre-selected from `OPENCODE_WEBSEARCH_PROVIDER`
(default `exa`; also `tavily`, `firecrawl`, `parallel`, `tinyfish`, `random`, or
`off` to remove the tool). Without a pre-selection, OpenCode asks a first-use
consent form that the question flow would surface to Discord users, who cannot
pick a provider or supply its credentials; the remembered choice also does not
survive a server restart. Provider keys (`EXA_API_KEY`, `TAVILY_API_KEY`,
`FIRECRAWL_API_KEY`, `PARALLEL_API_KEY`, `TINYFISH_API_KEY`) are optional —
Tavily and TinyFish fall back to keyless access, and empty variables are
ignored. An invalid provider name fails service startup with the allowed values.
Recreate `opencode` after changing these settings. V1 predates the consent form
and reads only `OPENCODE_ENABLE_EXA`.

Native synthetic steering uses `delivery: "steer", resume: false`, preserving the running model/variant and preventing an idle session from starting another turn. Stop cancels inbox entries and pending forms before interrupting without resume, then verifies idle. A lost submission response is reconciled against its message ID; it is never blindly resent. Recovery deadlines measure inactivity, exclude pending questions, and preserve partial source edits.

## Verification

Use Node 24:

```bash
cd opencode
npm ci
npm run build
npm test
cd ../bot
npm ci
npm test
npm run build
```

The opt-in real-server check launches an isolated OpenCode executable, temporary workspaces/state and a local scripted model provider. It requires no paid provider or production credentials:

```bash
# Install @opencode/cli@2.1.3 separately, then provide its executable path.
OPENCODE_V2_BINARY=/absolute/path/to/opencode npm run test:opencode-v2
```

PowerShell:

```powershell
$env:OPENCODE_V2_BINARY = 'C:\path\to\opencode.exe'
npm run test:opencode-v2
```

This check covers native plugin loading, tool exposure, scripted root/child billing, questions, live steering, durable notes, bounded titles, compaction, credentials, conversation revert, stopping a parked turn and session teardown. It retains the temporary directory printed in its result for inspection. It does not deploy the bot or test real provider quotas.

The smoke test uses an isolated Context7-compatible server to verify that both
documentation tools survive the native tool filters and permissions, while an
unexpected tool is removed. Set `OPENCODE_LSP_SMOKE_COMMAND` to a JSON command
array (for example `["typescript-language-server","--stdio"]`) to also check
post-edit TypeScript errors and hover results through the real v2 agent loop.
Set `OPENCODE_DOCS_SMOKE_OFFLINE=1` to check that an unavailable documentation
service leaves ordinary builder work operational.

To exercise all four real language servers and the upstream boundary/cancellation
suite in Linux after building the v2 image:

```bash
docker build --build-arg OPENCODE_API_VERSION=v2 -t threadsite-opencode:v2-check opencode
docker run --rm --entrypoint sh threadsite-opencode:v2-check -c 'cd /opt/threadsite && THREADSITE_TEST_LANGUAGE_SERVERS=1 npm test'
docker run --rm --entrypoint node threadsite-opencode:v2-check /opt/threadsite/v2/vendor/lsp/test-opencode-lsp.js /opt/threadsite/v2/vendor/lsp
```

The upstream test assertions use POSIX path separators; run that suite in Linux.

## Live free-model end-to-end check

Run `npm --prefix preview run test:free-models` under Node 24 with Docker running.
This opt-in check sends synthetic test prompts to real anonymous OpenCode free
models; it does not log into Discord or use deployment credentials. It verifies
the live catalog's zero-cost tiers before selecting MiMo-V2.6-Flash Free and
GLM-5.3-Flash Free. If either is unavailable, the check fails rather than selecting
a paid model.

Each run creates a separate Compose project, fresh workspaces/state/volumes and
an isolated Forgejo account. It runs production ProjectService creation and
revision, LSP diagnostics/navigation, Context7, questions, delegation, compiler
and static validation, live steering, Git push, publication, document readback and usage
accounting and a real screenshot sent back through the prompt image-input API.
Browser checks exercise the generated website and Three.js game on desktop and
mobile, including WebGL pixels and keyboard input. Compiler output must match
preview; published output may differ only by asset-version URL rewriting.
All containers and test volumes are removed afterward;
source, reports and screenshots remain in the temporary directory printed by
the runner. Free-model availability, rate limits and model compliance can make
this live check fail independently of the deterministic tests.
