export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type EngineName = "rapier" | "box3d";
export type SceneName = "arena" | "stacks" | "projectiles" | "queries" | "sleeping";
export interface BodySpec {
  shape: "box" | "sphere" | "capsule" | "mesh";
  position: Vec3;
  size: Vec3;
  type?: "dynamic" | "fixed" | "kinematic";
  velocity?: Vec3;
  sensor?: boolean;
  actor?: boolean;
  bullet?: boolean;
}
export interface Pose { position: Vec3; rotation: Quat }
export interface Physics {
  add(spec: BodySpec): number;
  remove(id: number): void;
  move(id: number, position: Vec3): void;
  velocity(id: number, velocity: Vec3): void;
  read(id: number, out: Pose): void;
  awake(id: number): boolean;
  ray(origin: Vec3, translation: Vec3): boolean;
  events(): { begin: number; end: number };
  step(): void;
  destroy(): void;
}
export interface Engine { create(sleep: boolean): Physics }
export const DT = 1 / 60;
export const SCENES: { id: SceneName; label: string; detail: string }[] = [
  { id: "arena", label: "Arena", detail: "24 driven capsules, 48 props, 4 moving platforms, 4 sensors and a mesh ramp" },
  { id: "stacks", label: "Crate stacks", detail: "144 crates in 12 towers; sleeping disabled" },
  { id: "projectiles", label: "Fast projectiles", detail: "64 spheres at 180 m/s against an 8 cm wall; CCD enabled" },
  { id: "queries", label: "World queries", detail: "192 mixed props, a mesh ramp and 128 downward rays per tick" },
  { id: "sleeping", label: "Settled props", detail: "240 ground-level crates; 10 seconds settling with sleeping enabled" },
];
// Shared ramp, CCW front faces, in local space. Both engines receive identical triangles.
export const RAMP_VERTICES = new Float32Array([-3, 0, -3, 3, 0, -3, -3, 2, 3, 3, 2, 3]);
export const RAMP_INDICES = new Uint32Array([0, 2, 1, 1, 2, 3]);
export const pose = (): Pose => ({ position: [0, 0, 0], rotation: [0, 0, 0, 1] });

export function sceneSpecs(name: SceneName): BodySpec[] {
  const specs: BodySpec[] = [{ shape: "box", position: [0, -0.5, 0], size: [20, 0.5, 20], type: "fixed" }];
  if (name === "projectiles") {
    specs.push({ shape: "box", position: [0, 5, 0], size: [0.04, 5, 10], type: "fixed" });
    for (let i = 0; i < 64; i++) specs.push({ shape: "sphere", position: [-8, 1 + i % 8 * 0.6, (Math.floor(i / 8) - 3.5) * 0.6], size: [0.12, 0, 0], velocity: [180, 0, 0], bullet: true });
    return specs;
  }
  for (const [x, z, hx, hz] of [[-19, 0, 0.5, 19], [19, 0, 0.5, 19], [0, -19, 19, 0.5], [0, 19, 19, 0.5]]) {
    specs.push({ shape: "box", position: [x, 2, z], size: [hx, 2.5, hz], type: "fixed" });
  }
  if (name === "arena" || name === "queries") specs.push({ shape: "mesh", position: [0, 0.02, 0], size: [1, 1, 1], type: "fixed" });
  if (name === "arena") {
    for (let i = 0; i < 24; i++) specs.push({ shape: "capsule", position: [(i % 6 - 2.5) * 2.4, 3, (Math.floor(i / 6) - 1.5) * 3.2], size: [0.35, 0.5, 0], actor: true });
    for (let i = 0; i < 48; i++) specs.push({ shape: i % 3 ? "box" : "sphere", position: [(i % 8 - 3.5) * 1.9, 6 + Math.floor(i / 16) * 1.2, (Math.floor(i / 8) - 2.5) * 2.2], size: [0.4, 0.4, 0.4] });
    for (let i = 0; i < 4; i++) {
      specs.push({ shape: "box", position: [-12 + i * 8, 1.5, 11], size: [1.5, 0.25, 1.5], type: "kinematic" });
      specs.push({ shape: "box", position: [-9 + i * 6, 1, -5], size: [2, 1, 2], type: "fixed", sensor: true });
    }
  } else if (name === "stacks") {
    for (let i = 0; i < 144; i++) specs.push({ shape: "box", position: [(i % 4 - 1.5) * 3, 0.5 + Math.floor(i / 12) * 1.01, (Math.floor(i / 4) % 3 - 1) * 3], size: [0.5, 0.5, 0.5] });
  } else {
    const count = name === "sleeping" ? 240 : 192;
    for (let i = 0; i < count; i++) specs.push({ shape: name === "sleeping" ? "box" : (["box", "sphere", "capsule"] as const)[i % 3], position: [(i % 16 - 7.5) * 1.9, name === "sleeping" ? 0.55 : 3 + Math.floor(i / 64) * 1.5, (Math.floor(i / 16) - (count / 16 - 1) / 2) * 1.9], size: [0.35, 0.4, 0.35] });
  }
  return specs;
}

export function createScene(engine: Engine, name: SceneName) {
  const physics = engine.create(name === "sleeping");
  const specs = sceneSpecs(name);
  const ids = specs.map(spec => physics.add(spec));
  const poses = specs.map(pose);
  const dynamic = specs.flatMap((spec, i) => (!spec.type || spec.type === "dynamic") ? [i] : []);
  const actors = dynamic.filter(i => specs[i].actor);
  const platforms = specs.flatMap((spec, i) => spec.type === "kinematic" ? [i] : []);
  const rays = Array.from({ length: 128 }, (_, i): Vec3 => [(i % 16 - 7.5) * 1.7, 20, (Math.floor(i / 16) - 3.5) * 3.4]);
  const down: Vec3 = [0, -30, 0];
  const velocityScratch: Vec3 = [0, 0, 0];
  let ticks = 0, rayHits = 0, sensorBegin = 0, sensorEnd = 0;
  let invalid = 0, belowGround = 0, throughWall = 0;
  const invalidIds = new Set<number>(), belowIds = new Set<number>(), tunnelIds = new Set<number>();
  return {
    physics, specs, ids, poses, dynamic,
    before() {
      for (let a = 0; a < actors.length; a++) {
        const i = actors[a];
        physics.read(ids[i], poses[i]);
        // Steering is shared game logic, not either engine's character controller.
        const targetX = Math.sin(ticks / 120 + a) * 10;
        const targetZ = Math.cos(ticks / 150 + a * 0.7) * 10;
        velocityScratch[0] = Math.max(-3, Math.min(3, targetX - poses[i].position[0]));
        velocityScratch[1] = 0;
        velocityScratch[2] = Math.max(-3, Math.min(3, targetZ - poses[i].position[2]));
        physics.velocity(ids[i], velocityScratch);
      }
      for (const i of platforms) {
        velocityScratch[0] = Math.cos(ticks / 60) * 2;
        velocityScratch[1] = velocityScratch[2] = 0;
        physics.velocity(ids[i], velocityScratch);
      }
      if (name === "projectiles" && ticks % 60 === 0) {
        for (const i of dynamic) { physics.move(ids[i], specs[i].position); physics.velocity(ids[i], specs[i].velocity!); }
      }
    },
    after() {
      let queryMs = 0;
      if (name === "queries") {
        const start = performance.now();
        for (const ray of rays) if (physics.ray(ray, down)) rayHits++;
        queryMs = performance.now() - start;
      }
      const events = physics.events(); sensorBegin += events.begin; sensorEnd += events.end;
      for (const i of dynamic) {
        physics.read(ids[i], poses[i]);
        const p = poses[i].position;
        if (!p.every(Number.isFinite) || !poses[i].rotation.every(Number.isFinite)) invalidIds.add(i);
        if (p[1] < -0.3) belowIds.add(i);
        if (name === "projectiles" && p[0] > 0.2) tunnelIds.add(i);
      }
      invalid = invalidIds.size; belowGround = belowIds.size; throughWall = tunnelIds.size; ticks++;
      return queryMs;
    },
    health() {
      const stackMinTopY = name === "stacks" ? Math.min(...dynamic.slice(-12).map(i => poses[i].position[1])) : null;
      const stackMaxDrift = name === "stacks" ? Math.max(...dynamic.map(i => Math.hypot(poses[i].position[0] - specs[i].position[0], poses[i].position[2] - specs[i].position[2]))) : null;
      return { ticks, dynamicBodies: dynamic.length, awake: dynamic.filter(i => physics.awake(ids[i])).length, rayHits, sensorBegin, sensorEnd, invalid, belowGround, throughWall, stackMinTopY, stackMaxDrift };
    },
    destroy() { physics.destroy(); },
  };
}

export function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { mean: samples.reduce((a, b) => a + b, 0) / samples.length, p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] };
}

export async function benchmark(engine: Engine, name: SceneName, batches = 60) {
  const scene = createScene(engine, name);
  try {
    const warmup = name === "sleeping" ? 600 : 120;
    for (let i = 0; i < warmup; i++) { scene.before(); scene.physics.step(); scene.after(); }
    const tickSamples: number[] = [], stepSamples: number[] = [], querySamples: number[] = [];
    for (let batch = 0; batch < batches; batch++) {
      let steps = 0, queries = 0;
      const start = performance.now();
      for (let tick = 0; tick < 10; tick++) {
        scene.before();
        const stepStart = performance.now(); scene.physics.step(); steps += performance.now() - stepStart;
        queries += scene.after();
      }
      tickSamples.push((performance.now() - start) / 10); stepSamples.push(steps / 10); querySamples.push(queries / 10);
      // Yield outside the timed interval. The demo remains responsive; no render work is timed.
      if (batch % 10 === 9) await new Promise(resolve => setTimeout(resolve, 0));
    }
    return { scene: name, warmupTicks: warmup, measuredTicks: batches * 10, tick: stats(tickSamples), step: stats(stepSamples), query: stats(querySamples), tickSamples, stepSamples, querySamples, health: scene.health() };
  } finally { scene.destroy(); }
}

export function verify(engine: Engine) {
  const physics = engine.create(false);
  try {
    physics.add({ shape: "box", position: [0, -0.5, 0], size: [10, 0.5, 10], type: "fixed" });
    physics.add({ shape: "box", position: [0, 1, 0], size: [2, 1, 2], sensor: true, type: "fixed" });
    const id = physics.add({ shape: "sphere", position: [0, 5, 0], size: [0.5, 0, 0] });
    let begin = 0, end = 0;
    for (let i = 0; i < 180; i++) { physics.step(); const e = physics.events(); begin += e.begin; end += e.end; }
    const out = pose(); physics.read(id, out);
    if (Math.abs(out.position[1] - 0.5) > 0.1) throw new Error(`Ground collision failed: ${out.position}`);
    if (!begin) throw new Error("Sensor entry was not reported");
    physics.move(id, [6, 4, 0]);
    for (let i = 0; i < 5; i++) { physics.step(); end += physics.events().end; }
    if (!end) throw new Error("Sensor exit was not reported");
    if (!physics.ray([6, 8, 0], [0, -20, 0])) throw new Error("Ray missed body/ground");
    physics.remove(id);
    if (physics.ray([6, 8, 0], [0, -5, 0])) throw new Error("Removed body remained in query structure");
    return { groundCollision: true, sensorEntryExit: true, raycast: true, bodyRemoval: true };
  } finally { physics.destroy(); }
}
