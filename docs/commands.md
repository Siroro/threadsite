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

By default, every normal message in a registered thread becomes the next mutation of the same site. Reply while a turn runs to steer it live — the message is submitted straight into the running agent turn and folded into the current work instead of waiting for the next pass. Message attachments always queue for the next pass: images reach the model when it can see them, and every other file type is saved into the project's workspace, where the agent reads reference material in place and installs binaries such as sprites or audio into the site with the `asset_import` tool. When the agent asks a question mid-turn, the requester gets pinged: a single simple choice answers with quick buttons, longer option lists open a select menu, and a multi-question request opens an **Answer questions** form (radio groups, checkbox groups, selects and free text as appropriate) that submits every question together. **Write another answer** allows a custom reply for any question, drafts are saved per person until submitted, and a delivery that fails on the wire is reconciled against the agent before offering a retry.

Each project thread also gets a **pinned project card** — a thumbnail of the newest screenshot, the project's own description, type (site/2D/3D), game engine, multiplayer setting, the user who started the thread as a profile link, a Contributors section counting each person's requested turns, live steers and delivered answers (busiest first, past eight rows summarized), original request, advisory Browser QA status, lifetime usage, and Play/Open and Source buttons — that updates itself after every turn. It also carries the project's controls: **Make a change** opens a private request form (with optional attachments), **Project details** opens a private panel with the description, changelog, original request and lifetime usage, and **Queue** lists saved requests. All project cards use Discord Components V2, with matching accent colors, headings and separated sections. Settings appear above the request; pinned cards refresh at startup, upgrading existing pinned embeds in place. Model routing and spend details stay in admin views.

## Project collaboration

Projects, including existing projects, default to **Anyone can edit**. Open **Collaboration** on the pinned project card or run `/site collaboration` to see the current editing policy. The human thread owner can change the mode and choose up to 25 contributors with Discord's user selector. For threads created by the bot, the person who started the project is the owner; when attaching a project to an existing human-owned thread, its thread owner controls access. Legacy projects fall back to the recorded starter when a human thread owner is unavailable. Server administrators (Manage Server or the configured admin allowlist) can also manage access. Discord thread permissions still apply.

| Mode | Who can contribute |
| --- | --- |
| Anyone can edit | Anyone who can send messages in the thread |
| Selected contributors | The owner, administrators and selected people; an empty selection allows only the owner and administrators |
| Owner approves requests | The owner, administrators and selected people edit directly; everyone else submits changes for review |

In approval mode, ordinary messages, replies intended as live steers and **Make a change** forms from outside contributors become pending requests. They do not reach the agent or change the workspace. The owner is notified and can use **Review request** to read the full prompt and download its attachments privately, then **Approve** or **Reject**. Approving adds that one request to the durable update queue under its original author; it grants no ongoing editing rights and never steers an already-running turn. Its author may answer the agent's questions during that approved turn. Other project controls remain restricted to contributors.

Settings, selected people and pending approvals survive restarts. Discord attachment bytes are saved privately in SQLite before their URLs expire; non-image files enter the workspace only after approval. A project can hold 20 pending requests, each with up to 4 attachments totalling 8 MiB and a 6000-character prompt. Preparation failures retain the request for another approval attempt. Approval and queue admission are atomic, so duplicate clicks and restarts cannot enqueue the same approval twice. Pending requests remain pending if the editing mode changes; review them explicitly.

The policy covers messages, live steers, request/answer forms, Stop, queue cancellation, rollback, mutating `/site` commands and external-push Publish/Dismiss controls. Info, project details and queue viewing stay readable to thread members. Stale forms and controls recheck current settings; queued management actions recheck them when they run. A change already accepted into the update queue or already running retains its authorization and may finish. Repository push credentials are issued privately to the owner or administrators only; previously shared Git credentials remain valid until rotated, and external pushes still require an authorized Discord publication decision.

## Project thread commands

- `/site info` shows the live URL, source repository, model, and last error.
- `/site collaboration` shows editing mode, contributor selection and pending approval requests; only the owner and administrators can change settings or decide approvals.
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

While a turn runs, its Discord message updates in place as a compact live status card:

- a **Prepare → Build → Check → Publish** stage rail, with the current activity and its duration during longer operations;
- the current plan task and progress counts, plus the most recent of the agent's public updates;
- the last few public agent updates, so readers can follow the work without opening anything;
- saved requests waiting for the next pass, and project links.

Everything longer stays one click away in a **private Turn details panel**: the complete plan, changed files with paths, input/output tokens, cache share, context-window usage, model steps, the full public update history, the model's raw thinking as it happened, the timestamped activity trail, past questions and merged requests. The panel pages long sections without dropping text; the public card never grows back to its old height. While the turn runs, the panel reads the live in-memory state, so Refresh always shows this instant; Discord has no push channel for a private reply, so the panel updates when opened or refreshed rather than streaming.

Questions pin an amber **Waiting for your answer** block to the card with native controls: quick secondary buttons for a single simple choice, a select menu for longer lists (with multi-select for multiple-answer questions), an **Answer questions** modal for bigger requests, and **Write another answer** for free text. Answers are reviewed on a private card and submitted as one complete batch; drafts survive restarts, and submitting again after a transport failure reconciles against the agent instead of double-answering. The decision and who made it remain visible afterward. Turn details owns the top-right corner in the primary colour, and Stop sits in the bottom action row in red, scoped to that turn so an old card can never stop a newer one. Provider spend, the model name and private reasoning are never included in the public card; the raw thinking trail is reachable only from the owner-only Turn details panel.

Lifetime token usage is stored in `data/bot/usage-log.jsonl` (`USAGE_LOG_FILE` inside the bot container). Turns have stable IDs, so restart recovery updates the same entry rather than counting it twice. Billing is reconciled from OpenCode's persisted message history, including subagents, and flushed before clearing the recovery marker. Startup reconciles saved turn IDs, session IDs and time boundaries against persisted history, then refreshes the pinned cards. Keep both the bot data and OpenCode data volumes when rebuilding services. If the provider never reported counts, or the original session was deleted, missing historical tokens cannot be reconstructed; the card shows "token counts unavailable" when no counts are known.

Because HTTP request timeouts to the agent service are disabled by design, a provider that stops emitting events would otherwise leave the card heartbeating forever. The card therefore tracks real agent activity (not its own heartbeat) and, after `TURN_STALL_WARN_MS` without any event, switches to an amber **No progress for Nm** state that points at `/site stop`. The warning is suppressed while the thread is queued or waiting for an answer, where idleness is expected. It is a visible watchdog, not an automatic abort.

`/site stop` (and the Stop button) aborts only the running agent turn: the session, workspace, partial edits, and git history are kept. It is deliberately not queued, so it still works when the turn is wedged on an unreachable agent or when the live status message was deleted before the button could be pressed. A stop lands in every phase: while the turn prepares, while it runs, while recovery waits, and even mid-reconcile — none of them resurrect the stopped turn. Stop controls on a card are bound to their own turn, so a stale card cannot interrupt a turn that started later. A failed turn's **Rollback edits** choice asks for confirmation and re-checks, inside the project queue, that no newer turn has accepted work before discarding; **Keep edits** is always safe and idempotent. `/site queue` (and the Queue button) lists the backlog in a private panel with its authors and offers **Cancel N** buttons; cancelling withdraws one waiting request from both the in-memory batch and SQLite and marks its acknowledgement message cancelled. Requests already being prepared by a drain are reported as in-flight instead of being silently removed.

### Steering a running turn

A reply sent while a turn is running is not queued — it **steers the live turn**. The message is submitted straight into the busy agent session (the same delivery path the agent platform's own TUI uses), where the model reads it mid-turn as an amendment to the current task and folds it into the work in progress. Nothing is aborted and nothing restarts; the acknowledgement says so and the status card shows the steering line. Steers that cannot land — no live turn, a turn in its build/commit/publish tail, messages carrying attachments, or the agent service rejecting the submission — fall back to the normal queue untouched, so a steering attempt can never lose a message.

When the agent asks a question mid-turn, the person who requested the turn gets a Discord ping pointing at the answer buttons on the status card, so a parked question (which holds the turn and the thread's queue open) cannot sit unseen. The ping is a doorbell, not a record: it is deleted again as soon as the question is answered or skipped, leaving the answer visible on the status card.

Edits respect `PROGRESS_UPDATE_MS`, coalesce rapid events and serialize Discord requests. Quiet turns retain a heartbeat, and stale live throughput estimates disappear. Average tok/s uses output plus reasoning tokens divided by their matching provider-active windows, excluding tool waits. Saved windows restore the live average after stream gaps; replayed steps count once. Missing or invalid windows contribute neither tokens nor time to the rate, while their reported tokens remain billed. Completed steps replace burst-based live estimates immediately. Closing a feed waits for its last edit before posting the final result so a late update cannot overwrite it. The text and controls are native V2 components and do not require legacy embeds. Completion, failures, cancellation and reset replace the panel in V2 as well; answering a question or choosing what to do with partial edits keeps the message visible.

## The final post of a turn

When a turn finishes, it is presented in two messages:

- the turn's **own message** becomes the technical card — the agent's full report of what it did, kept as the model wrote it, plus the commit, the files and lines changed, how long it took, and the token usage of the turn;
- a **reply** to it carries the playable card — the browser-QA screenshot when one was captured, what the project is and how to play it, what this turn changed, and the play link next to the source link.

Both cards keep working after the turn: the technical card adds **Turn details**, **Changed files**, **Browser findings** and a **Follow up** request form, and the playable card adds **How to play**, **Changelog** and **Request a change**. Each opens that turn's saved data in a private panel, so details stay available on old turns and after restarts.

The cards come from two documents the agent maintains in the project root, so nothing has to be generated after the fact:

- **`DESCRIPTION.md`** — what the project is, in a visitor's words, in two parts: a one-sentence headline of at most 25 words, plus a `## How to play` section the rules cap at four short paragraphs (~120 words) — goal first, then controls, then a tip or two; still no file names, no code, no jargon, updated whenever the project's shape changes.
- **`CHANGELOG.md`** — one section per turn, newest at the top, saying what a visitor will notice. The agent adds its section before its final summary.

The agent also maintains **`README.agent.md`**. At the end of every turn the harness regenerates `README.md` with the project title, ownership marker, live link, original request and submitter, then appends the agent's README section. `README.md` itself is not agent-editable, so direct edits are lost. Because the repository is public, the original request and the submitter's display name are published there.

The harness reads both card documents after every turn: the playable card shows the description headline and the newest changelog entry, the pinned card shows the headline, and the full how-to-play opens from the card's **How to play** button. A project that has neither document yet still renders the card: the original request stands in for the description, and a turn without a screenshot still shows the card. The technical card includes Play/Open, Source and View commit buttons. Reports that exceed the combined V2 text limit include a readable excerpt and the complete report as an attached `turn-report.md` file. If screenshot delivery is denied, the Play card retries without the image, keeping its text and buttons.

### AI-generated thread titles

When `/site start` or `/makegam` creates a new thread and no explicit `name` option was given, a parallel `titler` session generates a concise title. After the first successful build, that title becomes the Discord thread name, source repository name and public site URL. Explicit names get the same URL treatment. For example, **Sumo Shove** becomes repository `site-sumo-shove` and `https://…/sumo-shove/`; a short unique suffix is added only when the name is already taken. If title generation fails or times out, the original name remains.

`/site rename` updates the repository, git remote, README and gallery. Existing site links redirect to the new address, including existing subpages, query strings and fragments; Forgejo keeps its repository redirects. Renames preserve the multiplayer tenant and its world state. A durable rename record lets delivery resume after a disconnect or restart, and the bot checks repository IDs before resuming so an unrelated repository is never adopted. Thread-title changes that fail are retried after restart and before another builder turn; new work waits until the rename is acknowledged. Final repository names use the readable project slug without a temporary `site-`/`game-` prefix.

Initial automatic naming is persisted before the first build, so resumed builds finish it too. If the selected title model fails or returns an unusable name, the bot tries a different available model (up to three attempts, each bounded to 20 seconds plus cleanup). If models are unavailable, a readable name derived from the original request is used. The chosen name is saved before remote changes. Automatic naming can preserve partial failed-turn edits without building or publishing them; the last accepted site moves to the new URL.

Rename commits are metadata, not an additional agent turn: `/site revert` uses the saved turn boundary while preserving the current project name and links.

### `/site compact` and `/site revert`

- `/site compact` requests on-demand compaction for the thread's session using the model the session last used (or the globally configured model). Useful after very long threads even with automatic compaction. The published site is untouched.
- `/site revert` undoes the prior turn end-to-end: the agent conversation is reverted to before the last request (the model will not remember the undone turn), the workspace is reset to the previous commit, the commit is force-pushed away from the public Forgejo repository, and the previously published site is restored. If the last turn had failed before publishing, only its conversation is removed and git is left alone. Reverting below the initial creation commit is refused.

## Repo push keys (`/site pushkey`)

Forgejo has no per-repository HTTP tokens, so a ThreadSite push key is a dedicated **restricted Forgejo account** (username `push-xxxxxx`, random password) with Write permission on exactly one project repository. Restricted accounts can see nothing else on the instance, so handing out a key is scoped to that repo's git history only.

- `/site pushkey` in a project thread issues (or re-shows) that thread's key privately to the owner or a server administrator as a clone URL plus username/password. `/site pushkey rotate: true` replaces it — the old account is deleted, which revokes the old credentials immediately.
- Push-key holders push to `main` like any collaborator. **A push does not go live by itself**: the bot detects it and posts an **External push detected** message in the thread with **Publish** / **Dismiss** buttons. Detection uses a Forgejo push webhook by default, with polling of each ready repo's `main` tip every `EXTERNAL_PUSH_POLL_MS` (default 60 s) as a safety net for hook setup or delivery failures. `WEBHOOK_ENABLED=0` uses polling alone; `EXTERNAL_PUSH_POLL_MS=0` disables polling. Webhook setup failures are logged but do not stop project creation or renaming. Forgejo will not call a private address unless it is allowlisted, so `FORGEJO_WEBHOOK_ALLOWED_HOSTS` (default `bot`) must name the host in `WEBHOOK_PUBLIC_URL`; change the two together.
  - **Publish** syncs the workspace to the pushed commit, rebuilds, validates, and publishes through the normal pipeline. If validation fails, the live site keeps the previous version, the workspace rolls back to the last published commit, and the thread sees the validation errors (the commit stays in the repo).
  - **Dismiss** adopts the commit into the workspace and git history only; the live site is unchanged and the next thread message builds on the pushed code.
- The bot's own pushes rebase on top of any external commits first, so an accepted external push never breaks the next Discord turn.
- `/site sync` is the manual counterpart: it pulls whatever is on `main` into the workspace (rebasing a rejected local commit on top), pushes, rebuilds, and republishes — the recovery path when a bot push was rejected with non-fast-forward, when the external push predates the poller's marker, or when the Publish button message is gone. It refuses while an agent turn is live and while the workspace still holds uncommitted edits from a failed turn.
- Keys require `secrets/forgejo-admin-token` (created by `./scripts/bootstrap-forgejo.sh` alongside the service token); the admin token is used solely to create/delete the restricted push accounts. Credentials are stored in the bot's private state and returned in ephemeral owner/admin replies. Changing collaboration settings does not revoke credentials previously shared outside the bot.
- Deleting the project (thread deletion) deletes the repo; the push account itself can be removed by rotating or deleting it in the Forgejo admin UI.

## Admin commands

`/site-admin status` shows the active model, agent-service health, web/asset status, multiplayer relay health, private-error recipient count, and log path.

`/site-admin model model:provider/model-id` changes the model for all future turns, including existing site threads. Use `default` to go back to the platform's default selection.

`/site-admin failover` shows the backup models used when a turn hits a provider quota block or a persistent upstream error. `/site-admin failover models:provider/a,provider/b` sets the list (quota-blocked or repeatedly failing turns retry the same prompt once on the first entry that is not the model just attempted); `default` follows `OPENCODE_FAILOVER_MODELS`, and `none` disables failover entirely.

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
  -> bot writes README (harness metadata + original request + README.agent.md section)
  -> commit/push authored source + the vendored net client (site/net/) to public Forgejo (no site/js or build manifest)
  -> atomically replace the published Apache directory with runtime files (no site/src or site/net)
  -> refresh the public all-sites index
```

The git commit is deliberately performed by the harness rather than by the model. Commits read like real history: the subject is the Discord request itself (truncated to one line), the **author** is the Discord user who sent it (display name, with a `@username@users.noreply.discord.com` noreply email), and the bot is the committer plus a `Co-authored-by:` trailer — `SiroroBot` by default, configurable with `COMMIT_BOT_NAME`/`COMMIT_BOT_EMAIL` (set the email to the Forgejo service account's address to link its avatar in Forgejo).
