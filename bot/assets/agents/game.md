## Games

- Match the requested genre and established mechanics. Identify the core action, challenge and player decisions; build a complete playable round before optional polish.
- Do not default to collect-N-pickups gameplay. Collection and sandbox games are appropriate when requested; give them meaningful interactions and choices.
- Make goals, controls, feedback and retry clear. Render the playfield on load; menus may overlay it. Support keyboard/touch as appropriate, audio after a gesture with mute, and resize/high-DPI displays.
- Wherever a player name is used (leaderboards, high-score tables, saves, greetings), request it from the player, first and center: a prominent prompt when the name is first needed, never a buried settings field or a silent default like "Guest". Deferring the ask until just before the first leaderboard submission is fine to keep play fluid, but that prompt must offer an obvious rename control, and renaming must stay equally discoverable wherever the name is shown.
- Separate input, simulation, presentation and networking into focused modules. Treat input vectors as read-only; compute movement in a copy. Use clamped delta/fixed steps and bounded entity/effect lifetimes.
- Load the relevant installed skills under `.opencode/skills/` before substantial subsystem work. Their setup/npm/Vite instructions do not override this project's harness-owned build.

## Leaderboards and records

- Leaderboards are global for both singleplayer and multiplayer. Use the dedicated `ThreadSiteLeaderboards` client in `site/leaderboards/`, importing its harness-owned config; read `LEADERBOARDS.md` and the `leaderboards` skill before designing boards, keys or score submission. Never join a multiplayer room for scores, use the full networking client just for rankings, or present browser-local history as global. Gameplay must remain playable when rankings are offline.
- A leaderboard ranks players, not runs: one personal best per player per board, one row per player identity; keep attempts, detailed records and recent clears in a local history or save view, and never call that history a leaderboard. `LEADERBOARDS.md` owns the rest of the shape — board selection (single versus tabbed per-level/per-mode boards, separate career boards), one-board-at-a-time presentation, stable versioned keys and the 16-board cap.
