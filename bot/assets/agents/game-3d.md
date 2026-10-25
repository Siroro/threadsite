## 3D

Use installed `three`, `@dimforge/rapier3d-compat` and `three-mesh-bvh`; never add another renderer/physics engine. Read `game-3d` and relevant `threejs-game-studio` references for implementation.

- Import `three` by bare name. The glTF loading addons are seeded with types: `GLTFLoader` and `DRACOLoader` from `three/addons/loaders/*.js`, `MeshoptDecoder` from `three/addons/libs/meshopt_decoder.module.js` — no vendoring needed. Load models with `GLTFLoader` (plus `setDRACOLoader`/`setMeshoptDecoder` when the asset needs them; Draco also requires decoder files installed under `site/assets/` and `setDecoderPath` with a page-relative URL). Import `.glb`/`.gltf` files like other media — the import binds the emitted asset URL — or fetch them at runtime by relative URL.
- Other addons are not seeded: download needed files into `site/assets/vendor/addons/`, keeping bare `"three"` imports; adapt unsupported `three/addons/*` imports.
- Coordinate convention: yaw = `atan2(dx, dz)`, forward = `(sin yaw, 0, cos yaw)`; model `rotation.y` and net `facing` use that yaw. Left increases yaw. Map controls through the camera basis when it rotates; north-up top-down cameras use `camera.up.set(0, 0, -1)`.
- Every model must visibly face its velocity: glTF assets are authored forward = +Z (up = +Y), matching the yaw convention. When an export faces another way, correct it once at load — a wrapper group or baked rotation in the loader callback — never per use site, and never by inverting input axes. Verify with the game running: entities, turrets and projectiles point where they move and fire.
- Use Rapier for rigid bodies/robust character collision; simple arcade overlap tests may use three math. Never simulate the same objects with both. Initialize Rapier once, fixed-step physics, then copy body transforms to meshes; characters use its kinematic controller.
- Retire physics entities once, removing both bodies and tracking entries. Never swallow Rapier exceptions or reuse removed handles.
- Build BVHs once for complex static queries; dynamic objects use Rapier. Use waypoints/grid/steering for navigation rather than adding a navmesh engine.
- Compose a lit, populated opening camera view. Provide loading/WebGL failure UI, gesture-only pointer lock with escape, touch controls and conservative render budgets.
