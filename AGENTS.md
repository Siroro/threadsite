# ThreadSite

Discord threads become static sites and browser games. This repo runs the bot, OpenCode v2 service, preview compiler and multiplayer relay.

## Working here

- Check `git status` first; preserve unrelated edits and deletions. Use TypeScript/ESM with `.js` imports and follow nearby code.
- Keep changes focused. Update tests for meaningful behavior, and update README / `.env.example` when commands or configuration change.
- No low-quality tests. Do not add tests that assert prose, labels or wording rendered elsewhere, restate constants the code sets, or otherwise pass by construction (tautological). Tests must exercise behavior: state transitions, limits, routing, failure and recovery paths, not echo text the code already owns.
- Report the result, checks and material limitations concisely. Omit deployment reminders and commands unless deployment is requested.
- Preserve `data/`, secrets, volumes and live workspaces. On Windows, use literal PowerShell paths and verify recursive deletion/move targets.

## Where to look

- `bot/src/project.ts`, `store.ts`: project lifecycle, durable queue, recovery and publication.
- `bot/src/opencode-v2.ts`; `opencode/v2/`: agent transport, native configuration, tools and permissions.
- `bot/src/commands.ts`, `index.ts`: Discord registration and handlers. Required options precede optional options at every nesting level.
- `bot/src/git.ts`, `build.ts`, `publish.ts`: source control, validation and atomic publication.
- `bot/src/templates.ts`, `bot/assets/agents/`: generated-project instructions; `bot/assets/skills/`: their implementation references. Edit these sources, not live workspaces.
- `bot/networking/threadsite-net.ts`: client source.
- `gameserver/`: relay; `preview/`: isolated preview/browser QA; `docker-compose.yml`: service wiring.

## Contracts to preserve

- One thread owns one workspace, session and repository. Keep queue claims and turn IDs durable. After ambiguous transport failures, reconcile status/history before retrying or touching a possibly running workspace.
- Reconcile live and saved usage without double-counting; flush it before clearing recovery markers. Missing provider counts are unavailable, not zero.
- Build/type/static validation blocks publication; browser QA is advisory and fail-open. Retain actionable findings, filter preview/environment noise, and push accepted source before atomically replacing the live site.
- Renames retain repository/tenant identity and old URL redirects. Naming and deletion intent survive failures/restarts; automatic naming preserves dirty failed-turn edits. See [architecture](docs/architecture.md) and [thread deletion](docs/thread-deletion.md).
- Route generated-workspace Git through `bot/src/git.ts` with explicit canonical paths. No `safe.directory=*`, inherited Git routing or fallback to the server checkout.
- Preserve inactivity-based recovery, pending-question pauses, and one finish-up steer at 90% of root steps. Never restart an idle/stopped turn to steer it. See [turn safeguards](docs/agent-turns.md).
- Browser MCP requires advertised image input; unknown capabilities and general/explore subagents get no browser tools. Optional `browser-qa` uses its configured vision model and browser tools only. It may run in the background; retain turn ownership/billing until its report is handled, and drain notifications on stop. Findings stay advisory.
- Generated projects stay static and confined to their workspace. Keep import/symlink/size limits and publication exclusions. Preview and production compilation must agree; scratch views are isolated and never shipped.
- Keep client, relay, declarations and instructions aligned. Preserve arena/rooms/singleplayer mode and offline solo fallback. Generated games follow the requested genre and mechanics.
- Completed turns show a technical card and a playable reply. Read agent-maintained `DESCRIPTION.md` / `CHANGELOG.md` after each turn; missing docs must not suppress its report.
- Keep secrets/private diagnostics out of generated sites and public Discord messages. Cleanup must retain retry records after partial failures; only Discord error 10003 confirms an absent thread. See [maintenance](docs/maintenance.md).

## Checks

Use Node 24 and run commands in the component directory; there is no root npm package.

| Change | Checks |
| --- | --- |
| Bot | `npm test` |
| Discord commands | Also `node --import tsx --test test/commands.test.ts` |
| Networking client | Relevant relay/client checks |
| Relay | Applicable `test:relay`, `test:client`, `test:restart`, `test:durable`, `test:stall`, `test:storage`, `test:persistence`, `test:leaderboards`, `test:delete` |
| OpenCode v2 | `npm test` in `opencode/` |
| Preview / provider adapter | `npm test` in `preview/`; relevant browser/Docker checks for integration changes |
| Docs/instructions | Check referenced paths/commands and generated variants; `git diff --check` |

Relay/client tests need a test relay on port 8090; the other relay tests launch their own. Give restart/stall checks an isolated `GAMESERVER_STATE_DIR`; storage, durability and persistence checks create temporary state themselves.
