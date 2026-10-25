# Maintenance and development

## Project cleanup

Deleting a Discord thread does not by itself remove the project registration, Forgejo repository, workspace, and published files. Cleanup lives in `bot/src/maintenance.ts` and is exposed through `start.sh`.

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

Each entry shows the Discord thread ID, project kind/status, display name and Forgejo repository. Listings cover registered projects; they do not discover unrelated Discord channels or Forgejo repositories.

For direct selection, names match exactly and options can be repeated. Commands preview by default; `--apply` executes the selected action:

```bash
./start.sh remove --thread 123456789012345678
./start.sh remove --game "My Game" --apply
./start.sh remove --repo site-my-game --apply
./start.sh forget --repo site-deleted-game --apply
```

Full removal deletes the selected Discord thread, Forgejo repository, workspace, published site/aliases and SQLite registration, then refreshes the site index. No backup is written by default; pass `--backup` to save a SQLite snapshot first. That snapshot contains metadata, not a copy of the deleted source files. Registration-only cleanup keeps the thread, repository and files. Existing agent session history and relay snapshots are retained.

Cleanup refuses queued/interrupted work, pending owner approvals, active agent turns, shared resources, unexpected workspace locations and paths through symlinks. Stop unfinished work with `/site stop`, clear `/site queue`, or let recovery finish first. During `--apply`, start.sh temporarily stops a running bot and restores its running state afterward, including on failure. Other services stay running. A failed removal retains the registration so the same selection can be retried; resources already deleted during that attempt are treated as absent on retry. Cleanup does not update the checkout, prune Docker volumes or remove unrelated data.

### Purging orphans from deleted threads

`purge` finds resources left behind when a thread disappeared without a clean teardown. It is read-only until `--apply`:

```bash
./start.sh purge
./start.sh purge --apply
./start.sh purge --apply --backup
```

The preview inventories, and reports counts for:

- registrations whose Discord thread no longer exists (error `10003`), which are torn down completely exactly like thread deletion;
- workspace folders under `WORKSPACE_ROOT/<guild>/<thread>` with no registered project, including their agent sessions;
- Forgejo repositories owned by the configured owner that carry the ThreadSite README or generated-repository description;
- published site folders (including `.staging-`/`.backup-` leftovers) with no registered project slug;
- generated push accounts (`push-*` restricted users) not referenced by a registration;
- relay worlds and usage records for threads with no registration.

Inventory is strict: if the agent, relay, or Forgejo inventory is unavailable the command stops instead of assuming everything is orphaned. Registered projects protect their repository IDs (including old-name redirects), workspace, all site slugs and aliases, push accounts, relay world and usage. Anything partially deleted is retained for a retry, and the command exits non-zero with the failing paths. Stop the bot during `--apply`; `start.sh` does that automatically and restores its previous running state even on failure. Run it after changing `WORKSPACE_ROOT` or `PUBLISH_ROOT`: folders outside the configured roots are never touched.

### Standalone stale-registration script

Deleting a repository directly in Forgejo does not remove its Discord project registration from SQLite, so a webhook warning for that repository can persist across bot restarts. A 404 can also mean lost access; confirm the repository was intentionally deleted before removing its registration.

The maintenance script previews exact repository-name matches by default and runs inside the existing bot image (no host Node needed):

```bash
docker compose run --rm --no-deps -T --entrypoint node bot --input-type=module - --repo DELETED_REPO < scripts/forget-projects.mjs
```

Repeat `--repo NAME` to select several repositories. After reviewing the preview, stop the bot and apply:

```bash
docker compose stop bot
docker compose run --rm --no-deps -T --entrypoint node bot --input-type=module - --repo DELETED_REPO --apply < scripts/forget-projects.mjs
docker compose up -d --no-deps bot
```

The script uses `STATE_DB_FILE` from the container, or an explicit `--db FILE`. It refuses projects with pending work and rolls back if a selected record changes during cleanup. It removes only the selected registrations; workspaces, published files, Forgejo repositories, and settings remain. Add `--backup` to save a full SQLite snapshot alongside the database first; the snapshot contains private state and is created with restrictive permissions.

## Local regression checks

GitHub Actions runs on pushes to `main`, pull requests, and manual dispatch:

- [CI](../.github/workflows/ci.yml) builds the bot and OpenCode tools, runs the bot/OpenCode/preview test suites, checks the gallery in Chromium, and checks Caddy's WebSocket routing and cache headers in Docker.
- [Multiplayer](../.github/workflows/multiplayer.yml) builds the networking client and relay, then checks relay/client behavior, restarts, durability, stalled hosts, deletion, player storage, saves, and leaderboards.

Both workflows use Node 24 and need no Discord or model credentials. Relay checks use temporary state. Docker preview integration and the opt-in real-language-server check remain separate checks described below and in [OpenCode](opencode-v2.md).

From `bot/`:

- `npm test`: production import containment, restart-safe queue handoff, naming, collisions, interrupted renames, revert coverage
- `npm run build`: bot compiler check
- `node --import tsx --test test/commands.test.ts`: validates the slash-command registration payload (required/optional ordering at every level); run for any command-definition change

From `preview/`: `npm test` for preview regression checks.

From `gameserver/`: `npm run build`, then the applicable `test:relay`, `test:client`, `test:restart`, `test:durable`, `test:stall`, `test:storage`, or `test:persistence` scripts. `test:relay` and `test:client` need a local test relay listening on port 8090 (or set `GAMESERVER_TEST_PORT` for an isolated relay); restart, durability, stall and persistence tests launch their own relay processes. Give restart/stall checks an isolated `GAMESERVER_STATE_DIR`; storage, durability and persistence checks create temporary state themselves. Player persistence checks cover save conflicts, quotas, leaderboard ordering, crash recovery and project deletion.

Networking client changes: from `bot/`, `npm run build:net` regenerates `bot/assets/threadsite-net.js` and `.d.ts`; never edit those generated assets directly.

Tests use temporary files, local git repositories, and a fake agent/Forgejo service; no Discord login or paid inference is needed.

Installer checks in the bot suite also need Bash and `jq`. They run the real install script against fake Discord and Docker commands in temporary directories. They cover configuration, credential failures, model availability, startup timeouts and preserving existing files on reruns.

### Preview integration tests

`npm --prefix preview ci && npm --prefix preview test` runs the offline suite. The browser smoke test additionally needs Docker:

```bash
docker build -t threadsite-preview-test:local ./preview
npm --prefix preview run test:browser
```

`npm --prefix preview run test:warmup` checks boot-time warm-up (browser already running before the first client, surviving client disconnects, per-client storage isolation). To verify screenshot delivery through the pinned OpenCode server without model tokens, build `docker build -t threadsite-opencode-test:local ./opencode` and run the browser test with `PREVIEW_TEST_OPENCODE_IMAGE=threadsite-opencode-test:local` in the environment.

The full Docker integration check:

```bash
npm --prefix preview run test:docker
```

It builds the production bot, OpenCode and preview images through the real Compose file, then uses an isolated Compose project and a scripted provider to exercise website, Excalibur and three.js projects: the real bot SDK harness drives agent file edits, browser forms/clicks/keyboard/navigation/scroll, desktop/mobile screenshots and reloads; the test checks screenshot bytes reach the provider, compares preview JavaScript with the final bot build byte for byte, runs validation, publishes and fetches the result from Apache. Excalibur rendering is also checked at desktop/phone sizes and 1×, 1.25× and 2× display density to catch stretched or undersized framebuffers. That check runs in a separate preview container so it does not compete with MCP's warm browser for the production process limit; run it alone with `npm --prefix preview run test:docker:pixels`. No real Discord login or paid model inference is used; fixture containers, volumes and temporary workspaces are removed afterward.

Preview and bot esbuild versions must match; the unit suite checks this to prevent compiler drift.

## Compose validation

From `caddy/`, run `node test-proxy.mjs` for isolated Docker checks of shared and dedicated WebSocket hosts, static files, cache headers and private relay routes.

After changing `docker-compose.yml`, run `docker compose config --quiet` from the repository root.
