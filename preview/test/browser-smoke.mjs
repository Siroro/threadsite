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
  const blocked = await call("browser_evaluate", { function: "async () => { try { await fetch('https://example.com'); return 'escaped'; } catch { return 'blocked'; } }" });
  assert.match(text(blocked), /blocked/);
  await assert.rejects(fs.stat(path.join(site, "js")), { code: "ENOENT" });
  await call("browser_close");
  await call("browser_close", {}, second);
  console.log("PASS: inline images, WebGL, canvas interaction, keyboard, diagnostics, mobile, isolation, fresh builds and blocked external fetch.");
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
