## Games

- Match the requested genre and established mechanics. Identify the core action, challenge and player decisions; build a complete playable round before optional polish.
- Do not default to collect-N-pickups gameplay. Collection and sandbox games are appropriate when requested; give them meaningful interactions and choices.
- Make goals, controls, feedback and retry clear. Render the playfield on load; menus may overlay it. Support keyboard/touch as appropriate, audio after a gesture with mute, and resize/high-DPI displays.
- Wherever a player name is used — leaderboards, high-score tables, saves, greetings — request it from the player, first and center: a prominent prompt when the name is first needed, never a buried settings field or a silent default like "Guest". Deferring the ask until just before the first leaderboard submission is fine to keep play fluid, but that prompt must offer an obvious rename control, and renaming must stay equally discoverable wherever the name is shown.
- Separate input, simulation, presentation and networking into focused modules. Treat input vectors as read-only; compute movement in a copy. Use clamped delta/fixed steps and bounded entity/effect lifetimes.
- Load the relevant installed skills under `.opencode/skills/` before substantial subsystem work. Their setup/npm/Vite instructions do not override this project's harness-owned build.

## Leaderboards and records

- Leaderboards are global for both singleplayer and multiplayer. Use the dedicated `ThreadSiteLeaderboards` client in `site/leaderboards/`, importing its harness-owned config; read `LEADERBOARDS.md`. Never join a multiplayer room for scores, use the full networking client just for rankings, or present browser-local history as global. Gameplay must remain playable when rankings are offline.
- A leaderboard ranks players, not runs. Render one row per player identity from one personal best per board; keep attempts, detailed records and recent clears in a local history or save view, and never call that history a leaderboard.
- Pick one board or a tabbed set based on the competition: one board when runs are directly comparable, per-level/per-mode boards when each is a separate contest. A career aggregate belongs on its own career board and a separate tab, never merged with level boards or run history.
- Present multiple boards one at a time with a clear title and selector; never concatenate boards into one table (that repeats players and compares incomparable scores). Keep the set within the 16-board cap, hide empty boards, and include an overall/career tab when one exists.
- Read the `leaderboards` skill before designing rankings or score submission.
