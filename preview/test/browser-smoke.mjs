// Build first: docker build -t threadsite-preview-test:local ./preview
// Then: npm --prefix preview run test:browser
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const exec = promisify(execFile);
const docker = async (...args) => (await exec("docker", args, { maxBuffer: 1024 * 1024 })).stdout.trim();
const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-browser-"));
const site = path.join(root, "100", "200", "site");
const clients = [];
const network = `threadsite-preview-test-${randomUUID()}`;
let container;
let imagePath;
try {
  await fs.mkdir(path.join(site, "src"), { recursive: true });
  await fs.writeFile(path.join(site, "index.html"), `<!doctype html><html><head><title>Preview fixture</title>
    <meta name="viewport" content="width=device-width,initial-scale=1"><style>
    body{margin:20px;background:#14213d;color:#fff;font:20px sans-serif}button{display:block;width:180px;height:50px;margin:20px 0}
    canvas{display:block;border:1px solid white}#gpu{width:100px;height:60px}</style></head>
    <body><h1>Current TypeScript preview</h1><button id="start">Start game</button><p id="state">Waiting</p>
    <canvas width="400" height="200" id="game"></canvas><canvas width="100" height="60" id="gpu"></canvas>
    <script type="module" src="js/main.js"></script></body></html>`);
  const source = (label) => `const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle='#fca311';ctx.fillRect(20,20,80,80);
    ctx.fillStyle='white';ctx.font='20px sans-serif';ctx.fillText('${label}',120,70);
    document.querySelector('#start')!.addEventListener('click',()=>{document.querySelector('#state')!.textContent='Playing';ctx.fillStyle='#40c970';ctx.fillRect(20,20,80,80)});
    window.addEventListener('keydown',e=>{document.querySelector('#state')!.textContent='Key: '+e.key});
    const gl = document.querySelector<HTMLCanvasElement>('#gpu')!.getContext('webgl2');
    (window as any).webglReady=!!gl;if(gl){gl.clearColor(0.2,0.7,0.9,1);gl.clear(gl.COLOR_BUFFER_BIT)};
    console.error('fixture runtime diagnostic');`;
  await fs.writeFile(path.join(site, "src", "main.ts"), source("first frame"));
  await docker("network", "create", network);
  container = await docker("run", "-d", "--rm", "--init", "--read-only", "--network", network, "--network-alias", "preview",
    "--tmpfs", "/tmp:size=512m,mode=1777", "--shm-size", "256m",
    "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL",
    "-p", "127.0.0.1::8931", "--mount", `type=bind,source=${root},target=/workspace,readonly`,
    "-e", "XDG_CACHE_HOME=/tmp/cache", "-e", "XDG_CONFIG_HOME=/tmp/config",
    process.env.PREVIEW_TEST_IMAGE || "threadsite-preview-test:local");
  const port = (await docker("port", container, "8931/tcp")).split(":").at(-1);
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  // Node fetch ignores a custom Host header. Use native HTTP for this port-
  // mapped test so the real MCP host allowlist is exercised without weakening it.
  const mcpFetch = (input, init = {}) => new Promise((resolve, reject) => {
    const req = http.request(input, {
      method: init.method, signal: init.signal,
      headers: { ...Object.fromEntries(new Headers(init.headers)), host: "preview:8931" },
    }, (response) => resolve(new Response(
      [204, 304].includes(response.statusCode) ? null : Readable.toWeb(response),
      { status: response.statusCode, headers: response.headers },
    )));
    req.on("error", reject);
    req.end(init.body);
  });
  // Wait for startup, without consuming an MCP session.
  for (let attempt = 0; ; attempt++) {
    try { await fetch(url); break; } catch (error) {
      if (attempt > 80) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  async function client() {
    const instance = new Client({ name: "threadsite-smoke", version: "1" });
    await instance.connect(new StreamableHTTPClientTransport(url, {
      fetch: mcpFetch,
    }));
    clients.push(instance);
    return instance;
  }
  const first = await client();
  const call = async (name, args = {}, instance = first) => {
    const result = await instance.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
    return result;
  };
  const text = (result) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const tools = (await first.listTools()).tools.map((tool) => tool.name);
  assert.ok(tools.includes("browser_take_screenshot"));
  assert.ok(tools.includes("browser_mouse_click_xy"));
  await call("browser_navigate", { url: "http://127.0.0.1:8080/100/200/" });
  assert.match(text(await call("browser_snapshot")), /Current TypeScript preview/);
  const shot = await call("browser_take_screenshot");
  const picture = shot.content.find((part) => part.type === "image");
  assert.ok(picture, "Screenshot must return an actual inline MCP image");
  assert.ok(Buffer.from(picture.data, "base64").length > 1000);
  const artifactRoot = path.resolve("../.zcode/preview-test");
  await fs.mkdir(artifactRoot, { recursive: true });
  imagePath = path.join(artifactRoot, "desktop.png");
  await fs.writeFile(imagePath, Buffer.from(picture.data, "base64"));
  assert.match(text(await call("browser_evaluate", { function: "() => window.webglReady" })), /true/);
  await call("browser_mouse_click_xy", { x: 100, y: 120 });
  assert.match(text(await call("browser_snapshot")), /Playing/);
  await call("browser_press_key", { key: "ArrowRight" });
  assert.match(text(await call("browser_snapshot")), /Key: ArrowRight/);
  assert.match(text(await call("browser_console_messages", { level: "error" })), /fixture runtime diagnostic/);
  await call("browser_resize", { width: 390, height: 844 });
  assert.match(text(await call("browser_evaluate", { function: "() => innerWidth" })), /390/);
  assert.ok((await call("browser_take_screenshot")).content.some((part) => part.type === "image"));
  await call("browser_evaluate", { function: "() => localStorage.setItem('isolation', 'first')" });
  const second = await client();
  await call("browser_navigate", { url: "http://127.0.0.1:8080/100/200/" }, second);
  assert.match(text(await call("browser_evaluate", { function: "() => localStorage.getItem('isolation')" }, second)), /null/);
  await fs.writeFile(path.join(site, "src", "main.ts"), source("rebuilt frame").replace("first frame", "rebuilt frame") + "document.title='Rebuilt preview';");
  await call("browser_navigate", { url: "http://127.0.0.1:8080/100/200/" });
  assert.match(text(await call("browser_evaluate", { function: "() => document.title" })), /Rebuilt preview/);
  // A scratch view uses real production components and the seeded engine,
  // even while an unrelated entry in the game's scene graph cannot compile.
  const workspace = path.dirname(site);
  await fs.cp(new URL("../../bot/node_modules/three/", import.meta.url), path.join(workspace, "node_modules", "three"), { recursive: true });
  await fs.mkdir(path.join(site, "src", "components"));
  await fs.writeFile(path.join(site, "src", "components", "car.ts"), `import * as THREE from "three";
    export function createCar() {
      const car = new THREE.Group();
      const paint = new THREE.MeshStandardMaterial({color:0xfca311,roughness:0.35});
      const body = new THREE.Mesh(new THREE.BoxGeometry(3,0.65,1.4),paint); body.position.y=0.65; car.add(body);
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.4,0.6,1.2),new THREE.MeshStandardMaterial({color:0x29435a}));
      cabin.position.set(-0.2,1.25,0); car.add(cabin);
      for(const x of [-1,1]) for(const z of [-0.75,0.75]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.35,0.35,0.2,20),new THREE.MeshStandardMaterial({color:0x151515}));
        wheel.rotation.x=Math.PI/2; wheel.position.set(x,0.35,z); car.add(wheel);
      } return car;
    }`);
  await fs.mkdir(path.join(site, "data"));
  await fs.writeFile(path.join(site, "data", "scratch.json"), '{"label":"shared local data"}');
  const scratch = path.join(workspace, "scratch", "car");
  await fs.mkdir(path.join(scratch, "src"), { recursive: true });
  await fs.writeFile(path.join(scratch, "index.html"), `<!doctype html><html><head><title>Scratch car</title></head>
    <body style="background:#14213d;color:white;font:20px sans-serif"><h1>Isolated production car</h1>
    <button id="rotate">Rotate car</button><div id="car"></div><p id="data">Loading</p>
    <script type="module" src="js/main.js"></script></body></html>`);
  await fs.writeFile(path.join(scratch, "src", "main.ts"), `import * as THREE from "three";
    import { createCar } from "../../../site/src/components/car.js";
    const scene=new THREE.Scene();scene.background=new THREE.Color(0x1d3045);
    const camera=new THREE.PerspectiveCamera(40,512/320,0.1,100);camera.position.set(5,3.5,5);camera.lookAt(0,0.6,0);
    const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setSize(512,320);document.querySelector('#car')!.appendChild(renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xffffff,0x446644,2));const sun=new THREE.DirectionalLight(0xffffff,3);sun.position.set(3,5,2);scene.add(sun);
    const car=createCar();scene.add(car);renderer.render(scene,camera);(window as any).scratchReady=car.children.length;
    document.querySelector('#rotate')!.addEventListener('click',()=>{car.rotation.y+=0.6;renderer.render(scene,camera);(window as any).rotated=true;});
    fetch('__site/data/scratch.json').then(r=>r.json()).then(data=>document.querySelector('#data')!.textContent=data.label);`);
  await fs.writeFile(path.join(site, "src", "main.ts"), 'import "./missing-scene.ts";');
  await call("browser_resize", { width: 900, height: 650 });
  await call("browser_navigate", { url: "http://127.0.0.1:8080/100/200/__scratch/car/" });
  assert.match(text(await call("browser_snapshot")), /Isolated production car/);
  assert.match(text(await call("browser_evaluate", { function: "() => window.scratchReady" })), /6/);
  assert.match(text(await call("browser_evaluate", { function: "async () => (await (await fetch('__site/data/scratch.json')).json()).label" })), /shared local data/);
  const scratchShot = await call("browser_take_screenshot");
  const scratchPicture = scratchShot.content.find((part) => part.type === "image");
  assert.ok(scratchPicture, "Scratch rendering must return an inline image");
  await fs.writeFile(path.join(artifactRoot, "scratch-car.png"), Buffer.from(scratchPicture.data, "base64"));
  await call("browser_evaluate", { function: "() => document.querySelector('#rotate').click()" });
  assert.match(text(await call("browser_evaluate", { function: "() => window.rotated" })), /true/);
  await assert.rejects(fs.stat(path.join(scratch, "js")), { code: "ENOENT" });
  await fs.writeFile(path.join(scratch, "src", "main.ts"), 'document.title="Rebuilt scratch";');
  await call("browser_navigate", { url: "http://127.0.0.1:8080/100/200/__scratch/car/" });
  assert.match(text(await call("browser_evaluate", { function: "() => document.title" })), /Rebuilt scratch/);

  // --- Harness asset viewer: 2D, audio and a real GLB render through SwiftShader.
  const assets = path.join(site, "assets");
  await fs.mkdir(path.join(assets, "sprites"), { recursive: true });
  await fs.writeFile(path.join(assets, "sprites", "hero.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  await fs.writeFile(path.join(assets, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#fca311"/></svg>');
  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
  const gltf = JSON.stringify({
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.95, 0.35, 0.1, 1] } }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-1, -1, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 }],
    buffers: [{ byteLength: positions.byteLength }],
  });
  const jsonPad = " ".repeat((4 - (gltf.length % 4)) % 4);
  const binPad = (4 - (positions.byteLength % 4)) % 4;
  const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
  const glb = Buffer.concat([
    u32(0x46546c67), u32(2), u32(12 + 8 + gltf.length + jsonPad.length + 8 + positions.byteLength + binPad),
    u32(gltf.length + jsonPad.length), u32(0x4e4f534a), Buffer.from(gltf + jsonPad),
    u32(positions.byteLength + binPad), u32(0x004e4942), Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength), Buffer.alloc(binPad),
  ]);
  await fs.mkdir(path.join(assets, "models"), { recursive: true });
  await fs.writeFile(path.join(assets, "models", "tri.glb"), glb);
  await call("browser_navigate", { url: "http://127.0.0.1:8080/100/200/__assets/" });
  assert.match(text(await call("browser_snapshot")), /ThreadSite asset viewer/);
  const manifestFiles = text(await call("browser_evaluate", { function: "async () => (await (await fetch('manifest.json')).json()).files.map((file) => file.path).join(',')" }));
  assert.match(manifestFiles, /sprites\/hero\.png/);
  assert.match(manifestFiles, /models\/tri\.glb/);
  assert.match(manifestFiles, /logo\.svg/);
  // Images and the GLB thumbnail all land as rendered <img> elements.
  const thumbText = text(await call("browser_evaluate", { function:
    "async () => { for (let i = 0; i < 150; i++) { if (document.querySelectorAll('.frame img').length >= 3) break; await new Promise((resolve) => setTimeout(resolve, 100)); } return document.querySelectorAll('.frame img').length; }" }));
  const thumbs = Number(thumbText.match(/### Result\s*\n\s*(\d+)/)?.[1] ?? 0);
  assert.ok(thumbs >= 3, `expected at least 3 rendered previews, got ${thumbs}`);
  const errorCards = Number(text(await call("browser_evaluate", { function: "() => document.querySelectorAll('.card .error').length" }))
    .match(/### Result\s*\n\s*(\d+)/)?.[1] ?? 1);
  assert.equal(errorCards, 0, "no asset card may report a load/render failure");
  assert.doesNotMatch(text(await call("browser_console_messages", { level: "error" })), /Uncaught/);
  const viewerShot = await call("browser_take_screenshot");
  const viewerPicture = viewerShot.content.find((part) => part.type === "image");
  assert.ok(viewerPicture, "the viewer must screenshot");
  await fs.writeFile(path.join(artifactRoot, "assets-viewer.png"), Buffer.from(viewerPicture.data, "base64"));

  const blocked = await call("browser_evaluate", { function: "async () => { try { await fetch('https://example.com'); return 'escaped'; } catch { return 'blocked'; } }" });
  assert.match(text(blocked), /blocked/);
  await assert.rejects(fs.stat(path.join(site, "js")), { code: "ENOENT" });
  await call("browser_close");
  await call("browser_close", {}, second);
  console.log("PASS: inline images, WebGL, canvas interaction, keyboard, diagnostics, mobile, isolation, fresh builds, independent scratch component rendering, the asset viewer (2D + GLB) and blocked external fetch.");
  if (process.env.PREVIEW_TEST_OPENCODE_IMAGE) {
    const { checkOpenCodeImageDelivery } = await import("./opencode-wire.mjs");
    await checkOpenCodeImageDelivery({ docker, network, root });
  }
  console.log(`Screenshot: ${imagePath}`);
} catch (error) {
  if (container) console.error(await docker("logs", container));
  throw error;
} finally {
  await Promise.allSettled(clients.map((instance) => instance.close()));
  if (container) await docker("rm", "-f", container).catch(() => {});
  await docker("network", "rm", network).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
