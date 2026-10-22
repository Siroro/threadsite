---
name: game-2d
description: Structure ThreadSite 2D games with Excalibur, responsive controls, consistent map/collider data, bounded actor populations and multiplayer-safe simulation. Load before building or substantially revising a 2D game.
---

# ThreadSite 2D game architecture

Project boundaries, build rules and the **ThreadSite-relay-only** multiplayer contract live in root `AGENTS.md`. Load the `excalibur` skill for engine APIs. Excalibur 0.32.0 is the engine for action/arcade/sprite-heavy 2D games; DOM/SVG is fine when the experience is primarily cards, boards, forms or UI.

## Start from game structure, not renderer plumbing

Prefer Excalibur's Scenes, Actors, graphics/animations, camera strategies, input, resource loaders, actions, particles, TileMap, timers and collision system. Keep game-specific rules in small modules/systems rather than one giant Scene. The engine does not prescribe an art style or core loop: choose those from the request and genre.

A useful split for substantial games is:

- **Boot / preload**: assets, fonts, deterministic data tables.
- **Menu / lobby**: character/options/room UX.
- **Game Scene**: orchestration and presentation.
- **Simulation systems**: actors, combat, director/waves, pickups, progression.
- **World definition**: landmarks, map geometry and colliders from the same source data.
- **Network adapter**: imports only the harness `site/net/` relay client and maps relay messages onto simulation commands/snapshots.

## Physics and collision

Use **Active** bodies for moving actors, **Fixed** for solid world geometry, **Passive** for overlap-only triggers and **PreventCollision** for decoration. Choose collision groups to avoid irrelevant pairs. These collision types describe participation and resolution, not interchangeable physics engines; do not carry over another engine's physics APIs.

For Survivors/bullet-hell-scale populations, do not create mutually colliding physics bodies for every enemy/projectile. Keep compact actor data, move it with lightweight math, and use a spatial hash/uniform grid for nearby queries. Let Excalibur render those actors and handle the player/world boundary.

Map collision must match what the player sees. Define artwork placement and collider geometry from the **same world-space data**; never maintain unrelated magic rectangles. Include a development toggle that draws collider outlines over the rendered map. Resolve player movement with sliding rather than teleporting back or sticking on corners.

## Time and state

Use delta/fixed-step logic for local gameplay and clamp pathological foreground frame deltas. Excalibur update hooks receive milliseconds; convert to seconds for custom movement. Actor velocity is already pixels per second and integrated by the engine: do not integrate it again. Separate title/lobby/running/paused/downed/ended states explicitly and make reset clear all transient timers, pooled actors, input state and effects.

In multiplayer, Excalibur lifecycle hooks / requestAnimationFrame are **presentation and local prediction**, not an authoritative room clock. Browsers throttle hidden tabs. Shared run timing uses `net.serverNow()` and host migration/resync follows AGENTS.md. Never freeze an online room because `document.hidden` became true. Keep Actors, bodies and Scenes out of snapshots; restore presentation from plain simulation data.

## Controls and camera

Normalize keyboard, pointer/touch and gamepad into a small intent structure. Movement should be velocity/delta based, diagonals normalized, and touch targets large enough for phones. Add buffering/coyote time only where the genre benefits.

Keep world and HUD coordinates separate. Camera follow, shake and zoom should never change authoritative coordinates. Respect reduced-motion for nonessential shake/flash. Render at the displayed canvas size with automatic HiDPI support, using FillContainer/FillScreen instead of stretching a fixed logical resolution to fit. Resize/orientation changes must adapt camera framing and UI while keeping artwork and text sharp. For pixel art, use nearest-neighbor sampling, pixel snapping and integer zoom; never blur sprites with fractional scaling.

## Game feel without simulation ambiguity

Damage VFX, squash, particles, trails, floating numbers and audio may predict immediately. Authoritative state—shared HP, deaths, pickups, rewards and spawned world entities—must come from the selected multiplayer authority model. Presentation objects should be disposable/rebuildable from simulation state.

## Performance

Pool high-churn actors and effects. Avoid allocation-heavy per-frame maps/filters and repeated text layout. Cull/disable distant presentation work. Prefer one broad-phase query per system to every-object-vs-every-object checks. Measure before adding complexity.

## Finish criteria

A generated 2D game is not done because it renders. Show the actual playfield on load, with no engine play-button gate; unlock audio from a user gesture. Verify: play→end→retry flow; keyboard and touch; resize; map/collision alignment; pause/focus behavior; no unbounded entity growth; clear hit/damage feedback; and every multiplayer case required by AGENTS.md.
