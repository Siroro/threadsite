---
name: leaderboards
description: "Design and implement leaderboards, high-score tables and record systems for ThreadSite games — choosing one board versus per-mode or per-level boards, keeping one row per player, career aggregates, board keys and versioning, submission, and ranking UI. Use when the user mentions leaderboard, high score, ranking, records, score submission or career scoring."
---

# Leaderboards and records

A leaderboard is a **competition**, not a log of runs. One board answers one question — "who is best at this?" — and ranks each player by their personal best. The relay already stores one best score per persistent player per board, so a single board naturally gives you one row per player. The failure mode to avoid is building a table that mixes boards or runs, so the same player appears several times.

Both singleplayer and multiplayer use **global** boards through the small dedicated client under `site/leaderboards/`; read the harness-seeded `LEADERBOARDS.md` for the API and failure handling. The score client does not join rooms or synchronize gameplay. Import `ThreadSiteLeaderboards` and `LEADERBOARDS_CONFIG`, create `boards = new ThreadSiteLeaderboards(LEADERBOARDS_CONFIG)`, and call `boards.setName(chosenPlayerName)` after asking the player. Use it even when a multiplayer `net` connection already exists. Local saves and run history are separate from global rankings. Keep gameplay playable offline and show ranking failures clearly.

## Choose the shape first

| Game shape | Board shape |
| --- | --- |
| Arcade, endless, roguelike, speedrun, one continuous challenge | **One board** for the game: best run or fastest clear. |
| Career/campaign with levels, operations or chapters | **One career board** for the aggregate, plus optional **per-level boards** shown as tabs/selector options; detailed records may also live in a save. |
| Modes or difficulties with different rules | **One board per mode**, shown as tabs when the game exposes more than one; default to the main mode. |
| Daily/weekly challenge | **One rotating board** per period (`daily-2026-10-23`); retire old ones. |
| Level-select where each level is the whole game | **One board per level**, selected by tabs; add an overall board if levels share a career. |

Default to the smallest set that matches the game: usually one main board, plus per-level boards when levels are distinct competitions. Add a board when a player would reasonably compare themselves against a different field or a different scoring scale. Never create a board per attempt, run or save slot. Keep the set within the relay's 16-board cap.

The UI label must match the shape: a "career leaderboard" needs a single career board key. It must not be built by concatenating per-operation boards — that is what makes one player appear twice. Per-level boards are supported and often right; they belong behind their own tabs, not merged into the career list.

## Career aggregate and detailed records

Keep one aggregate score for the public career board, and keep detailed records in `net.saves`:

```ts
type Progress = {
  schemaVersion: 1;
  levels: Record<string, { bestScore: number; bestTimeMs: number }>;
  careerBest: number;
};

const progress = validateProgress(loadLocalProgress()); // fall back to a fresh schema
const previousCareer = progress.careerBest;

updateLevelBest(progress, levelId, score, timeMs);
const career = careerScore(progress); // one stable formula, e.g. sum of level bests
progress.careerBest = Math.max(previousCareer, career);

saveLocalProgress(progress);
if (career > previousCareer) await boards.submit("career-v1", career);
```

The save is also the place for detailed per-level bests, times, medals and recent runs; the career board only needs the number that represents the whole competition. Multiplayer games may additionally use `net.saves` for checkpoint persistence, observing its revision-conflict rules. Catch score failures and keep the run playable. After an uncertain submission refresh the board before deciding to retry; do not automatically replay requests.

## Per-level boards and tabs

Per-level competition is a good pattern: give every level its own board key (`level-01-v1`) and expose a level selector/tab bar. Render only the selected board, so each visible ranking has one row per player. The same player can appear on several boards, but never several times inside one table.

- Put a **Career/Overall** tab first when one exists, then the levels or operations in play order.
- Each tab names its scope and order ("Operation 2 · fastest clear") and shows its own top 10.
- Default to the current level, or the last selected level; persist the choice so returning players land where they left off.
- Fetch/list only the selected board. Do not request every level and concatenate the results.
- Use the injected game identity for every level and mode, with a separate board key per competition. A new game ID makes the same browser a different player.
- If the campaign has more levels than the 16-board cap, keep the career board and expose boards only for featured/standalone levels; do not create multiple game identities to bypass the cap.
- The career tab is backed by its own aggregate board key, not by merging the level rows in the UI.

## Board keys and score

- A key names the competition and its rules, not the player's progress: `career-v1`, `best-run-v1`, `fastest-clear-v1`, `daily-2026-10-23`.
- Bump the version when the formula or rules change. Never mix old and new scoring on one board.
- First submission fixes descending versus ascending order. Choose deliberately (higher score or lower time) and keep it stable.
- Bake everything that matters into one number. If accuracy, speed and streak all count, define one score that reflects them rather than creating a board per metric.
- A board holds one personal best per player. Submitting an equal or worse score leaves the row untouched, including its name; an improved score can update the name.
- Scores are client-reported and not verified. Do not claim cheat-proof rankings.
- Keep the set within the 16-board cap; per-level boards count too. Hide empty boards and default to the main one.

## Render one row per player

- Use `board.entries` as returned: one row per `playerId`. Do not group, merge or append multiple boards by name; names are not unique and different players can share one. If two rows in one visible board share a `playerId`, you have merged boards or history — fix the data shape, not the labels.
- Label the scope and ordering ("Career · highest score", "Operation 3 · fastest time"). A generic "Leaderboard" title hides which competition is being shown.
- Show the top 10 by default and highlight the current player when they appear. Show their personal best from the save/local record even when they are outside the visible slice.
- Provide loading, offline, empty and submit-failed states. Never show placeholder or fake scores. Keep the game playable when the relay is unavailable.
- Keep the player's own best and a separate "Recent runs" history outside the ranking table. A history may have multiple rows per player; a leaderboard may not.
- Render names with `textContent`, not HTML.

## Anti-patterns

- **Run list or merged boards labelled as a leaderboard.** A "career leaderboard" showing OP 01 and OP 02 for the same player is either a run history or several boards concatenated; neither is a career ranking.
- **Per-level rows in one table.** Per-level boards are fine; merging them into one list is not. Use a tab/selector so each visible board ranks one level.
- **Concatenating boards.** Combining per-level boards to make an "overall" table duplicates players and compares unrelated scores. Submit an aggregate to its own board instead.
- **Concatenating entries by name.** Names are not identities. Deduplicate by `playerId` or, better, use one board.
- **A new board key per run/day.** It creates unbounded empty boards and loses the player's history; only rotating challenges need period keys, and old ones should be retired.
- **Submitting every frame.** Submit at the end of a run or when a personal best improves.
- **Promising an instant rename.** The stored name changes with an improved score; a rename alone does not rewrite the old row.

## Checklist

- [ ] One board per real competition, with one career/main board as the default.
- [ ] One row per player (`playerId`) on every board.
- [ ] Per-level boards use their own tabs/selector; run history stays in saves/history.
- [ ] Multiple boards shown one at a time, with scope/order in the title.
- [ ] Board key versioned; scoring order fixed; score formula stable.
- [ ] Current player highlighted; own best visible; empty/offline/error states handled.
- [ ] Submissions at run end, failures non-fatal, offline play preserved.
