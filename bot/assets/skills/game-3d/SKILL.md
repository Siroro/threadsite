---
name: game-3d
description: three.js playbook for this repository's 3D games — renderer and scene bootstrap, frame-loop discipline, physically-based lighting, materials and geometry budgets, GLB/GLTF asset loading, addon vendoring, disposal, picking, Rapier physics, BVH spatial queries, and performance patterns for the pinned three 0.186 engine package. Load before building or substantially revising 3D rendering, scenes, cameras, models, physics, or effects.
---

# three.js playbook (game-3d)

The rules that bound this project (edit scope, build step, multiplayer protocol,
validation) live in the project-root `AGENTS.md` — this skill is the engine
how-to layer beneath them. The engine is **three.js r186**, installed as a real
package in the harness-managed `node_modules/`: `import * as THREE from "three"`
gives you the full API with real TypeScript types, tree-shaken into your bundle
at build time. Two more real packages are seeded alongside it:
**`@dimforge/rapier3d-compat`** (physics) and **`three-mesh-bvh`** (BVH
acceleration for static-geometry queries). Never vendor a second copy of any of
them and never hand-roll WebGL.

## Renderer bootstrap

```ts
import * as THREE from "three";

const container = document.getElementById("game-root")!;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));   // DPR above 2 costs fill rate, not clarity
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;             // filmic highlights; pair with light intensities below
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);
scene.fog = new THREE.Fog(0x0b0e14, 30, 120);                   // cheap depth cue; also hides pop-in

const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 300);

renderer.setAnimationLoop((time) => update(time));              // one loop, started once; render at its end
```

- Handle resize (a `ResizeObserver` on the container): update `renderer.setSize`,
  `camera.aspect`, and `camera.updateProjectionMatrix()`. Never assume one
  desktop resolution.
- Color management is on by default: author colors in sRGB hex and mark color
  textures `texture.colorSpace = THREE.SRGBColorSpace` (loaded GLB textures
  already are). Output is sRGB automatically — do not convert manually.
- If WebGL context creation fails (`renderer.domElement` never appears, or a
  `WebGL context lost` event fires), show a visible error panel per AGENTS.md —
  never a blank canvas.

## Frame-loop discipline

- Drive simulation from clamped wall-clock delta, never frame count:

  ```ts
  const clock = new THREE.Clock();
  function update(time: number) {
    const dt = Math.min(clock.getDelta(), 0.05);   // clamp: tab-back must not teleport everything
    simulate(dt);
    renderer.render(scene, camera);
  }
  ```

- For solo/local presentation you may pause or throttle when `document.hidden`. In multiplayer, never pause authoritative room time just because rAF is throttled; use relay time and the host-handoff rules from AGENTS.md. A `dt` clamp still prevents giant local physics steps after focus returns.
- Use a fixed-step accumulator (120 Hz or 60 Hz) for physics-critical state and
  interpolate renders; render at whatever rate the display gives.
- Keep one `update(dt)` entry that calls per-system functions — no scattered
  `requestAnimationFrame` loops.

## Lighting (physically based since r155)

- One `DirectionalLight` (intensity 1–3) as the sun/key with shadows, plus a
  `HemisphereLight` or low `AmbientLight` for fill. That budget lights most
  games.
- `PointLight`/`SpotLight` intensity is in candela with `decay: 2` — practical
  room-scale values are tens to hundreds, not 1. A dim point light is the most
  common "my scene is black" bug.
- Shadows cost a full extra render pass: enable
  `renderer.shadowMap.enabled`, let **one** light cast, keep its shadow camera
  frustum tight around the play area, and stay at 1024px maps. Mark static
  objects `castShadow`/`receiveShadow` deliberately, not blanket.
- Light distant ambient with fog + background color instead of more lights.

## Materials and geometry budgets

- `MeshStandardMaterial` is the default choice; `MeshBasicMaterial` for unlit
  UI/skybox/billboards. Share material instances across objects that look alike —
  material count drives draw-call overhead.
- Thousands of repeated things (trees, bullets, crowd) → one `InstancedMesh`
  with per-instance matrices, not thousands of `Mesh`. Long static geometry →
  merge with `BufferGeometryUtils.mergeGeometries` (vendored addon, below).
- Geometry detail: a player capsule is a handful of primitives; downloaded GLB
  models carry their own meshes. Watch triangle counts on mobile — prefer models
  in the low thousands of triangles, not hundreds of thousands.
- `matrixAutoUpdate = false` (plus a one-time `updateMatrix()`) on static
  scenery is free performance.

## Memory and per-frame allocation

- **Dispose what you remove**: `geometry.dispose()`, `material.dispose()`, and
  every texture's `.dispose()` when the object leaves the scene for good —
  WebGL buffers otherwise leak until context loss. Route creation/removal
  through a small registry or pool module rather than bare `scene.add`.
- Hoist scratch math objects at module scope and reuse them in the loop:

  ```ts
  const _v = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  // in update():
  _v.copy(player.position).add(offset);          // no new Vector3 per frame
  ```

- `THREE.MathUtils.lerp` / `damp` for smoothing, `quaternion.slerp` for
  rotation, `Vector3.distanceToSquared` for range checks (no sqrt).

## Cameras and controls

- Choose the camera per genre and keep it deliberate: chase-cam with smoothed
  (`damp`) follow, fixed isometric-ish angle, or first-person. Avoid uncontrolled
  clipping through geometry and disorienting instant resets.
- Orbit/fly viewports: vendor `OrbitControls` (below). First-person: pointer
  lock **only after an explicit click**, with obvious escape/re-entry UX, or
  drag-to-look on touch.
- Never move the camera in ways that fight the player's input; when in doubt,
  slower and damped beats snappy and nauseating.

## Assets: models, textures, addons

- Fetch licensed GLB/GLTF models, PBR textures, and audio with `asset_download`
  into `site/assets/` (Kenney, Quaternius, Poly Haven are reliable CC0 sources);
  record provenance. Prefer compact GLB with embedded or alongside PNG/JPG
  textures. KTX2/Draco-compressed assets need extra loader addons and decoder
  WASM — skip them for a static-site game.
- Load models with the vendored `GLTFLoader`; wrap loads in a `LoadingManager`
  with a visible progress bar and a boot state — never a blank screen:

  ```ts
  import { GLTFLoader } from "../assets/vendor/addons/GLTFLoader.js";
  const loader = new GLTFLoader();
  loader.load("assets/robot.glb", (gltf) => scene.add(gltf.scene));
  ```

- **Addons** (`OrbitControls`, `GLTFLoader`, `PointerLockControls`,
  `BufferGeometryUtils`, `RoomEnvironment` for cheap PBR ambient via
  `PMREMGenerator`) are not in the installed package. Download the specific
  addon file with `asset_download` into `site/assets/vendor/addons/` and import
  it relatively — its bare `import ... from "three"` resolves through the
  workspace package at build time (see AGENTS.md's engine-packages section).
  Subpath imports like `"three/addons/*"` do **not** resolve; adapt them.

## Picking, collision, and physics

- Pointer/world picking: `raycaster.setFromCamera(ndc, camera)` then
  `intersectObjects(scene.children, true)`; build the NDC point from the event
  offset relative to the canvas rect.
- Gameplay collision: simple volumes are usually right for arcade games —
  sphere–sphere (`distanceToSquared < r1*r1 + ...`), capsule for the player
  against AABB/spheres, `Box3`/`Sphere` helpers for static level geometry.
  Fast projectiles need swept (segment) tests, not per-frame overlap.
- Anything with rigid bodies, stacking, joints, or robust character-vs-world
  collision uses the **preinstalled Rapier** package instead
  (`@dimforge/rapier3d-compat`, WASM inlined — no vendoring, no CDN helper
  wrappers, never a second engine). Initialize once before use:

  ```ts
  import RAPIER from "@dimforge/rapier3d-compat";
  await RAPIER.init();                    // during boot, before any World use
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  ```

- Rapier discipline: `Object3D` is the visual, `RigidBody`/`Collider` the
  physical truth — after each step, copy body transforms onto meshes and never
  move a physics-driven mesh by hand. Step the world at a fixed timestep from
  an accumulator (`world.timestep = 1/60`, one `world.step()` per accumulator
  tick) and interpolate rendering between the last two states. Players are a
  kinematic capsule plus `world.createCharacterController(offset)` with
  `computeColliderMovement` → `setNextKinematicTranslation`, not a dynamic
  body. Prefer primitive/convex colliders; triangle meshes only for static
  levels; never dynamic triangle-mesh bodies. Map collision/sensor events
  back to gameplay through stable entity IDs.
- Complex **static** meshes (hitscan, line-of-sight, ground queries, picking
  in dense scenes) use the preinstalled `three-mesh-bvh`: build once, query
  many times; dynamic objects stay in Rapier:

  ```ts
  import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";
  THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
  THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
  THREE.Mesh.prototype.raycast = acceleratedRaycast as unknown as typeof THREE.Mesh.prototype.raycast;
  levelGeometry.computeBoundsTree();
  raycaster.firstHitOnly = true;          // BVH-accelerated casts
  ```

## Performance checklist before finishing

- Draw calls in the low hundreds at most on the hot path (instancing, merged
  statics, shared materials).
- DPR capped at 2; drop to 1.5/1 on sustained slowdowns as a quality setting.
- No `new` inside the render loop for vectors/quaternions/materials; nothing
  accumulating across frames (pools/caps for projectiles and particles).
- Post-processing only when the request calls for it — each pass is a full-screen
  render target.
- Console free of three.js warnings (missing shadows, texture size, deprecations
  are all visible to the validation-conscious eye).

## Multiplayer note

Follow the selected mode in `AGENTS.md`. For networked games, read `NETWORKING.md`:
key live avatars by `peer.id` and render remote players with the client's
`transforms.sampleAll()`. The host owns shared simulation; do not add manual
transform interpolation. Singleplayer games need no network client.
