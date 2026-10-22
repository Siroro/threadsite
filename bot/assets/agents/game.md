## Games

- Match the requested genre and established mechanics. Identify the core action, challenge and player decisions; build a complete playable round before optional polish.
- Do not default to collect-N-pickups gameplay. Collection and sandbox games are appropriate when requested; give them meaningful interactions and choices.
- Make goals, controls, feedback and retry clear. Render the playfield on load; menus may overlay it. Support keyboard/touch as appropriate, audio after a gesture with mute, and resize/high-DPI displays.
- Separate input, simulation, presentation and networking into focused modules. Treat input vectors as read-only; compute movement in a copy. Use clamped delta/fixed steps and bounded entity/effect lifetimes.
- Load the relevant installed skills under `.opencode/skills/` before substantial subsystem work. Their setup/npm/Vite instructions do not override this project's harness-owned build.
