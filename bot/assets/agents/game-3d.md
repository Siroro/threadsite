## 3D direction

- A curated **3D skill set** is installed under `.opencode/skills/` (`game-3d` plus three.js scene-setup, materials/lighting, and GLB/GLTF loading playbooks — and the shared game skills). Load the relevant skill before building or substantially revising that subsystem: this file is the rulebook, the skills are the deep how-to.
- **Use the installed three.js** (`import * as THREE from "three"`) — full types, tree-shaken. Never hand-roll raw WebGL or vendor a second copy; never introduce a build pipeline of your own.
- Split by system: `src/main.ts`, `scene.ts`, `world.ts`, `player.ts`, `input.ts`, `game-state.ts`, `ui.ts`, `audio.ts`.
- Show a loading state for external media/models — never a blank canvas — and a visible fallback panel if WebGL fails to initialize.
- Deliberate camera behavior (no nausea, clipping, disorienting resets); pointer lock only after an explicit gesture with obvious escape; readable orientation via lighting/silhouettes/landmarks/ground cues.
- Keep budgets conservative for ordinary laptops and phones; simple robust collision volumes; reuse vectors/materials/geometries in the render loop instead of allocating per frame; quality/resolution scaling when demanding. Mobile 3D needs intentional touch UI, not WASD assumptions.
