# OpenCode runtime

ThreadSite runs OpenCode 2.1.4 with the pinned `@opencode/client` 2.1.4. The bot adapter is `bot/src/opencode-v2.ts`; the service policy is `opencode/opencode.json`.

The adapter implements session ownership, native inbox submission, persisted execution outcomes, live and saved usage, finish-up steering, provider failover, titles, compaction, conversation revert, stop/reset and project deletion. Persisted messages and live billing overlap and are reconciled rather than added.

The service uses HTTP Basic authentication with username `opencode`. `OPENCODE_SERVER_PASSWORD` is supplied to the bot and mapped to the server's `OPENCODE_PASSWORD`. The Docker healthcheck calls `/api/info`, and each project turn verifies that the ThreadSite native plugin loaded before submitting work.

Agent state is stored in `/opencode-data/v2`. Workspaces, repositories, static publications and the bot's usage ledger retain their configured locations.

## V2 runtime and commands

`opencode/v2/config.mjs` applies deployment settings to the native policy, including the independent general/explore models, step limit, project brief, MCP timeouts and compaction limits. `opencode/provider-config.mjs` loads host provider overrides and optional compatible catalogs. The Surplus public model fetcher remains enabled by `opencode/providers.json`; its credentials, endpoint, fallback models and context cap are configured through host JSON. See [host provider setup and pricing](deployment.md#opencode-providers-and-credentials). `snapshots` are disabled: the harness owns Git and rollback. The native plugin supplies the four guarded tools (`asset_download`, `asset_import`, `js_syntax_check`, `project_notes`) and `todoread`; v2's experimental `todowrite` is explicitly enabled. Unknown built-in tools, including worktree and terminal management, are removed. Shell commands and general/explore subagents run in the foreground. The inspection-only `browser-qa` subagent also supports `background: true`.

The shell policy permits `rg`, scoped `find` and `rm` for explicit editable paths inside `site/` or `scratch/`. The plugin rejects destructive find actions, traversal, rm shell operators/globs, symlinks, and removal of harness inputs such as `site/net/` or generated `site/js/`. The harness enforces dependency seeding, Git ownership, build validation, publication exclusions, symlink checks and static-site limits. These command permissions are application policy, not an operating-system sandbox.

Browser tools are absent for text-only or unknown models, checked both through session permissions and at each native model request. General/explore agents always have browser access disabled. Harness browser QA is independent and remains advisory.

Set `OPENCODE_BROWSER_QA_MODEL=provider/model-id` to enable a dedicated `browser-qa`
subagent. Blank disables it. The selected model must advertise image input and
cannot be overridden by the builder's tool call. This agent receives only browser
tools, including when its parent is text-only; it cannot edit files, delegate or
ask the user questions. Generated `AGENTS.md` instructs builders to delegate
bounded UI/gameplay inspections with the URL, viewports, controls and expected
behavior, then review the findings. Unavailable models and QA failures remain
advisory; static validation still applies.

With `background: true`, the builder can continue independent work while QA
inspects. Native results return automatically. The bot holds the original turn
open until QA finishes and the parent handles its report, so publication and
billing include the result. Recovery resumes a parked result using its original
message ID. Stop interrupts the child and drains its notification before the final
parent interrupt, preventing a late result from restarting the stopped turn.

Set `OPENCODE_SUBAGENT_MODEL=provider/model-id` in `.env` to select the model for
both `general` and `explore` subagents independently of the builder.
An unset or blank value keeps their configured default (`opencode/mimo-v2.6-flash-free`).
The selected provider must be available and have any required credentials.
Malformed model references fail service startup.

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
must not block work; agents can use installed declarations and other docs.

The `websearch` tool's provider is pre-selected from `OPENCODE_WEBSEARCH_PROVIDER`
(default `exa`; also `tavily`, `firecrawl`, `parallel`, `tinyfish`, `random`, or
`off` to remove the tool). Without a pre-selection, OpenCode asks a first-use
consent form that the question flow would surface to Discord users, who cannot
pick a provider or supply its credentials; the remembered choice also does not
survive a server restart. Provider keys (`EXA_API_KEY`, `TAVILY_API_KEY`,
`FIRECRAWL_API_KEY`, `PARALLEL_API_KEY`, `TINYFISH_API_KEY`) are optional —
Tavily and TinyFish fall back to keyless access, and empty variables are
ignored. An invalid provider name fails service startup with the allowed values.
Recreate `opencode` after changing these settings.

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
# Install @opencode/cli@2.1.4 separately, then provide its executable path.
OPENCODE_V2_BINARY=/absolute/path/to/opencode npm run test:opencode-v2
```

PowerShell:

```powershell
$env:OPENCODE_V2_BINARY = 'C:\path\to\opencode.exe'
npm run test:opencode-v2
```

This check covers native plugin loading, tool exposure, reasoning-effort request bodies, scripted root/child billing, general/explore delegation, background vision QA from a text-only builder (including screenshots, concurrent builder work, stopping and parked-result recovery), questions, live steering, durable notes, bounded titles, compaction, credentials, conversation revert, stopping a parked turn and session teardown. It retains the temporary directory printed in its result for inspection. It does not deploy the bot or test real provider quotas.

For a live throughput check, use the same `OPENCODE_V2_BINARY` with
`npm run test:opencode-v2-throughput` from `bot/`. It selects an available
zero-cost OpenCode model, follows a sequential read task in an isolated workspace,
and compares the live card and final rate with saved server timestamps/token counts.
Set `OPENCODE_THROUGHPUT_MODEL=opencode/model-id` to select another advertised free
model; paid models are rejected. Timing events, progress and `report.json` stay
in the printed temporary directory.

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
docker build -t threadsite-opencode:v2-check opencode
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
