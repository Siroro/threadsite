# Rapier and Box3D for ThreadSite

This compares the repository's `@dimforge/rapier3d-compat` **0.21.0** with **`box3d.js` 0.1.1**, using its single-threaded inline-WASM browser build. Box3D's native C engine and its third-party JavaScript bindings are separate projects. Feature availability below was checked against the installed JavaScript declarations as well as upstream documentation on 28 October 2026.

The [local benchmark and interactive demo](../scripts/physics-benchmark/README.md) use isolated dependencies. The bot, workspace engine seeder and generated-game instructions still use Rapier.

## Features

| Game requirement | Rapier 0.21.0 | Box3D through box3d.js 0.1.1 | What this comparison verifies |
| --- | --- | --- | --- |
| Crates, balls, capsule actors | Native cuboid, ball and capsule colliders | Box hull, sphere and capsule shapes | All three in shared scenes |
| Cylinders / cones | Dedicated cylinder, cone and rounded variants | No dedicated cylinder/cone shape in the checked binding; use a convex hull approximation | Declaration comparison only; no shape-quality benchmark |
| Convex models / compound objects | Convex hulls and multiple colliders per body | Convex hulls, multiple shapes, baked static compounds | API availability; no hull/compound benchmark |
| Static mesh levels / terrain | Triangle meshes and heightfields | Triangle meshes and heightfields | Identical triangle-mesh ramp; heightfields untested |
| Moving platforms | Position- or velocity-driven kinematic bodies | Kinematic bodies and target-transform API | Four velocity-driven platforms; passenger carrying untested |
| Player movement | Built-in character controller: slide, slope limits, autostep, ground snap, platform interaction | `b3World_CastMover`, `b3World_CollideMover`, `b3SolvePlanes` and clipping primitives | APIs differ substantially; demo actors use shared dynamic-body steering, not either controller |
| Fast projectiles | Explicit per-body CCD and world CCD settings | Continuous collision plus bullet body flag | 64 spheres at 180 m/s against an 8 cm wall |
| Triggers / collision events | Sensor colliders and event queue | Sensor shapes and reusable event buffers; sensor visitors must also opt in | Sensor entry/exit, polling in arena; contact-force events untested |
| Hitscan, ground checks, overlap queries | Raycasts, shape casts and overlap queries | Raycasts, shape casts and overlap queries | 128 downward rays per tick; shape casts untested |
| Stacks / sleeping scenery | Solver and island sleeping | Soft Step solver and island sleeping | 144-crate towers with sleep off; 240 settled crates with sleep on |
| Doors, ropes, ragdolls | Revolute, prismatic, fixed, spherical, spring/rope and generic joints | Revolute, prismatic, weld, spherical, distance, motor, wheel and other joints | Checked declarations; no joint/ragdoll performance claim |
| Cars | Built-in raycast vehicle controller | Wheel joints; no corresponding complete vehicle controller in the checked bindings | Vehicle handling untested |
| Save / replay | World snapshots and restoration | Recording and replay/player bindings | APIs exist; no save-format or replay migration verified |
| Deterministic simulation | Documented cross-platform deterministic browser WASM with identical setup/inputs | Upstream advertises cross-platform determinism | No cross-browser determinism test; identical engine outcomes are not expected |
| Debug drawing | Debug renderer | World-draw callback | Availability only; viewer renders shared shape geometry |
| Browser packaging | Inline WASM, ESM and real TypeScript types | Inline WASM, ESM and real TypeScript types | Both bundle with current esbuild settings and initialize locally |
| Browser threads | Current seeded compat build is single threaded | Optional separate MT build requires SharedArrayBuffer and cross-origin isolation | Both use single-threaded builds here; no threaded benchmark |
| Resource ownership | Free world, controllers and separately owned queues | Destroy world/buffers; mesh, compound and heightfield backing data must outlive their shapes | Repeated world destruction/recreation and mesh cleanup; no long-duration leak measurement |
| Integration / maturity | Official bindings; already seeded and documented here | Third-party bindings; upstream's published initial engine release is labelled alpha | Needs new seeder specification, instructions and compatibility policy |
| License | Apache-2.0 | MIT engine and bindings | Preserve notices in generated bundles |

Collider coverage is described in the [Rapier collider guide](https://rapier.rs/docs/user_guides/javascript/colliders/) and [Box3D collision manual](https://box2d.org/documentation3d/md_collision.html). Controller differences follow the [Rapier controller guide](https://rapier.rs/docs/user_guides/javascript/character_controller/) and the [box3d.js bindings and examples](https://github.com/isaac-mason/box3d.js). Box3D ownership and threading rules are documented by the bindings. The [Box3D release notes](https://github.com/erincatto/box3d/releases/tag/v0.1.0) describe the engine's alpha status. Its release manual can differ from newer native source or the engine revision compiled into a JavaScript package.

## Local measurements

The reproducible runner writes detailed measurements to `scripts/physics-benchmark/dist/report.md` and raw data to `dist/results.json`. The interactive viewer displays the saved results, supports engine and scene switching, and can perform a quick single-repetition comparison. The measured snapshot below is retained separately from these overwriteable local outputs.

Measured on **28 October 2026**, AMD Ryzen 9 5900X, Windows x64, headless Edge **156.0.4314.50**, Node **24.22.1**. Both engines are single threaded. Six repetitions alternate engine order and rotate scene order. Each scene warms for 120 fixed ticks (600 for sleeping props), followed by 600 measured ticks. A local cross-origin-isolated page gives an observed 0.005 ms timer increment. No rendering occurs during timing.

Times below are **milliseconds per tick**, using the median across the six runs' p50 ten-tick batch averages. The tick includes steering, physics, event polling, queries, pose reads and diagnostics. These are not individual rendered-frame latencies.

| Workload | Rapier | Box3D | Observation |
| --- | ---: | ---: | --- |
| Arena: 24 capsules, 48 props, 4 platforms, 4 sensors, mesh ramp | 0.266 | 0.164 | Box3D about 38% less tick time |
| 144 crates in twelve 12-high towers; sleep disabled | 0.399 | 0.228 | Box3D about 43% less tick time |
| 64 projectiles at 180 m/s, CCD against thin wall | 0.107 | 0.104 | Similar; run ranges overlap |
| 192 mixed props, mesh ramp, 128 rays per tick | 0.664 | 0.488 | Box3D faster overall |
| 240 sleeping crates, with all transforms still read | 0.069 | 0.074 | Similar; run ranges overlap |
| Raycasts only within the mixed query workload, 128 casts | 0.133 | 0.200 | Rapier faster for the casts themselves |

The query workload's physics-step medians were 0.488 ms for Rapier and 0.222 ms for Box3D. Box3D's faster stepping offsets slower casts; a predominantly query-driven game could prefer Rapier. In the sleeping workload, Box3D's step was much cheaper (0.003 vs 0.041 ms), but its additional pose/binding work removed that advantage in the full tick. A game using movement-event-driven mesh updates instead of reading every sleeping body would have a different cost profile.

All runs passed finite-transform, ground and CCD checks. All 240 settled props slept. All 128 downward casts hit on every query tick. Both engines passed a falling-sphere test, sensor entry and exit, and removing a body from queries. Scene switching, world destruction/recreation, pause/resume, restart, quick comparisons and rendering through both engines were exercised in the browser without page errors.

The stack result was not a faster collapsed simulation: after 12 simulated seconds, the lowest top-crate center was **11.46275 m** for Rapier and **11.46273 m** for Box3D. Maximum horizontal drift from initial positions was **2.13 mm** and **3.32 mm**, respectively. This controlled stack is only one quality check.

Bundle sizes use decimal MB/KB below. Each physics bundle includes the adapter and embedded WASM. The same Three.js viewer is built separately. Compression is gzip level 9 or Brotli quality 11; hosting may use different settings.

| Browser output | Minified raw | Gzip | Brotli |
| --- | ---: | ---: | ---: |
| Rapier physics | 4.336 MB | 1,644 KB | 1,197 KB |
| Box3D physics | 1.339 MB | 367 KB | 284 KB |
| Shared viewer / scene logic | 550 KB | 140 KB | 115 KB |
| Rapier + viewer | 4.887 MB | 1,784 KB | 1,312 KB |
| Box3D + viewer | 1.890 MB | 507 KB | 400 KB |

Box3D's physics bundle is **69.1% smaller raw and 77.7% smaller gzip**. This measures the installed browser builds rather than npm tarballs or native binaries. Rapier's current measured output is larger than the older approximate size comment in `bot/src/config.ts`.

The checked-in [measurement snapshot](benchmarks/physics-2026-10-28.json) retains the environment, bundle byte counts, initialization timings, every run's statistics and health counters. Full per-batch samples remain in the local `dist/results.json`; re-running the benchmark regenerates them. Initialization includes local fetch/import/WASM compilation with warm caches and is not presented as a cold-start or transfer-speed comparison.

## Interpreting the result

These workloads test likely ThreadSite building blocks rather than thousands of objects in a native engine benchmark. They include engine-to-JavaScript binding overhead and the reads/queries game code performs. Rendering and networking are excluded. A faster physics step does not imply faster raycasts, better character movement or higher overall game FPS.

The two solvers are configured with practical settings: Rapier's four solver iterations and Box3D's four substeps. Those are different algorithms and different amounts of work. Matching the count does not establish equal accuracy; the runner records stack heights/drift and checks gross collision failures. It is not a general solver-quality test. The single desktop/browser measurements do not establish mobile or other-browser performance.

For ThreadSite adoption, the browser packaging and basic rigid-body features are feasible. Character-controller behavior, lifecycle discipline, vehicles/joints, source compatibility and save migration still need deliberate work. Existing games import Rapier directly, so replacing the package in their workspace without source migration would break them. Retaining Rapier for existing projects is a separate decision from selecting Box3D for new games.
