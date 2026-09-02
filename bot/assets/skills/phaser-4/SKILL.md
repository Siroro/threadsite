---
name: phaser-4
description: ThreadSite Phaser 4.2.1 playbook for generated 2D browser games: game config and Scenes, Arcade Physics, collision and map alignment, cameras, input, loaders, groups/pooling, tweens, particles, timing, responsive scaling, high-count swarm performance, multiplayer-safe simulation boundaries, and Phaser 4 migration gotchas.
---

# Phaser 4.2.1 playbook

Project boundaries and ThreadSite relay rules live in root `AGENTS.md`; this is the engine how-to. Phaser is already installed and bundled by the harness.

## Bootstrap and scenes

```ts
import * as Phaser from "phaser";

class GameScene extends Phaser.Scene {
  constructor() { super("game"); }
  preload() { this.load.image("player", "assets/player.png"); }
  create() { /* construct world once */ }
  update(_time: number, deltaMs: number) {
    const dt = Math.min(deltaMs, 50) / 1000;
    this.simulateLocalPresentation(dt);
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game-root",
  width: 1280,
  height: 720,
  backgroundColor: "#10131a",
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  physics: { default: "arcade", arcade: { gravity: { x: 0, y: 0 }, debug: false } },
  scene: [GameScene],
});
```

Use a small scene stack (Boot/Title/Game/UI when useful), not one giant scene and not dozens of micro-scenes. Scene pause/sleep is a presentation/game-state tool, not a network clock.

## Collision

- Arcade Physics is the default for top-down/player/world collision, triggers, pickups and ordinary projectiles. Prefer static bodies/tilemap collision for walls.
- Make visible geometry and collision originate from one map definition. Tilemaps: collision properties on the same tiles. Freeform maps: each obstacle record owns both sprite placement and collider geometry.
- Use circular player/enemy bodies when sprites read as round; set body size/offset intentionally instead of accepting texture bounds.
- Keep a debug toggle (`physics.world.drawDebug` / debug graphics or an authored overlay) and verify every wall/corner against the art.
- Survivors/bullet-hell scale: do not resolve enemy↔enemy physics across hundreds of actors. Use custom positions plus a uniform grid/spatial hash for weapon queries; only sync/render what matters.

## Input, camera, scale

Use Phaser keyboard/pointer/gamepad/touch systems and normalize intent into an input layer. Never make movement depend on key repeat. Camera follow should have intentional lerp/deadzone and bounded shake. Use Scale Manager plus responsive DOM HUD where appropriate; test portrait/narrow phone sizes.

## Time and multiplayer

Phaser's `update` delta is for local simulation/presentation. Browser background tabs can throttle or stop RAF. **Never base an authoritative multiplayer room clock on Scene update count or `document.hidden`.** Use ThreadSiteNet `serverNow()` for shared timing and the relay's host-migration/snapshot contract from AGENTS.md.

Remote transforms: buffer timestamped samples and render behind relay time; use `net.serverNow()` when comparing `ps.ts`. Keep local movement responsive and separate from authoritative shared-world damage/pickups.

## High-count performance

Pool bullets, particles and transient sprites; recycle rather than churn allocations. Use Groups where convenient but don't confuse Group membership with physics. For huge decorative sprite counts consider Phaser 4 SpriteGPULayer; for gameplay actors keep CPU data compact and render only visible/nearby objects. Avoid per-frame texture creation, text re-layout and global post-FX.

## Phaser 4 gotchas

- Author against Phaser **4.2.1**, not remembered Phaser 3 APIs. Phaser 4 replaced pipelines/FX with RenderNodes/Filters and changed several rendering details.
- Prefer APIs surfaced by the installed TypeScript declarations; if memory and types disagree, the types win.
- Do not add Phaser plugins, npm packages, CDNs or external networking libraries unless the user explicitly requests a supported harness change. Multiplayer always uses `site/net/threadsite-net.js`.
