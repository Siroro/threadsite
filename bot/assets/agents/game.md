## Games

- A **playable game**, not an animated scene: objective and controls obvious before or right after play starts; explicit title/play/pause/game-over/replay states; immediate audiovisual feedback for danger, damage, scoring, pickups, combos.
- Frame-rate independent simulation (clamped delta or fixed step). When hidden, reduce rendering/audio work only; **never freeze authoritative multiplayer world time because `document.hidden` or RAF stopped** — follow the multiplayer authority/handoff rules; keyboard controls where sensible plus touch for phones; audio only after a user gesture, with a visible mute; localStorage only for non-sensitive settings/scores/progress; usable resized and on high-DPI.
- Split by system without overengineering: `src/main.ts` (lifecycle → `js/main.js`), `game-state.ts` (state machine/loop), `input.ts`, `audio.ts`, and focused modules (`entities.ts`, `levels.ts`, `ui.ts`, …), styling in `css/game.css`, media in `assets/`.
- On revisions preserve established controls, mechanics, save data, and levels unless the request changes them.
