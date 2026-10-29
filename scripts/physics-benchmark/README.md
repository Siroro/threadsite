# Local physics comparison

Compare ThreadSite's pinned Rapier compat 0.21.0 with Box3D through `box3d.js` 0.1.1. This is an isolated development demo; it does not change the bot's engine selection or touch generated games.

Requires Node 24, the installed `bot/` dependencies (esbuild, Three.js, Rapier and TypeScript), and installed `preview/` dependencies (Playwright). An installed Edge/Chrome or the matching Playwright Chromium is required. The runner tries Edge, Chrome, then Playwright Chromium; `PHYSICS_BROWSER_CHANNEL` can select a preferred installed channel.

From this directory:

```sh
npm ci
npm run bench
npm run demo
```

`bench` builds browser bundles, measures six repetitions, runs behavioral checks and exercises both engines in the 3D viewer. It writes `dist/results.json` (all samples, health counters and environment), `dist/report.md`, `dist/sizes.json` and `dist/demo.png`. `demo` serves those results and the interactive viewer at http://127.0.0.1:8793. Stop it with Ctrl+C. `node run.mjs --serve` measures and keeps the server running in one command. Results are local and ignored by Git.

If no browser is installed, install the preview component's matching browser:

```sh
node ../../preview/node_modules/playwright/cli.js install chromium
```

Type-check the adapters and demo:

```sh
node ../../bot/node_modules/typescript/bin/tsc -p tsconfig.json
```

The five scenes cover driven capsule actors, moving platforms, sensors, a static mesh ramp, crate stacks, fast CCD spheres, dense mixed props with 128 rays per tick, and sleeping props. Scene definitions and game logic are shared; only the engine adapters differ. The visual viewer runs one engine at a time and supports engine/scene selection, pause and restart. Its quick comparison runs one repetition; use CLI results for the comparison.

The measured step includes the engine call. The measured tick also includes steering, resets, sensor polling, queries, transform reads and diagnostics, with no rendering. Raycast time is also recorded separately. Quantiles use ten-tick batch averages to reduce the impact of browser timer precision. The local server supplies COOP/COEP headers for higher timer precision, with the observed resolution recorded; both WASM builds remain single threaded. The report takes the median of each statistic across six repetitions; raw run ranges are retained. Engine order alternates and scene order rotates. Each engine/repetition gets a fresh page; each scene gets a fresh world. The benchmark page never initializes WebGL or starts a visual simulation.

Both engines run single threaded at 60 Hz with identical geometry, material values, damping and sleep policy. Rapier uses four solver iterations; Box3D uses four substeps. These settings do not promise equal solver work or accuracy. Shape contact events are disabled; sensors generate entry/exit events. Arena capsules use velocity steering with locked rotation, not either engine's character controller. Downward rays exclude neither solid scenery nor dynamic props; the query scene contains no sensors. See the [feature comparison](../../docs/physics-comparison.md) for the distinction between supported features and behavior actually tested.

Before timing, each adapter must pass ground collision, sensor entry/exit, ray and body removal checks. Measured scenes must have finite poses, no bodies below ground and no projectile wall crossings; every downward ray must hit; all settled props must sleep. These checks catch gross failures, not subtle contact quality, controller correctness or long-term leaks.

Bundle sizes measure the browser ESM output, including embedded WASM and the same adapter functionality. Both use ThreadSite's minified ES2022 build settings and retained legal comments. The viewer is built separately with the bot's Three.js pin. Full demo sizes add the separately compressed viewer and selected engine. Compression is gzip level 9 and Brotli quality 11, independent of hosting configuration.
