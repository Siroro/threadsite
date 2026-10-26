## 2D

Use installed **Excalibur 0.32.0**: `import * as ex from "excalibur"`. Read the `game-2d` and `excalibur` skills for engine APIs and examples. DOM/SVG is suitable for card/board/UI-heavy games.

- Use Excalibur lifecycle, rendering and collision primitives. Derive map art and colliders from the same data; include a collider debug toggle.
- Large swarms/projectiles use lightweight movement and spatial queries rather than mutually colliding bodies.
- Update-hook elapsed time is milliseconds; actor velocity is pixels/second. Do not integrate movement twice.
- Use `suppressPlayButton: true`, `FillContainer` (explicitly sized) or `FillScreen`, and automatic HiDPI. Resize the layout rather than CSS-stretching a low-resolution canvas.
- For pixel art, use nearest-neighbor filtering, `antialiasing: false`, `snapToPixel: true` and integer zoom; avoid the blended `pixelArt: true` preset.
- Hold one facing convention: sprites are drawn facing right unless the design says otherwise, mirrored in code (negative x scale) for leftward motion — never separate mirrored art. Verify in the running game — with your browser tools or a `browser-qa` delegation — that every entity visually faces the way it moves, shoots or steers.
- Beyond ~8 small sprites, pack families into one atlas (a single sheet plus a `frames.json` mapping names to x/y/w/h rectangles) instead of one image per frame; ask `asset-forge` for the packed pair. `site/assets/STYLE.md` records the project's palette, sprite sizes and atlas policy — keep it current when conventions change.
