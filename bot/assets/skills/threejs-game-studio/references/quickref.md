<!-- ThreadSite-maintained skill, originally derived from chrislaupama/threejs-game-studio (MIT). ThreadSite context: three.js is preinstalled in this workspace's harness-managed node_modules — import it by its bare name ("three") with full TypeScript types. This workspace has NO npm, NO Vite, NO dev server, and NO project scaffold: author TypeScript under site/src, keep assets under site/assets, and the harness runs the only build (site/src TypeScript -> site/js ESM via esbuild). Map every project-setup/scaffold/build step of this skill onto the existing ThreadSite workspace layout; skip its npm/Vite instructions entirely. Verification happens in a real browser via the preview URL; see AGENTS.md. -->

## Contents

- WebGL and experimental WebGPU imports
- Timer and animation loop
- Color, tone mapping, shadows, and opaque canvases
- Loaders and renderer-specific post-processing
- Resource teardown

Authority: installed `three` runtime → matching official source/docs/migration →
aligned community `@types/three` → these recipes. For another revision, verify
before copying.

## Imports

Choose one renderer family per module; these are mutually exclusive baselines.

### WebGL

### Experimental WebGPU

```ts
import * as THREE from 'three/webgpu';
import { emissive, mrt, output, pass } from 'three/tsl';
```

## Loop

```ts
const timer = new THREE.Timer();
timer.connect(document);

renderer.setAnimationLoop((timestamp) => {
 timer.update(timestamp);
 const delta = Math.min(timer.getDelta(), 0.1);
 update(delta); // use a fixed-step accumulator for timing-sensitive gameplay
 renderer.render(scene, camera);
});

function disposeLoop() {
 renderer.setAnimationLoop(null);
 timer.dispose();
}
```

Prefer `setAnimationLoop()`. WebXR requires the renderer-owned loop. If a
WebGPU app deliberately uses manual `requestAnimationFrame()`, call `await
renderer.init()` first and own the renderer/session lifecycle explicitly.

## Color And Tone Mapping

```ts
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; // skill default; compare AgX / Neutral
renderer.toneMappingExposure = 1;
texture.colorSpace = THREE.SRGBColorSpace; // color textures only
```

Keep normal, roughness, metalness, AO, and other data textures at
`NoColorSpace`. Tone-mapper choice is art direction, not an official universal
default.

## Shadows

```ts
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
```

## Opaque Canvas (Games)

```ts
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
// Experimental WebGPU: also pass alpha:false to override its transparent default.
scene.background = new THREE.Color(0x0b1020);
```

Use transparent output deliberately for HTML compositing or AR camera
passthrough; do not add an opaque scene background to the passthrough path.

## Loaders

## Post Boundary

| Renderer | Post path |
| --- | --- |
| WebGL | `EffectComposer`: linear/HDR effects → `OutputPass` → FXAA or another pass requiring sRGB input |
| Experimental WebGPU | `RenderPipeline` + TSL nodes; never `EffectComposer` |

Apply tone mapping and output conversion once. `OutputPass` reads the renderer's
tone-mapping and output-color-space settings.

## Teardown

- Dispose owned geometry, material, texture, render target, post pass, control,
 listener, loader/worker, timer, and renderer resources.
- `AnimationMixer` has no `dispose()`: call `stopAllAction()`, then
 `uncacheRoot()` and/or `uncacheClip()` for owned animation data.
- Do not dispose shared resources through blind scene traversal. Prefer one
 lifecycle owner and explicit catalogs for hidden shader/node resources.

## Reject Quickly At The Verified Baseline
