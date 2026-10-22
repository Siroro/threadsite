---
name: excalibur
description: Build and revise ThreadSite 2D browser games using the installed Excalibur 0.32.0 APIs, including startup, Actors, graphics, collision, input, cameras and resource loading. Use alongside game-2d for Excalibur implementation.
---

# Excalibur 0.32.0

Read root `AGENTS.md` for workspace/build boundaries and the selected multiplayer contract. Import `excalibur` directly; the harness owns installation, bundling and the real declaration graph. Do not add npm/Vite/CDN setup. Use the installed `.d.ts` files to check unfamiliar signatures; official references are at https://excaliburjs.com/docs/ and https://excaliburjs.com/api/.

## Startup and lifecycle

```ts
import * as ex from "excalibur";

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const game = new ex.Engine({
  canvasElement: canvas,
  displayMode: ex.DisplayMode.FillContainer,
  backgroundColor: ex.Color.fromHex("#162344"),
  suppressPlayButton: true,
  suppressConsoleBootMessage: true,
});

class Player extends ex.Actor {
  constructor() {
    super({
      pos: ex.vec(160, 270), width: 32, height: 48,
      color: ex.Color.fromHex("#44ccaa"),
      collisionType: ex.CollisionType.Active,
    });
  }
  onPreUpdate(engine: ex.Engine, _elapsedMs: number): void {
    const keys = engine.input.keyboard;
    const x = Number(keys.isHeld(ex.Keys.Right)) - Number(keys.isHeld(ex.Keys.Left));
    const y = Number(keys.isHeld(ex.Keys.Down)) - Number(keys.isHeld(ex.Keys.Up));
    const direction = ex.vec(x, y);
    this.vel = direction.size > 0 ? direction.normalize().scale(220) : ex.vec(0, 0);
  }
}

game.add(new Player());
await game.start();
```

This shows API usage, not the finished game's art or mechanics. Create the canvas in the HTML shell and give its parent explicit CSS dimensions (for example, a game host occupying the viewport with no body margin, and `canvas { display: block; }`). `FillContainer` makes logical resolution follow that host; `FillScreen` is appropriate when the game owns the full window. Keep automatic device-pixel-ratio handling enabled: do not set `pixelRatio: 1` or `suppressHiDPIScaling: true` as a shortcut.

Do not default to `FitScreen`, `FitContainer`, a low fixed `resolution`, CSS stretching/transforms or fractional camera zoom. Those scale an existing framebuffer rather than drawing at the displayed size. Adapt camera bounds and HUD layout when the host resizes; keep world coordinates and movement speeds independent of screen size. A fixed competitive playfield can use extra world framing or unscaled letterboxing instead of scaling the scene to arbitrary fractional sizes.

For authored pixel art, set `antialiasing: false` and `snapToPixel: true`, keep image filtering at `ImageFiltering.Pixel`, and use whole-number sprite scales and camera zoom. Align rendered sprites/camera to the pixel grid without rounding authoritative simulation state. Excalibur's `pixelArt: true` is a **blended antialiased sampler preset**, not a strict nearest-neighbor switch; do not use it for strict pixel-perfect art. Smooth high-resolution illustration/vector art may keep antialiasing. Keep text/HUD in DOM at normal CSS size or rendered at the actual backing resolution.

Use `Scene.onInitialize(engine)` for one-time setup, activation/deactivation for transitions, and Actor/Scene `onPreUpdate` or `onPostUpdate` for lifecycle hooks. Do not override the engine's internal `update` method to implement gameplay. Actors' positions/velocities use vectors; graphics anchors default to the center. Hook elapsed time is **milliseconds**, while `vel` uses **pixels per second**. Do not move an Actor manually and also let its velocity integrate the same movement.

## Media and presentation

Load local `ImageSource` and `Sound` resources with a `Loader` before using their graphics or audio. Convert a loaded image with `toSprite()`, assign it via `actor.graphics.use(...)`, and use SpriteSheet/Animation for authored frame animations. Paths are relative to the served HTML, normally `assets/...`, not `src/` or `node_modules/`. Keep resource keys/paths and source/license notes consistent.

Keep `suppressPlayButton: true` when loading resources too: the world must render without an engine click gate. Unlock/resume audio on the first pointer/key gesture, handle rejected playback, and allow silent play. Start-game UI may overlay the visible world; it must not replace it with a blank menu.

Use Actor actions for presentation sequences and camera strategies such as `game.currentScene.camera.strategy.lockToActor(player)` for following. Bound camera shake and particle lifetimes. Keep HUD in DOM or ScreenElements so camera motion does not move controls. Reset transient actions, listeners, timers and effects when restarting a run; remove listeners on scene deactivation when they would otherwise accumulate.

## Collision and input

- `CollisionType.Active`: a moving body that participates in solid resolution.
- `CollisionType.Fixed`: solid world geometry that is not pushed by other bodies.
- `CollisionType.Passive`: overlap notifications without solid resolution, suitable for triggers.
- `CollisionType.PreventCollision`: no collision participation or notifications, suitable for decoration and manually queried high-count actors.

Define collider bounds and rendered map geometry from one data source. Inspect actor anchors, scale and world coordinates when alignment is wrong, and provide a development collider overlay. Do not simulate complex constraints by guessing at unsupported APIs. For large swarms/projectiles, use compact simulation data and spatial queries rather than all-pairs engine collision.

Normalize keyboard (`isHeld` for continuous actions, `wasPressed` for edges), pointer world positions, touch and gamepad into game intents. Keep diagonal speed consistent, handle released input/focus changes, and keep touch controls off the action. Excalibur's default input handling can capture browser keys: choose input scope and keyboard behavior deliberately when using forms beside an embedded canvas.

## Multiplayer

Excalibur's frame loop is not the shared room clock. Follow `AGENTS.md` and `site/net/threadsite-net.js` for authority, server time, reconnect and host migration. Serialize plain game data; never send Actors, Scenes, bodies or graphics. Apply restored snapshots to disposable presentation objects, and keep offline solo play working.
