# Deleting a project by deleting its Discord thread

Deleting a registered Discord thread automatically deletes the entire linked project. Deleting its parent channel also triggers cleanup for its registered threads. Archiving or locking a thread keeps the project.

Cleanup removes the Forgejo repository (including either name of an interrupted rename), repository push accounts, workspace and scratch views, published site and redirects, atomic-publish leftovers, OpenCode sessions and their child histories, project usage entries, multiplayer rooms and saved relay world, and SQLite registration. The gallery is refreshed. Cached browser previews stop serving bundles once the workspace disappears.

The bot first saves `pendingDeletion` in SQLite, blocks new work and restart recovery, cancels queued jobs and stops agent sessions. It waits for a build or publish already in progress to finish before removing local files, so a late publish cannot recreate the site. Shared resources, unexpected workspace paths and symlinks are refused. If an operation fails, the registration remains only as a cleanup receipt with the failure reason, and the next sweep retries it. The bot records completed agent cleanup before removing files so retries do not need to reopen an already deleted workspace.

A startup sweep runs before interrupted builds resume. Periodic sweeps default to every 60 seconds (`PROJECT_CLEANUP_INTERVAL_MS`) and also detect threads deleted while the bot was offline. Only Discord's explicit `10003` Unknown Channel response triggers deletion; permissions errors, rate limits, unavailable guilds and network failures do not. Restoring service access lets pending cleanup finish automatically.

The relay's authenticated deletion endpoint disconnects players and removes the world snapshot. A tombstone row in `relay.sqlite` prevents old open tabs from recreating the game, including after a relay restart; old names of a renamed game resolve to the tombstoned current id. The bot and relay share an automatically generated cleanup credential through the private `cleanup-control` volume; it is not mounted into OpenCode or published sites. Existing server backups and general diagnostic logs are not rewritten by project cleanup.

`start.sh remove` performs the same additional session, account, usage and relay cleanup after its existing preview and idle checks; add `--backup` to keep a SQLite snapshot. `start.sh forget` still removes registration only. `start.sh purge` is the sweep for leftovers whose thread or registration is already gone.

Deploy the bot, relay, and preview changes together:

```bash
cd ~/threadsite
git pull --ff-only
docker compose up -d --build gameserver preview opencode bot
```

The first startup sweep also removes projects whose threads were already deleted. No separate confirmation is requested after a Discord deletion.
