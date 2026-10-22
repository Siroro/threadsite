<!-- ThreadSite-maintained skill, originally derived from chrislaupama/threejs-game-studio (MIT). ThreadSite context: three.js is preinstalled in this workspace's harness-managed node_modules — import it by its bare name ("three") with full TypeScript types. This workspace has NO npm, NO Vite, NO dev server, and NO project scaffold: author TypeScript under site/src, keep assets under site/assets, and the harness runs the only build (site/src TypeScript -> site/js ESM via esbuild). Map every project-setup/scaffold/build step of this skill onto the existing ThreadSite workspace layout; skip its npm/Vite instructions entirely. Verification happens in a real browser via the preview URL; see AGENTS.md. -->

# WebGPU For Heavy Three.js Games And 3D Sites

## Contents

Read `official-docs.md`, `rendering.md`, and this file before selecting
`WebGPURenderer`. Read `shaders.md` before writing TSL or post-processing nodes,
and `webxr.md` when XR is in scope.

Asset-loading examples use the project-owned `publicAssetUrl()` helper from
`local-assets.md`; import it from the local asset boundary in real code.

## Modern Contract And Status

Use that complete statement. Do not describe WebGPU as universally faster,
universally supported, or a drop-in renderer swap. Its strongest value is the
modern renderer architecture: node materials, TSL that can target WGSL or GLSL,
the node post stack, GPU compute, and newer renderer features.

## Offer The Heavy-3D Choice

For every graphics-heavy or compute-heavy 3D request, present the choice before
custom materials or post-processing make it expensive to change:

Do not ask a novice to decide from renderer names alone. Explain the visible
impact, target devices, fallback, and maintenance cost, then recommend one.

### Initial decision matrix

| Evidence | Lean toward |
| --- | --- |
| Existing GLSL shaders, `onBeforeCompile()`, or `EffectComposer` | Preserve `WebGLRenderer` unless a deliberate port is funded |
| Simple learning scene or wide mature compatibility is the main goal | `WebGLRenderer` |
| TSL-first custom materials and node post stack | `WebGPURenderer` |
| Large GPU-updated particle, flock, fluid, or procedural simulation | `WebGPURenderer`, after a compute spike |
| Dense real-depth scene with many point lights | `WebGPURenderer` plus measured `ClusteredLighting` candidate |
| Many ordinary meshes but no compute/node need | Benchmark both; instancing, batching, LOD, culling, and asset cost matter more than the API name |
| Required feature is uncertain on fallback/headset/mobile | Build the smallest representative compatibility spike first |

WebGPU does not excuse weak content architecture. Share resources, instance or
batch repeated objects, cap DPR, use compressed textures, control shadows and
transparent overdraw, stream content deliberately, and profile the worst active
state on either renderer.

## Renderer Family Boundaries

Use one customization family per renderer path:

| Area | `WebGLRenderer` | `WebGPURenderer` |
| --- | --- | --- |
| Core import | `three` | `three/webgpu` |
| Custom shading | GLSL `ShaderMaterial`, `RawShaderMaterial`, `onBeforeCompile()` | Node materials and `three/tsl` |
| Post | `EffectComposer` and addon passes | `RenderPipeline` and TSL nodes |
| Backend | WebGL 2 | WebGPU, or WebGL 2 fallback |
| Initialization | Synchronous renderer setup | `setAnimationLoop()` auto-initializes, or `await renderer.init()` |

The WebGPURenderer's WebGL 2 fallback still uses the node/TSL renderer family.
It does not enable `ShaderMaterial`, `RawShaderMaterial`, `onBeforeCompile()`, or
`EffectComposer`. If one product must keep those features and also offer a
WebGPU build, preserve two renderer adapters and choose at boot. Share game
state, input, simulation, content metadata, and semantic render roles—not GPU
objects or renderer-specific materials.

Choose at boot and reload to change renderer/backend. Live hot-swapping makes
resource ownership, material identity, render targets, caches, and recovery
unnecessarily fragile.

## TypeScript Boot And Actual Backend

This complete pattern initializes before renderer-dependent setup, reports the
actual backend after fallback has resolved, uses one animation-loop owner, and
cleans up in dependency order:

Catch that boot promise at the UI boundary. An initialization rejection is a
recoverable product state, not permission to leave a blank canvas:

```ts
try {
 const game = await createWebGpuGame(canvas);
 console.info(`Active renderer backend: ${game.backend}`);
} catch (error) {
 showRendererFailure(error, {
 retry: true,
 offerWebGLRenderer: true,
 });
}
```

`setAnimationLoop()` can initialize the first frame automatically. The explicit
`await renderer.init()` above is required because the code needs the resolved
backend and creates renderer-dependent systems before that frame. Use current
synchronous `render()`, `clear()`, `hasFeature()`, `initTexture()`, and PMREM
methods after initialization.

Keep this ownership pattern in compile-checked TypeScript under `site/src/` — the harness type-checks it on every turn.

### Force and verify the fallback

Use `forceWebGL` only at construction:

```ts
const renderer = new THREE.WebGPURenderer({
 canvas,
 antialias: true,
 forceWebGL: true,
 alpha: false,
});
await renderer.init();
```

This tests the WebGPURenderer's WebGL 2 backend. It is different from testing a
separate `WebGLRenderer` path. Record these independently:

```text
Renderer class: WebGPURenderer
Requested backend: automatic / forced WebGL2
Actual backend after init: WebGPU / WebGL2
Material family: built-in mapped material / node material + TSL
Post family: direct / RenderPipeline
```

## Materials And TSL

`WebGPURenderer` maps supported built-in materials internally, so ordinary
`MeshStandardMaterial` and `MeshPhysicalMaterial` content can render. Use node
materials when custom shader behavior is required. Do not translate GLSL line
by line; rebuild the semantic inputs and outputs with TSL.

```ts
import * as THREE from 'three/webgpu';
import { color, mix, time, uniform } from 'three/tsl';

const cool = uniform(new THREE.Color(0x16457a));
const hot = uniform(new THREE.Color(0x31dcff));
const pulse = time.mul(2).sin().mul(0.5).add(0.5);

const material = new THREE.MeshStandardNodeMaterial();
material.colorNode = mix(cool, hot, pulse.mul(0.35));
material.emissiveNode = color(0x14bde8).mul(pulse.mul(1.5));
material.roughness = 0.45;
material.metalness = 0.1;

cool.value.set(0x1c4f8f);
```

Use JavaScript branches outside a TSL function for CPU-side material selection.
For a value that varies per vertex, fragment, or compute invocation, put flow
inside `Fn()` and use TSL `If()`, `Switch()`, or `Loop()`:

```ts
// Continuing the material example above.
import { Fn, If, float } from 'three/tsl';

const shapePulse = Fn(([value]: [typeof pulse]) => {
 const result = value.toVar();

 If(value.greaterThan(0.65), () => {
 result.assign(float(1));
 });

 return result;
});

material.emissiveNode = color(0x14bde8).mul(shapePulse(pulse));
```

Read the official [TSL specification](https://threejs.org/docs/TSL.html) for
typed constants, variables, functions, arrays, loops, texture sampling,
material slots, render passes, and storage. Keep reusable graph functions small
and name important uniforms/functions so generated shader diagnostics remain
readable.

Keep color-space semantics identical to the WebGL path: color and emissive maps
use `SRGBColorSpace`; normal, roughness, metalness, AO, masks, and other data
maps use `NoColorSpace`; HDR loader output remains in its provided linear
space. Let `GLTFLoader` apply glTF material conventions.

TSL changes quickly. Resolve every import against the installed `three/tsl`
export, typecheck it, and compare it with the version-matching official example.
Use `setName()`, `isolate()`, `Stack()`, `packNormalToRGB()`,
`unpackRGBToNormal()`, and current node names—not compatibility aliases.

## GPU Compute

GPU compute is a strong reason to offer WebGPU when many similar elements can
remain on the GPU: particles, boids, cellular fields, procedural deformation,
fluid-like effects, visibility preparation, and other data-parallel work. Keep
authoritative gameplay state on the CPU unless the design accepts asynchronous
readback and a different determinism/debugging model.

The current pattern creates storage-backed instanced arrays, initializes them
after renderer initialization, dispatches with `renderer.compute()`, and reads
the same data as vertex attributes:

This is a presentation effect, not a collision system. Keep player hits,
objectives, scores, and other authoritative rules in deterministic CPU state or
design an explicit, infrequent readback boundary with loading/error handling.
Avoid GPU-to-CPU readback in the frame hot path. When a deliberate checkpoint
needs a snapshot, use the current renderer readback API and remember that WGSL
storage `vec3` data may be padded to a four-float stride:

```ts
const positionBytes = await renderer.getArrayBufferAsync(positions.value);
const positionFloats = new Float32Array(positionBytes);
const storageStride = positions.value.itemSize;
const firstPosition = positionFloats.subarray(0, Math.min(3, storageStride));
```

For repeated diagnostics, a
[ReadbackBuffer](https://threejs.org/docs/pages/ReadbackBuffer.html) can reuse
the intermediate GPU buffer, but it must be `release()`d between mappings and
`dispose()`d at teardown. Readback still stalls asynchronous GPU work; it is not
a substitute for CPU-authoritative collision or per-frame telemetry.

The bounded delta makes motion independent of display refresh within the
integrator's limits and avoids a large hidden-tab step. A fixed compute cadence
is preferable when repeatability matters. The second TSL `.compute()` argument
is the workgroup size—`simulate().compute(COUNT, [64])` makes the default
one-dimensional size explicit. Tune it only with target-device measurements and
device-limit checks. `renderer.compute(node, [x, y, z])` also accepts a runtime
multidimensional dispatch override, or an `IndirectStorageBufferAttribute` for
indirect dispatch. Atomics and `workgroupBarrier()` solve specific shared-data
hazards; a workgroup barrier does not synchronize separate workgroups or
dispatches.

Stop the animation loop and dispose the `Timer`, compute nodes, node material,
and storage attribute owners during teardown, as the example does.

`computeAsync()` remains a current method on modern revisions. Prefer `compute()` after
explicit initialization for the ordinary frame loop; use async APIs only when
their actual promise/readback semantics are needed. Do not repeat the migration
guide's ambiguous `computerAsync` spelling as an API name.

## Many Lights With ClusteredLighting

Assign the lighting system before `renderer.init()`:

```ts
import * as THREE from 'three/webgpu';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';

const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false });
renderer.lighting = new ClusteredLighting(
 1024, // maximum point lights
 32, // tile size in pixels
 24, // depth slices
 64, // maximum lights per cluster
);
await renderer.init();
```

Use it only after the lighting design truly needs many local point lights.
Baked emissive art, environment lighting, a small key/fill rig, pooled lights,
and fewer shadow casters remain cheaper.

Measure cluster construction/compute, fragment cost, light overlap, shadow
maps, and target-device behavior. Validate the WebGL 2 fallback separately; do
not infer compatibility from WebGPU success.

## RenderPipeline Post-Processing

```ts
import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

const scenePass = pass(scene, camera);
const sceneColor = scenePass.getTextureNode('output');
const glow = bloom(sceneColor, 0.45, 0.25, 0.9);
glow.setResolutionScale(0.5);

const pipeline = new THREE.RenderPipeline(renderer);
pipeline.outputNode = sceneColor.add(glow);

function renderPostFrame() {
 if (renderer.xr.isPresenting) {
 renderer.render(scene, camera);
 } else {
 pipeline.render();
 }
}

await renderer.setAnimationLoop(renderPostFrame);

async function disposePost() {
 const session = renderer.xr.getSession();
 if (session) await session.end();

 // Clear the callback restored by XRManager before disposing its graph.
 await renderer.setAnimationLoop(null);
 glow.dispose();
 scenePass.dispose();
 pipeline.dispose();
}
```

Changing uniforms such as bloom strength updates the existing graph. Replacing
the graph after its first render requires the documented invalidation flag and
an explicit ownership handoff for every target-owning node retired with the old
graph:

```ts
type DisposableNodeOwner = { dispose(): void };

async function replacePostGraph(
 nextOutputNode: THREE.Node,
 retiredOwners: readonly DisposableNodeOwner[],
) {
 if (renderer.xr.getSession()) {
 throw new Error('Defer post-graph replacement until the XR session ends');
 }

 await renderer.setAnimationLoop(null);
 pipeline.outputNode = nextOutputNode;
 pipeline.needsUpdate = true;
 for (const owner of retiredOwners) owner.dispose();
 await renderer.setAnimationLoop(renderPostFrame);
}
```

Only pass owners that are absent from the new graph; shared scene passes and
history targets must stay alive until their final consumer releases them. Keep
the loop stopped from graph detachment through retired-owner disposal so no
frame can observe a half-replaced graph.

When an effect needs more than beauty color, capture only the required outputs
with MRT. This selective-bloom form renders beauty and emissive data together,
then blooms only the emissive channel:

```ts
import { emissive, mrt, output, pass as renderMrtPass } from 'three/tsl';
import { bloom as bloomEmissive } from 'three/addons/tsl/display/BloomNode.js';

const selectivePass = renderMrtPass(scene, camera);
selectivePass.setMRT(mrt({ output, emissive }));

const beauty = selectivePass.getTextureNode('output');
const emissiveOnly = selectivePass.getTextureNode('emissive');
const selectiveGlow = bloomEmissive(emissiveOnly, 0.45, 0.25, 0.9);

const selectivePipeline = new THREE.RenderPipeline(renderer);
selectivePipeline.outputNode = beauty.add(selectiveGlow);

async function disposeSelectivePost() {
 const session = renderer.xr.getSession();
 if (session) await session.end();

 // Clear the callback restored by XRManager before disposing target owners.
 await renderer.setAnimationLoop(null);
 selectiveGlow.dispose();
 selectivePass.dispose();
 selectivePipeline.dispose();
}
```

Depth is available from `getTextureNode('depth')` without adding an MRT color
attachment. Normals, velocity, emissive, and custom outputs add target memory
and bandwidth, so request them only when a downstream effect consumes them and
choose their texture types deliberately. See the official
[TSL MRT contract](https://threejs.org/docs/TSL.html#multiple-render-targets-mrt)
and [BloomNode](https://threejs.org/docs/pages/BloomNode.html) selective example.

`RenderPipeline` applies tone mapping and output color conversion by default.
Do not add a second conversion. For an effect that must run after conversion,
use the current `renderOutput()` node deliberately and set
`pipeline.outputColorTransform = false`.

## Texture Compression And Output Bandwidth

For heavy 3D, reduce upload size, GPU memory, and sampling bandwidth before
assuming a renderer change will solve content cost. Prefer glTF/GLB plus local
KTX2 textures when the pipeline supports them.

Initialize WebGPU before KTX2 capability detection:

```ts
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

await renderer.init();
const ktx2 = new KTX2Loader()
 .setTranscoderPath(publicAssetUrl('assets/basis/'))
 .detectSupport(renderer);

const texture = await ktx2.loadAsync(
 publicAssetUrl('assets/textures/world-color.ktx2'),
);
```

Keep the transcoder files project-local. Dispose the loader when loading is
complete and dispose textures when their owning content is released.

`WebGPURenderer` defaults `outputBufferType` to `HalfFloatType` for quality.
The official API allows `UnsignedByteType` to save memory and bandwidth at a
quality cost. Treat this as a measured quality-tier choice, not an automatic
mobile switch:

```ts
const renderer = new THREE.WebGPURenderer({
 canvas,
 alpha: false,
 outputBufferType: lowBandwidthTier
 ? THREE.UnsignedByteType
 : THREE.HalfFloatType,
});
```

Changing renderer options requires rebuilding the renderer path at boot.

## Diagnostics And Profiling

Report the renderer class and actual backend after initialization. For the
WebGPU renderer family, the current common
[Info](https://threejs.org/docs/pages/Info.html) shape includes draw calls,
triangles, compute calls, resource counts, and tracked byte sizes:

```ts
function readWebGpuStats(renderer: THREE.WebGPURenderer) {
 const { render, compute, memory } = renderer.info;
 return {
 backend: backendName(renderer),
 drawCalls: render.drawCalls,
 triangles: render.triangles,
 computeCalls: compute.frameCalls,
 geometries: memory.geometries,
 textures: memory.textures,
 textureBytes: memory.texturesSize,
 renderTargets: memory.renderTargets,
 totalTrackedBytes: memory.total,
 };
}
```

These counters do not replace a GPU timeline. Measure representative frame
captures, not empty scenes. Compare native WebGPU and every claimed fallback at
the same CSS size, DPR, scene state, camera, quality tier, and warm-up state.

After initialization, guard timestamp use and resolve render and compute pools
explicitly—the method's no-argument default resolves render timing only:

```ts
if (renderer.hasFeature('timestamp-query')) {
 const renderMs = await renderer.resolveTimestampsAsync(
 THREE.TimestampQuery.RENDER,
 );
 const computeMs = await renderer.resolveTimestampsAsync(
 THREE.TimestampQuery.COMPUTE,
 );
 console.debug({ renderMs, computeMs });
}
```

Resolve outside the ordinary per-frame hot path; frequent query resolution and
GPU readback can disturb the workload being measured. The WebGL 2 fallback can
report different feature support, so perform the guard after the actual backend
has initialized.

Track at least:

- CPU frame/update/render-submit time and GPU frame/pass time
- actual backend, canvas buffer size, DPR, output buffer type, and MSAA
- draw calls, triangles, active programs/pipelines, compute dispatches
- texture/target/storage-buffer counts and tracked bytes
- transparent fill, particle area, shadow maps/casters, and post-pass cost
- compile hitches, asset decode/upload time, memory growth, and re-entry baseline

## Failure, Recovery, And Quality Tiers

Do not silently hide backend failures. Surface `renderer.onError` messages in a
diagnostic/loading-error UI. On `renderer.onDeviceLost`, stop simulation and
the loop, preserve recoverable game state, and offer a controlled renderer
rebuild or page restart. Test the chosen recovery path; callback presence is not
proof of recovery.

Build quality tiers from measured owners:

| Owner | Lower-cost response |
| --- | --- |
| Fill/post cost | Lower capped DPR, lower effect resolution, fewer passes |
| Many lights | Fewer active lights, smaller ranges, no low-value shadows, measured clustered path |
| Geometry submission | Instancing, batching, LOD, culling, fewer material variants |
| Texture bandwidth/memory | KTX2, lower resolution, atlas/packing, fewer simultaneous sets |
| Compute | Fewer elements/iterations/dispatches, lower update cadence, CPU alternative for small counts |
| Transparency | Smaller particle footprint, alpha test, pooled effects, less overlap |

Degrade visual density without changing authoritative gameplay, collision,
objectives, or timing. Use hysteresis so adaptive quality does not oscillate.

## Current Deprecation Guardrails

## WebGPU Release Gate

Before claiming a WebGPU game/site is complete, prove:

Choose WebGPU because the project benefits from its architecture and passes
this evidence gate—not because the scene is merely called advanced.
