// Harness asset viewer for generated projects: every file under site/assets on
// one page — 2D images and SVG in a grid, audio players, and glTF/GLB models
// rendered with three.js (Draco and meshopt supported; KTX2 textures are not).
// Thumbnails render sequentially through one shared WebGL context; clicking a
// model opens an orbitable stage, clicking an image a lightbox.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

const main = document.getElementById("main");
const meta = document.getElementById("meta");

function bytesLabel(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function render(manifest) {
  const { files, truncated } = manifest;
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  meta.textContent = `${files.length} file${files.length === 1 ? "" : "s"} · ${bytesLabel(total)}${truncated ? " (list truncated)" : ""}`;
  main.innerHTML = "";
  if (!files.length) {
    main.innerHTML = '<p class="note">No assets under site/assets yet.</p>';
    return;
  }
  let modelsLeft = MAX_MODEL_THUMBNAILS;
  for (const [kind, title] of kindOrder) {
    const group = files.filter((file) => file.kind === kind);
    if (!group.length) continue;
    const section = document.createElement("section");
    const heading = document.createElement("h2");
    heading.textContent = `${title} (${group.length})`;
    const grid = document.createElement("div");
    grid.className = "grid";
    section.append(heading, grid);
    main.append(section);
    for (const file of group) grid.append(cardFor(file, kind, modelsLeft-- > 0));
  }
  if (truncated) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "Only the first 1,000 asset files are listed.";
    main.append(note);
  }
}

function cardFor(file, kind, renderThumb) {
  const card = document.createElement("div");
  card.className = "card";
  const frame = document.createElement("div");
  frame.className = kind === "image" ? "frame" : "frame plain";
  const label = document.createElement("div");
  label.className = "label";
  label.innerHTML = `<div class="path"></div><div class="size"></div>`;
  label.querySelector(".path").textContent = file.path;
  label.querySelector(".size").textContent = `${file.kind} · ${bytesLabel(file.bytes)}`;
  card.append(frame, label);
  const url = ASSET_ROOT + file.path;

  if (kind === "image") {
    const img = document.createElement("img");
    img.alt = file.path;
    img.loading = "lazy";
    img.src = url;
    img.addEventListener("error", () => noteError(card, "image failed to load"));
    img.addEventListener("click", () => openLightbox(url, file.path));
    frame.append(img);
  } else if (kind === "audio") {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = url;
    audio.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(audio.duration)) {
        label.querySelector(".size").textContent += ` · ${audio.duration.toFixed(2)}s`;
      }
    });
    audio.addEventListener("error", () => noteError(card, "audio failed to load"));
    frame.style.height = "56px";
    frame.append(audio);
  } else if (kind === "model") {
    if (renderThumb) queueModelThumbnail(card, frame, url);
    else noteError(card, "thumbnail skipped (too many models)");
    frame.addEventListener("click", () => openStage(url, file.path));
    frame.style.cursor = "zoom-in";
  } else {
    const mark = document.createElement("span");
    mark.className = "note";
    mark.textContent = kind;
    frame.append(mark);
  }
  return card;
}

function noteError(card, message) {
  const error = document.createElement("div");
  error.className = "error";
  error.textContent = message;
  card.append(error);
}

function openLightbox(url, title) {
  const lightbox = document.getElementById("lightbox");
  lightbox.querySelector("img").src = url;
  lightbox.classList.add("open");
}

// --- 3D thumbnails: one renderer, one scene at a time, sequential -----------

const thumbnailQueue = [];
let thumbnailsRunning = false;

function queueModelThumbnail(card, frame, url) {
  frame.textContent = "…";
  thumbnailQueue.push({ card, frame, url });
  if (!thumbnailsRunning) void runThumbnails();
}

let thumbRenderer;
function thumbnailCanvas() {
  thumbRenderer ??= new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  thumbRenderer.setSize(320, 256, false);
  return thumbRenderer;
}

async function runThumbnails() {
  thumbnailsRunning = true;
  const renderer = thumbnailCanvas();
  const scene = thumbnailScene();
  const camera = new THREE.PerspectiveCamera(40, 320 / 256, 0.01, 1000);
  try {
    while (thumbnailQueue.length) {
      const { card, frame, url } = thumbnailQueue.shift();
      const holder = new THREE.Group();
      scene.add(holder);
      try {
        const gltf = await loader.loadAsync(url);
        holder.add(gltf.scene);
        frameCamera(camera, holder);
        renderer.render(scene, camera);
        const img = document.createElement("img");
        img.src = renderer.domElement.toDataURL("image/png");
        img.alt = url;
        frame.textContent = "";
        frame.append(img);
      } catch (error) {
        frame.textContent = "";
        noteError(card, `3D preview failed: ${trimmedError(error)}`);
      } finally {
        scene.remove(holder);
        disposeTree(holder);
      }
    }
  } finally {
    thumbnailsRunning = false;
  }
}

function thumbnailScene() {
  thumbScene ??= (() => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#16191d");
    scene.add(new THREE.HemisphereLight(0xffffff, 0x30343a, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2, 3, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.7);
    fill.position.set(-2, 1, -2);
    scene.add(fill);
    return scene;
  })();
  return thumbScene;
}
let thumbScene;

function frameCamera(camera, object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const direction = new THREE.Vector3(1, 0.6, 1.4).normalize();
  camera.near = Math.max(0.01, sphere.radius / 100);
  camera.far = sphere.radius * 100;
  camera.position.copy(sphere.center).addScaledVector(direction, sphere.radius * 2.4);
  camera.lookAt(sphere.center);
  camera.updateProjectionMatrix();
}

function disposeTree(root) {
  root.traverse((node) => {
    node.geometry?.dispose?.();
    const material = node.material;
    if (Array.isArray(material)) material.forEach((item) => disposeMaterial(item));
    else if (material) disposeMaterial(material);
  });
}

function disposeMaterial(material) {
  for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
  material.dispose();
}

function trimmedError(error) {
  const message = String(error?.message || error);
  return message.length > 160 ? `${message.slice(0, 160)}…` : message;
}

// --- 3D stage: orbitable full-size view -------------------------------------

let stageState;

async function openStage(url, title) {
  const stage = document.getElementById("stage");
  stage.classList.add("open");
  stage.querySelector(".title").textContent = title;
  const holder = stage.querySelector(".holder");
  holder.textContent = "";
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(holder.clientWidth, holder.clientHeight, false);
  holder.append(renderer.domElement);
  const scene = thumbnailScene();
  const grid = new THREE.GridHelper(10, 20, 0x3a4149, 0x23272e);
  scene.add(grid);
  const camera = new THREE.PerspectiveCamera(40, holder.clientWidth / holder.clientHeight, 0.01, 2000);
  const pivot = new THREE.Group();
  scene.add(pivot);

  const state = { renderer, scene, camera, pivot, grid, radius: 3, theta: 0.9, phi: 1.1,
    target: new THREE.Vector3(), dragging: false, lastX: 0, lastY: 0, running: true, error: "" };
  const stopDrag = () => { state.dragging = false; };
  state.stopDrag = stopDrag;
  stageState = state;
  try {
    const gltf = await loader.loadAsync(url);
    if (stageState !== state) return;
    pivot.add(gltf.scene);
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    state.radius = Math.max(sphere.radius, 0.001) * 2.4;
    state.target.copy(sphere.center);
    grid.scale.setScalar(Math.max(sphere.radius, 0.001));
    grid.position.y = box.min.y;
  } catch (error) {
    if (stageState === state) state.error = `3D preview failed: ${trimmedError(error)}`;
  }
  const canvas = renderer.domElement;
  canvas.addEventListener("pointerdown", (event) => { state.dragging = true; state.lastX = event.clientX; state.lastY = event.clientY; });
  addEventListener("pointerup", stopDrag);
  canvas.addEventListener("pointermove", (event) => {
    if (!state.dragging) return;
    state.theta -= (event.clientX - state.lastX) * 0.008;
    state.phi = Math.min(Math.PI - 0.05, Math.max(0.05, state.phi - (event.clientY - state.lastY) * 0.008));
    state.lastX = event.clientX;
    state.lastY = event.clientY;
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    state.radius = Math.min(1000, Math.max(0.01, state.radius * (event.deltaY > 0 ? 1.1 : 0.9)));
  }, { passive: false });

  const tick = () => {
    if (stageState !== state) { disposeStage(state); return; }
    if (!state.dragging) state.theta += 0.003;
    camera.position.set(
      state.target.x + state.radius * Math.sin(state.phi) * Math.sin(state.theta),
      state.target.y + state.radius * Math.cos(state.phi),
      state.target.z + state.radius * Math.sin(state.phi) * Math.cos(state.theta));
    camera.lookAt(state.target);
    renderer.render(scene, camera);
    if (state.error && !canvas.dataset.error) {
      canvas.dataset.error = "1";
      const error = document.createElement("div");
      error.className = "error";
      error.style.padding = "12px";
      error.textContent = state.error;
      holder.prepend(error);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function disposeStage(state) {
  // The pivot and grid ride the shared thumbnail scene; both must come off it,
  // or every later stage and thumbnail render stacks the closed model on top.
  state.scene.remove(state.pivot);
  state.scene.remove(state.grid);
  removeEventListener("pointerup", state.stopDrag);
  disposeTree(state.pivot);
  state.renderer.dispose();
}

for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => {
    document.getElementById(button.dataset.close).classList.remove("open");
    // Closing the lightbox must not tear down an open 3D stage.
    if (button.dataset.close === "stage") stageState = undefined;
  });
}
addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const id of ["lightbox", "stage"]) document.getElementById(id).classList.remove("open");
  stageState = undefined;
});

// Bootstrap last: top-level await suspends the module, so everything above
// must already be initialized when the manifest arrives and render() runs.
const ASSET_ROOT = "../assets/";
const MAX_MODEL_THUMBNAILS = 60;

const draco = new DRACOLoader().setDecoderPath("/__viewer/draco/");
const loader = new GLTFLoader().setDRACOLoader(draco);
loader.setMeshoptDecoder(MeshoptDecoder);

const kindOrder = [
  ["image", "Images"], ["model", "3D models"], ["audio", "Audio"],
  ["font", "Fonts"], ["video", "Video"], ["data", "Data"], ["other", "Other"],
];

let manifest;
try {
  manifest = await (await fetch("manifest.json")).json();
} catch (error) {
  main.innerHTML = `<p class="note">Could not load the asset manifest: ${error}</p>`;
}
if (manifest) {
  document.title = `${manifest.project} · assets`;
  render(manifest);
}
