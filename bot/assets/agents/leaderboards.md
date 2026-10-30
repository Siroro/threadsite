# Global leaderboards

Use this dedicated score client in **both singleplayer and multiplayer** games. Rankings are shared by every player of this game, across rooms, tabs and gameplay modes. Gameplay networking is separate: singleplayer games must never join a room just to submit a score. The client has no gameplay loop, peers, world sync or reconnect loop.

```ts
import { ThreadSiteLeaderboards } from "../leaderboards/threadsite-leaderboards.js";
import { LEADERBOARDS_CONFIG } from "../leaderboards/leaderboards-config.js";

const boards = new ThreadSiteLeaderboards(LEADERBOARDS_CONFIG);
// Ask prominently for the player's name before their first submission.
boards.setName(chosenPlayerName);
try {
  const best = await boards.submit("points-v1", score); // descending personal best
  const top = await boards.list("points-v1", { limit: 10 });
  // Render entry.name as text, never as HTML.
} catch (error) {
  // Keep playing locally. Show that global rankings are unavailable.
}
// For fastest clears: submit("time-ms-v1", milliseconds, { order: "asc" }).
```

- Read the `leaderboards` skill before designing boards. One personal-best row per persistent player per board; never merge boards or label run history as a leaderboard. Pick one main board or separate tabs for distinct competitions. Keep the 16-board cap and stable versioned board keys.
- Prompt for a player name prominently, persist the choice locally, and expose an obvious rename control. Call `setName()` when it changes. Names are sanitized and capped at 32 characters and not unique; never dedupe or merge by name. A name alone does not identify a player. The saved entry name changes on the next improved score, not an equal or worse submission.
- The client shares the existing anonymous browser identity with the multiplayer client. `playerId` is public and available after a successful request. The private credential stays internal: never put it in world state, URLs, logs or UI. If `identityPersistent` is false, browser storage is unavailable and identity lasts only for this page. Clearing storage loses the old identity; accounts and cross-device recovery are not provided.
- Scores are client-reported, not cheat-proof. The server retains personal bests, fixes the board's sort order on first submission, and ranks ties by the original timestamp then player ID. `list` returns up to 100 entries. Different games are isolated; rooms and singleplayer/multiplayer gameplay do not split a board.
- Calls time out after 10 seconds and are never replayed automatically. `submission_uncertain` means a submitted score may have committed: refresh the board before deciding to retry. Handle failures and keep the entire game playable offline. Local records remain local records; never present them as global rankings while offline. Do not block loading or starting gameplay on a leaderboard request.
- Import `LEADERBOARDS_CONFIG` unchanged; its game ID survives renames and architecture switches. All files under `site/leaderboards/` and this guide are harness-owned. Keep authored UI and score logic under `site/src/`.
- Use this client for rankings even in multiplayer. `net.saves` provides multiplayer checkpoints.
