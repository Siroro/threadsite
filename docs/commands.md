# Discord commands

## Creating projects

In a normal text channel:

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

Every normal message in a registered thread becomes the next mutation of the same site. Reply while a turn runs to steer it live — the message is submitted straight into the running agent turn and folded into the current work instead of waiting for the next pass. When the agent asks a question mid-turn, the requester gets pinged with answer buttons.

Each project thread also gets a **pinned project card** — type (site/2D/3D), game engine, multiplayer setting, original request, advisory Browser QA status, lifetime usage, and links — that updates itself after every turn. Settings appear above the request; older pinned cards refresh on the next bot restart. Model routing and spend details stay in admin views.

## Project thread commands

- `/site info` shows the live URL, source repository, model, and last error.
- `/site republish` republishes the current static tree without spending model tokens.
- `/site sync` pulls commits that were pushed to the repository from outside the bot (e.g. with a repo push key) into the workspace, rebases any local-only commits on top, rebuilds, and republishes from the result. It is the manual recovery path when a push from Discord was rejected because the remote had moved ahead.
- `/site pushkey` issues repo-scoped git push credentials for this thread's repository; see [Repo push keys](#repo-push-keys-site-pushkey).
- `/site compact` asks the agent to compact this thread's session context immediately.
- `/site stop` interrupts the running turn — even when its live status message was deleted or never rendered — while keeping the agent session, workspace, edits, and history.
- `/site queue` shows the messages waiting for the next update pass and offers a cancel button for each waiting entry.
- `/site revert` undoes the last accepted turn: it reverts the agent conversation, resets git to the previous commit, force-pushes the repository, and republishes the previous site.
- `/site rename name:"Fresh Name"` renames the project and refreshes both links without asking the model.
- `/site multiplayer mode:<arena|rooms|singleplayer>` switches a game's architecture live.

## Live progress during a turn

While a turn runs, its Discord message updates in place as a live status card:

- a **Prepare → Build → Check → Publish** stage rail, with the current activity and its duration during longer operations;
- the request being handled and a short excerpt of the agent's public update;
- the actual todo plan, with completed, current, pending and skipped work;
- changed-file counts, added/removed lines and relative filenames;
- input/output tokens, cache share, context-window usage, model steps and generation speed when available (the model name itself is never shown);
- a timestamped recent-activity trail, action counts, saved requests waiting for the next pass, and project links.

Questions switch to a shorter amber card with the question, option descriptions and answer/skip buttons close at hand, including on mobile. The selected answer and responder remain visible afterward. The Stop button remains available while work runs. A full context window is shown as context usage, not a percentage estimate of how close the whole job is to completion. Provider spend, the model name and private reasoning are never included in the public card.

Lifetime token usage is stored in `data/bot/usage-log.jsonl` (`USAGE_LOG_FILE` inside the bot container). Turns have stable IDs, so restart recovery updates the same entry rather than counting it twice. Billing is reconciled from OpenCode's persisted message history, including subagents, and flushed before clearing the recovery marker. Startup also backfills older zero-token entries where saved history is still available and refreshes affected pinned cards. Keep both the bot data and OpenCode data volumes when rebuilding services. If the provider never reported counts, or the original session was deleted, missing historical tokens cannot be reconstructed; the card shows "token counts unavailable" when no counts are known.

Because HTTP request timeouts to the agent service are disabled by design, a provider that stops emitting events would otherwise leave the card heartbeating forever. The card therefore tracks real agent activity (not its own heartbeat) and, after `TURN_STALL_WARN_MS` without any event, switches to an amber **No progress for Nm** state that points at `/site stop`. The warning is suppressed while the thread is queued or waiting for an answer, where idleness is expected. It is a visible watchdog, not an automatic abort.

`/site stop` (and the Stop button) aborts only the running agent turn: the session, workspace, partial edits, and git history are kept. It is deliberately not queued, so it still works when the turn is wedged on an unreachable agent or when the live status message was deleted before the button could be pressed. A stop lands in every phase: while the turn prepares, while it runs, while recovery waits, and even mid-reconcile — none of them resurrect the stopped turn. `/site queue` lists the backlog with its authors and offers **Cancel N** buttons; cancelling withdraws one waiting request from both the in-memory batch and SQLite and marks its acknowledgement message cancelled. Requests already being prepared by a drain are reported as in-flight instead of being silently removed.

### Steering a running turn

A reply sent while a turn is running is not queued — it **steers the live turn**. The message is submitted straight into the busy agent session (the same delivery path the agent platform's own TUI uses), where the model reads it mid-turn as an amendment to the current task and folds it into the work in progress. Nothing is aborted and nothing restarts; the acknowledgement says so and the status card shows the steering line. Steers that cannot land — no live turn, a turn in its build/commit/publish tail, messages carrying images, or the agent service rejecting the submission — fall back to the normal queue untouched, so a steering attempt can never lose a message.

When the agent asks a question mid-turn, the person who requested the turn gets a Discord ping pointing at the answer buttons on the status card, so a parked question (which holds the turn and the thread's queue open) cannot sit unseen.

Edits respect `PROGRESS_UPDATE_MS`, coalesce rapid events and serialize Discord requests. Quiet turns retain a heartbeat, and stale live throughput estimates disappear. Closing a feed waits for its last edit before posting the final result so a late update cannot overwrite it. Servers without **Embed Links** permission automatically get a compact text version with the same controls. Final messages clear the live card and retain the agent's outcome summary; successful browser-QA screenshots are still posted normally.

### AI-generated thread titles

When `/site start` or `/makegam` creates a new thread and no explicit `name` option was given, a parallel `titler` session generates a concise title. After the first successful build, that title becomes the Discord thread name, source repository name and public site URL. Explicit names get the same URL treatment. For example, **Sumo Shove** becomes repository `site-sumo-shove` and `https://…/sumo-shove/`; a short unique suffix is added only when the name is already taken. If title generation fails or times out, the original name remains.

`/site rename` updates the repository, git remote, README and gallery. Existing site links redirect to the new address, including existing subpages, query strings and fragments; Forgejo keeps its repository redirects. Renames preserve the multiplayer tenant and its world state. A durable rename record lets delivery resume after a disconnect or restart, and the bot checks repository IDs before resuming so an unrelated repository is never adopted. Thread-title changes that fail are retried after restart.

Rename commits are metadata, not an additional agent turn: `/site revert` undoes the complete previous agent turn while preserving the current project name and links, including in projects renamed by older versions.

### `/site compact` and `/site revert`

- `/site compact` requests on-demand compaction for the thread's session using the model the session last used (or the globally configured model). Useful after very long threads even with automatic compaction. The published site is untouched.
- `/site revert` undoes the prior turn end-to-end: the agent conversation is reverted to before the last request (the model will not remember the undone turn), the workspace is reset to the previous commit, the commit is force-pushed away from the public Forgejo repository, and the previously published site is restored. If the last turn had failed before publishing, only its conversation is removed and git is left alone. Reverting below the initial creation commit is refused.

## Repo push keys (`/site pushkey`)

Forgejo has no per-repository HTTP tokens, so a ThreadSite push key is a dedicated **restricted Forgejo account** (username `push-xxxxxx`, random password) with Write permission on exactly one project repository. Restricted accounts can see nothing else on the instance, so handing out a key is scoped to that repo's git history only.

- `/site pushkey` in a project thread issues (or re-shows) that thread's key as a clone URL plus username/password. `/site pushkey rotate: true` replaces it — the old account is deleted, which revokes the old credentials immediately.
- Push-key holders push to `main` like any collaborator. **A push does not go live by itself**: the bot detects it and posts an **External push detected** message in the thread with **Publish** / **Dismiss** buttons. Detection uses a Forgejo push webhook by default, with polling of each ready repo's `main` tip every `EXTERNAL_PUSH_POLL_MS` (default 60 s) as a safety net for hook setup or delivery failures. `WEBHOOK_ENABLED=0` uses polling alone; `EXTERNAL_PUSH_POLL_MS=0` disables polling. Webhook setup failures are logged but do not stop project creation or renaming. Forgejo will not call a private address unless it is allowlisted, so `FORGEJO_WEBHOOK_ALLOWED_HOSTS` (default `bot`) must name the host in `WEBHOOK_PUBLIC_URL`; change the two together.
  - **Publish** syncs the workspace to the pushed commit, rebuilds, validates, and publishes through the normal pipeline. If validation fails, the live site keeps the previous version, the workspace rolls back to the last published commit, and the thread sees the validation errors (the commit stays in the repo).
  - **Dismiss** adopts the commit into the workspace and git history only; the live site is unchanged and the next thread message builds on the pushed code.
- The bot's own pushes rebase on top of any external commits first, so an accepted external push never breaks the next Discord turn.
- `/site sync` is the manual counterpart: it pulls whatever is on `main` into the workspace (rebasing a rejected local commit on top), pushes, rebuilds, and republishes — the recovery path when a bot push was rejected with non-fast-forward, when the external push predates the poller's marker, or when the Publish button message is gone. It refuses while an agent turn is live and while the workspace still holds uncommitted edits from a failed turn.
- Keys require `secrets/forgejo-admin-token` (created by `./scripts/bootstrap-forgejo.sh` alongside the service token); the admin token is used solely to create/delete the restricted push accounts. Credentials are stored in the bot's private state file and are visible to anyone who can read the thread, which is the intended audience.
- Deleting the project (thread deletion) deletes the repo; the push account itself can be removed by rotating or deleting it in the Forgejo admin UI.

## Admin commands

`/site-admin status` shows the active model, agent-service health, web/asset status, multiplayer relay health, private-error recipient count, and log path.

`/site-admin model model:provider/model-id` changes the model for all future turns, including existing site threads. Use `default` to go back to the platform's default selection.

`/site-admin token provider:anthropic token:...` replaces the persisted provider credential. `/site-admin token-clear` removes it.

The command is registered with Discord's **Manage Server** default permission and is also runtime-checked. `DISCORD_ADMIN_USER_IDS` can add explicit user IDs. Detailed failure DMs go only to `DISCORD_ERROR_REPORT_USER_IDS` (or the explicit admin-ID list when the error list is left blank). `/site-admin errors` is additionally restricted to those configured private error recipients, so other server managers do not get provider diagnostics.

## What each accepted message does

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

The git commit is deliberately performed by the harness rather than by the model. Commits read like real history: the subject is the Discord request itself (truncated to one line), the **author** is the Discord user who sent it (display name, with a `@username@users.noreply.discord.com` noreply email), and the bot is the committer plus a `Co-authored-by:` trailer — `SiroroBot` by default, configurable with `COMMIT_BOT_NAME`/`COMMIT_BOT_EMAIL` (set the email to the Forgejo service account's address to link its avatar in Forgejo).
