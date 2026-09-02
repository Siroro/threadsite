---
name: game-2d
description: ThreadSite 2D game architecture playbook for Phaser 4 games: choosing Phaser systems versus lightweight custom simulation, responsive controls, state flow, collision discipline, map/collider alignment, frame-rate independence, high-count actors, presentation/gameplay separation, and multiplayer-safe timing. Load before building or substantially revising a 2D game.
---

# ThreadSite 2D game architecture

Project boundaries, build rules and the **ThreadSite-relay-only** multiplayer contract live in root `AGENTS.md`. Load the `phaser-4` skill for exact Phaser APIs. Phaser 4.2.1 is the default engine for action/arcade/sprite-heavy 2D games; DOM/SVG is fine only when the experience is primarily cards, boards, forms or UI.

## Start from game structure, not renderer plumbing

Prefer Phaser's built-in systems before inventing equivalents: Scenes/lifecycle, Scale Manager, cameras, input, loader, animations, tweens, particles, groups/pools, tilemaps, timers and Arcade Physics. Keep game-specific rules in small modules/systems rather than one giant Scene.

A useful split for substantial games is:

- **Boot / preload**: assets, fonts, deterministic data tables.
- **Menu / lobby**: character/options/room UX.
- **Game Scene**: orchestration and presentation.
- **Simulation systems**: actors, combat, director/waves, pickups, progression.
- **World definition**: landmarks, map geometry and colliders from the same source data.
- **Network adapter**: imports only the harness `site/net/` relay client and maps relay messages onto simulation commands/snapshots.

## Physics and collision

Use **Arcade Physics** for player↔static-world collision, ordinary overlaps, triggers and modest body counts. Matter is only for mechanics that truly require rotating rigid bodies, constraints or complex physical interactions.

For Survivors/bullet-hell-scale populations, do not create mutually colliding physics bodies for every enemy/projectile. Keep compact actor data, move it with lightweight math, and use a spatial hash/uniform grid for nearby queries. Let Phaser render those actors and handle the player/world boundary.

Map collision must match what the player sees. Define artwork placement and collider geometry from the **same world-space data**; never maintain unrelated magic rectangles. Include a development toggle that draws collider outlines over the rendered map. Resolve player movement with sliding rather than teleporting back or sticking on corners.

## Time and state

Use delta/fixed-step logic for local gameplay and clamp pathological foreground frame deltas. Do not tie important rules to frame count. Separate title/lobby/running/paused/downed/ended states explicitly and make reset clear all transient timers, pooled actors, input state and effects.

In multiplayer, Phaser Scene `update()` / requestAnimationFrame is **presentation and local prediction**, not an authoritative room clock. Browsers throttle hidden tabs. Shared run timing uses `net.serverNow()` and host migration/resync follows AGENTS.md. Never freeze an online room because `document.hidden` became true.

## Controls and camera

Normalize keyboard, pointer/touch and gamepad into a small intent structure. Movement should be velocity/delta based, diagonals normalized, and touch targets large enough for phones. Add buffering/coyote time only where the genre benefits.

Keep world and HUD coordinates separate. Camera follow, shake and zoom should never change authoritative coordinates. Respect reduced-motion for nonessential shake/flash. Resize/orientation changes must preserve playable framing and UI.

## Game feel without simulation ambiguity

Damage VFX, squash, particles, trails, floating numbers and audio may predict immediately. Authoritative state—shared HP, deaths, pickups, rewards and spawned world entities—must come from the selected multiplayer authority model. Presentation objects should be disposable/rebuildable from simulation state.

## Performance

Pool high-churn actors and effects. Avoid allocation-heavy per-frame maps/filters and repeated text layout. Cull/disable distant presentation work. Prefer one broad-phase query per system to every-object-vs-every-object checks. Measure before adding complexity.

## Finish criteria

A generated 2D game is not done because it renders. Verify: title→play→end→retry flow; keyboard and touch; resize; map/collision alignment; pause/focus behavior; no unbounded entity growth; clear hit/damage feedback; and every multiplayer case required by AGENTS.md.
