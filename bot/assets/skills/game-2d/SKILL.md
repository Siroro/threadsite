---
name: game-2d
description: PixiJS playbook for this repository's 2D games — async Application init, ticker and fixed-step loops, containers and culling, textures, spritesheets and asset loading, the v8 Graphics API, text strategy, event modes for pointer input, filters, particle pooling, resolution/DPR handling, and performance patterns for the pinned pixi.js 8 engine package. Load before building or substantially revising 2D rendering, sprites, effects, or asset pipelines.
---

# PixiJS playbook (game-2d)

The rules that bound this project (edit scope, build step, multiplayer protocol,
validation) live in the project-root `AGENTS.md` — this skill is the engine
how-to layer beneath them. The engine is **PixiJS 8.20**, installed as a real
package in the harness-managed `node_modules/`: `import * as PIXI from "pixi.js"`
gives you the full v8 API with real TypeScript types, tree-shaken into your
bundle at build time. Never vendor a second copy. PixiJS is the default
renderer for action/arcade/sprite/particle-heavy games; card/board/puzzle/UI
games may suit plain Canvas or DOM better (AGENTS.md's 2D direction section) —
pick one renderer per game.

## Application bootstrap (v8 is async)

```ts
import { Application, Container } from "pixi.js";

const host = document.getElementById("game-root")!;
const app = new Application();                       // v8: no options in the constructor
await app.init({                                     // ...everything moved to an awaited init()
  resizeTo: host,
  background: 0x0b0e14,
  antialias: true,
  resolution: Math.min(window.devicePixelRatio, 2),  // work in CSS pixels; renderer handles DPR
  autoDensity: true,
});
host.appendChild(app.canvas);                        // v8: app.canvas (was app.view in v7)
// gameplay objects then hang off app.stage / your own containers under it
```

- `await app.init(...)` **before** touching `app.stage`, `app.renderer`, or the
  ticker — the classic v7 top-down constructor is the most common v8 migration
  bug the type-checker will not catch for you.
- Keep the async entry in `src/main.ts`; boot to a title/menu state after init,
  never a blank host. `resizeTo` keeps the canvas matched to its container; also
  handle orientation/aspect changes in your layout code.

## Ticker and step discipline

```ts
app.ticker.add((ticker) => {
  const dt = Math.min(ticker.deltaMS / 1000, 0.05);  // clamp: tab-back must not teleport everything
  simulate(dt);
  render(dt);
});
```

- One ticker callback that fans out to per-system functions — no parallel
  loops, no `requestAnimationFrame` alongside the ticker.
- `ticker.maxFPS` can cap a hot game (e.g. 60) on 144 Hz displays; pause with
  `app.ticker.stop()`/`start()` on `visibilitychange` and window blur.
- Physics-critical state: fixed-step accumulator inside the ticker, interpolate
  renders. UI animation can ride the raw delta.

## Scene graph, transforms, culling

- Structure with containers per concern — `world` (camera-transformed gameplay),
  `hud` (screen-space), `fx` (particles on top). Camera = transform the `world`
  container (`position`, `scale`, `pivot` for the rotation/zoom center).
- `container.sortableChildren = true` + child `zIndex` only where ordering
  actually changes; static order is free, sorting every frame is not.
- Mark large scrolled containers `cullable = true` (and `cullableChildren` on
  parents) so off-screen subtrees skip rendering. Do not cull the HUD.
- Transforms: `position.set(x, y)`, `pivot` is the local origin (rotation/scale
  anchor), `anchor` is a sprite-only texture point. Setting `anchor.set(0.5)`
  for centered sprites is the usual default.

## Textures, sprites, spritesheets

- Load once, up front, with the async asset loader, then build gameplay:

  ```ts
  import { Assets, Sprite, Texture } from "pixi.js";
  const sheet = await Assets.load("assets/atlas.json");   // TexturePacker/JSON-hash spritesheet
  const player = new Sprite(sheet.textures["player.png"]);
  const brand = new Sprite(Texture.from("assets/logo.png")); // single images
  ```

- Prefer one spritesheet atlas over many small PNGs: sprites sharing a base
  texture batch into single draw calls; interleaved textures break batches.
  Keep atlas frame metadata in one loader/sprites module, not magic coordinates
  scattered through gameplay code.
- `Assets.load` caches by URL — call it freely; do not build your own `Texture`
  objects from the same image repeatedly.
- Scale art for a target size (e.g. design at 2× and `scale.set(0.5)`) rather
  than shipping oversized bitmaps; the static-site size budget applies.

## Graphics (v8 API)

- v8 Graphics is chainable command recording:

  ```ts
  import { Graphics } from "pixi.js";
  const bar = new Graphics().roundRect(0, 0, 200, 18, 9).fill(0x22304a).stroke({ width: 2, color: 0x89a7ff });
  ```

  `rect`, `circle`, `ellipse`, `polygon`, `moveTo`/`lineTo`/`closePath` paths,
  then `.fill({ color, alpha })` / `.stroke({ width, color, alpha })`.
- Graphics is retained-mode: re-issuing commands rebuilds the geometry. For
  bars/rings that change every frame, redraw is fine at small scale; for
  anything hot, prefer a `Sprite` (scale a 9-slice or plain texture) instead.
- Use Graphics for debug overlays, simple procedural shapes, and UI chrome; use
  sprite art for the actual game feel.

## Text

- `new Text({ text: "Score", style: { fontFamily: "...", fontSize: 24, fill: 0xffffff } })`
  — v8 takes a single options object. Styles accept partials; share a
  `TextStyle` instance across equal-looking labels.
- Canvas-rastered `Text` re-rasterizes on every content/style change — never
  update one per frame. For scores/timers use `BitmapText` (bitmap font from a
  loaded XML/fnt or generated) or a digit-sprite approach; `HTMLText` is for
  rich styled copy, not hot HUD updates.

## Pointer input and hit areas

- A display object receives events only after `eventMode` is set:
  `"static"` (interactive, costs hit-testing) for buttons/units;
  `"dynamic"` for objects whose hit area moves every frame; leave everything
  else `"auto"`/`"passive"`.
  ```ts
  button.eventMode = "static";
  button.cursor = "pointer";
  button.on("pointerdown", onPress);
  ```
- `hitArea` overrides the bounds used for hit-testing (e.g. a `Graphics` shape
  on a container of textures). `pointerup`/`pointertap` for click-like
  semantics; `globalpointermove` for drags and hovers.
- Keyboard is not PixiJS's job: keep `src/input.ts` over `window` listeners
  (key sets for held state, `preventDefault` on arrows/space only while
  playing), and blur/pause when the window loses focus. Touch: comfortably
  sized on-screen controls that never cover the core play area.

## Filters and effects

- Filters (`sprite.filters = [new BlurFilter({ strength: 4 })]`,
  `AlphaFilter`, `ColorMatrixFilter`, `DisplacementFilter`, `NoiseFilter`) run
  framebuffer passes — apply to small containers, not the stage; drop or lower
  `resolution` on full-screen effects; make them a quality toggle on mobile.
- Game feel via transforms is cheaper than via filters: tint
  (`sprite.tint = 0xff4444`), alpha flashes, scale punch/squash-stretch,
  shake the world container, tween with your own eased lerp helpers.
- Particles: pool sprites (or v8 `Particle` objects for thousands of simple
  billboards), cap the pool, recycle dead ones. Never `new` particles in the
  update loop unbounded.

## Cleanup and restart

- Restart/replay should rebuild state, not the renderer: clear the `world`
  container (`removeChildren()`), return pooled objects, keep the `Application`
  running. Full teardown (`app.destroy(true, { children: true })`) is only for
  page unload — a destroyed app cannot be re-init'd.

## Multiplayer note

Remote-player rendering follows AGENTS.md's multiplayer section: key avatars by
`cid`, interpolate positions between the last two states (your clamped-delta
lerp helpers), and simulate only the local player. HUD/network status layers
live in the screen-space `hud` container.
