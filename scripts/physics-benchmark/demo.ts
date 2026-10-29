import * as THREE from "three";
import { benchmark, createScene, DT, RAMP_INDICES, RAMP_VERTICES, SCENES, verify, type Engine, type EngineName, type SceneName } from "./shared.js";

const engines = new Map<EngineName, Engine>();
async function loadEngine(name: EngineName) {
  if (!engines.has(name)) {
    const module = await import(new URL(`./engines/${name}.js`, import.meta.url).href) as { load(): Promise<Engine> };
    engines.set(name, await module.load());
  }
  return engines.get(name)!;
}
const api = {
  async run(engine: EngineName, scene: SceneName) { return benchmark(await loadEngine(engine), scene); },
  async verify(engine: EngineName) { return verify(await loadEngine(engine)); },
  async initialize(engine: EngineName) {
    const start = performance.now(); await loadEngine(engine); return performance.now() - start;
  },
  stop() { running = false; },
  state() { return { running, ticks: current?.health().ticks ?? 0, error: lastError }; },
};
declare global { interface Window { physicsBench: typeof api; demoReady: boolean } }
window.physicsBench = api;

const status = document.querySelector<HTMLElement>("#status")!;
const engineSelect = document.querySelector<HTMLSelectElement>("#engine")!;
const sceneSelect = document.querySelector<HTMLSelectElement>("#scene")!;
for (const entry of SCENES) sceneSelect.add(new Option(entry.label, entry.id));
const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
let running = false, generation = 0, lastError: string | null = null;
let current: ReturnType<typeof createScene> | undefined;
let renderer: THREE.WebGLRenderer | undefined;
let scene: THREE.Scene, camera: THREE.PerspectiveCamera;
let meshes: THREE.Mesh[] = [];
const geometries = new Set<THREE.BufferGeometry>();
const materials = new Set<THREE.Material>();

function initRenderer() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x101c2b);
  scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xd9efff, 0x5b4368, 2.4));
  const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(6, 20, 8); scene.add(light);
  camera = new THREE.PerspectiveCamera(48, 1, 0.1, 180);
  camera.position.set(30, 29, 34); camera.lookAt(0, 2, 0);
  scene.add(new THREE.GridHelper(40, 40, 0x47637b, 0x2a3e52));
  const resize = () => { const rect = canvas.getBoundingClientRect(); renderer!.setSize(rect.width, rect.height, false); camera.aspect = rect.width / rect.height; camera.updateProjectionMatrix(); };
  new ResizeObserver(resize).observe(canvas); resize();
}

async function restart() {
  const request = ++generation;
  running = false; window.demoReady = false;
  status.textContent = "Loading physics…";
  const engineName = engineSelect.value as EngineName, sceneName = sceneSelect.value as SceneName;
  const engine = await loadEngine(engineName);
  if (request !== generation) return;
  initRenderer();
  current?.destroy();
  for (const mesh of meshes) scene.remove(mesh);
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  geometries.clear(); materials.clear(); meshes = [];
  current = createScene(engine, sceneName);
  document.querySelector("#description")!.textContent = SCENES.find(entry => entry.id === sceneName)!.detail;
  for (const spec of current.specs) {
    let geometry: THREE.BufferGeometry;
    if (spec.shape === "sphere") geometry = new THREE.SphereGeometry(spec.size[0], 12, 8);
    else if (spec.shape === "capsule") geometry = new THREE.CapsuleGeometry(spec.size[0], spec.size[1] * 2, 4, 8);
    else if (spec.shape === "mesh") {
      geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.BufferAttribute(RAMP_VERTICES.slice(), 3)); geometry.setIndex(new THREE.BufferAttribute(RAMP_INDICES.slice(), 1)); geometry.computeVertexNormals();
    } else geometry = new THREE.BoxGeometry(...spec.size.map(value => value * 2) as [number, number, number]);
    const color = spec.sensor ? 0xb2a0ff : spec.actor ? 0x55d6c2 : spec.bullet ? 0xffd179 : spec.type === "kinematic" ? 0xd89aff : spec.type === "fixed" ? 0x334b60 : 0xf09169;
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.75, transparent: !!spec.sensor, opacity: spec.sensor ? 0.25 : 1, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material); mesh.position.fromArray(spec.position);
    geometries.add(geometry); materials.add(material); meshes.push(mesh); scene.add(mesh);
  }
  accumulator = 0; last = performance.now(); running = true; window.demoReady = true;
}

let last = performance.now(), accumulator = 0, tickTimes: number[] = [], frames = 0;
function frame(now: number) {
  requestAnimationFrame(frame);
  const elapsed = Math.min((now - last) / 1000, 0.1); last = now;
  if (!running || !current || !renderer) return;
  accumulator += elapsed;
  while (accumulator >= DT) {
    const start = performance.now(); current.before(); current.physics.step(); current.after(); tickTimes.push(performance.now() - start); accumulator -= DT;
  }
  // Rendering is visual only; the benchmark does not time this code or the GPU.
  for (let i = 0; i < meshes.length; i++) {
    if (current.specs[i].type === "fixed") continue;
    current.physics.read(current.ids[i], current.poses[i]);
    meshes[i].position.fromArray(current.poses[i].position); meshes[i].quaternion.fromArray(current.poses[i].rotation);
  }
  renderer.render(scene, camera);
  if (++frames % 30 === 0) {
    const health = current.health();
    const mean = tickTimes.length ? tickTimes.reduce((a, b) => a + b, 0) / tickTimes.length : 0;
    status.textContent = `${engineSelect.selectedOptions[0].text} · ${health.dynamicBodies} dynamic · ${health.awake} awake · live tick ${mean.toFixed(3)} ms · wall crossings ${health.throughWall}`;
    tickTimes = [];
  }
}
requestAnimationFrame(frame);
engineSelect.addEventListener("change", () => void restart().catch(showError));
sceneSelect.addEventListener("change", () => void restart().catch(showError));
document.querySelector("#restart")!.addEventListener("click", () => void restart().catch(showError));
document.querySelector("#pause")!.addEventListener("click", event => { running = !running; (event.target as HTMLButtonElement).textContent = running ? "Pause" : "Resume"; });
function showError(error: unknown) { lastError = String(error); status.textContent = lastError; console.error(error); }

async function showSavedResults() {
  const response = await fetch("results.json");
  if (response.ok) renderResults(await response.json());
}
function renderResults(data: { summary: { engine: string; scene: string; tickP50: number; tickP95: number; stepP50: number }[]; sizes: Record<string, { raw: number; gzip: number; brotli: number }> }) {
  const body = document.querySelector("#results tbody")!; body.replaceChildren();
  for (const entry of data.summary) {
    const row = document.createElement("tr");
    for (const value of [entry.scene, entry.engine, entry.stepP50.toFixed(3), entry.tickP50.toFixed(3), entry.tickP95.toFixed(3)]) { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }
    body.append(row);
  }
  const sizeRows = document.querySelector("#sizes tbody")!; sizeRows.replaceChildren();
  for (const [name, size] of Object.entries(data.sizes)) {
    const row = document.createElement("tr");
    for (const value of [name, ...[size.raw, size.gzip, size.brotli].map(bytes => `${(bytes / 1024).toFixed(1)} KiB`)]) { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }
    sizeRows.append(row);
  }
}
document.querySelector<HTMLButtonElement>("#run")!.addEventListener("click", async event => {
  const button = event.target as HTMLButtonElement; button.disabled = true; running = false;
  current?.destroy(); current = undefined;
  try {
    const summary = [];
    for (const entry of SCENES) for (const name of ["rapier", "box3d"] as const) {
      status.textContent = `Measuring ${name} / ${entry.label}…`;
      const result = await api.run(name, entry.id);
      summary.push({ engine: name, scene: entry.id, tickP50: result.tick.p50, tickP95: result.tick.p95, stepP50: result.step.p50 });
    }
    const response = await fetch("sizes.json");
    renderResults({ summary, sizes: await response.json() });
    status.textContent = "Quick run complete. CLI results use six alternating-order repetitions and fresh pages.";
  } catch (error) { showError(error); }
  finally { button.disabled = false; }
});
// The automated runner uses this page without initializing WebGL or a live world.
if (!new URLSearchParams(location.search).has("bench")) void restart().catch(showError);
void showSavedResults().catch(showError);
