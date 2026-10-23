// From caddy/: node test-proxy.mjs. Requires Docker; uses isolated fixtures.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const docker = async (...args) => (await exec("docker", args, { maxBuffer: 1024 * 1024 })).stdout.trim();
const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-caddy-"));
const network = `threadsite-caddy-${randomUUID()}`;
const containers = [];
let createdNetwork = false;
try {
  await fs.mkdir(path.join(root, "sites/project"), { recursive: true });
  await fs.mkdir(path.join(root, "sites/ws"));
  await fs.mkdir(path.join(root, "vhosts"));
  await fs.writeFile(path.join(root, "sites/project/index.html"), "<h1>Published project</h1>");
  await fs.writeFile(path.join(root, "sites/project/main.js"), "console.log('published');");
  await fs.writeFile(path.join(root, "sites/project/threadsite-version.json"), '{"id":"fixture"}');
  await fs.writeFile(path.join(root, "sites/ws/index.html"), "<h1>A project named ws</h1>");
  await fs.writeFile(path.join(root, "sites/ws-extra"), "static path, not a relay endpoint");
  const template = await fs.readFile(new URL("./vhosts/games.caddy.example", import.meta.url), "utf8");
  await fs.writeFile(path.join(root, "vhosts/games.caddy"), template.replaceAll("games.example.com", ":8081"));
  await fs.writeFile(path.join(root, "relay.mjs"), `
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ privateRelay: true, path: req.url }));
});
server.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
  const message = Buffer.from(req.url);
  socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]));
  socket.on('data', (frame) => { if ((frame[0] & 15) === 8) socket.end(Buffer.from([0x88, 0])); });
});
server.listen(8090, '0.0.0.0');
`);
  await docker("network", "create", network);
  createdNetwork = true;
  containers.push(await docker("run", "-d", "--rm", "--network", network, "--network-alias", "gameserver",
    "--mount", `type=bind,source=${path.join(root, "relay.mjs")},target=/relay.mjs,readonly`,
    "node:24-bookworm-slim", "node", "/relay.mjs"));
  containers.push(await docker("run", "-d", "--rm", "--network", network,
    "-p", "127.0.0.1::8080", "-p", "127.0.0.1::8081", "-e", "SITES_DOMAIN=:8080",
    "--mount", `type=bind,source=${fileURLToPath(new URL("./Caddyfile", import.meta.url))},target=/etc/caddy/Caddyfile,readonly`,
    "--mount", `type=bind,source=${path.join(root, "vhosts")},target=/etc/caddy/vhosts,readonly`,
    "--mount", `type=bind,source=${path.join(root, "sites")},target=/srv/sites,readonly`,
    "caddy:2-alpine"));
  const caddy = containers.at(-1);
  const port = async (internal) => (await docker("port", caddy, `${internal}/tcp`)).split(":").at(-1);
  const site = `http://127.0.0.1:${await port(8080)}`;
  const games = `http://127.0.0.1:${await port(8081)}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { if ((await fetch(`${site}/project/`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`Caddy startup timed out: ${await docker("logs", caddy)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const html = await fetch(`${site}/project/index.html`);
  assert.equal(await html.text(), "<h1>Published project</h1>");
  assert.equal(html.headers.get("cache-control"), "no-cache");
  assert.equal((await fetch(`${site}/project/main.js?v=fixture`)).headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal((await fetch(`${site}/project/main.js`)).headers.get("cache-control"), "no-cache");
  assert.equal((await fetch(`${site}/project/threadsite-version.json`)).headers.get("cache-control"), "no-store");
  assert.equal(await (await fetch(`${site}/ws-extra`)).text(), "static path, not a relay endpoint");
  assert.equal(await (await fetch(`${site}/ws/`)).text(), "<h1>A project named ws</h1>");
  for (const origin of [site, games]) {
    for (const route of ["/health", "/stats", "/admin", "/ws/health"]) {
      assert.equal((await fetch(`${origin}${route}`)).status, 404, `${origin}${route} must not reach the private relay`);
    }
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(`${origin.replace("http:", "ws:")}/ws?probe=1`);
      const timer = setTimeout(() => { socket.close(); reject(new Error("WebSocket proxy timed out")); }, 5000);
      socket.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket proxy failed")); };
      socket.onmessage = (event) => {
        clearTimeout(timer);
        try { assert.equal(event.data, "/ws?probe=1"); socket.close(); resolve(); }
        catch (error) { socket.close(); reject(error); }
      };
    });
  }
  assert.equal((await fetch(`${games}/project/`)).status, 404, "a dedicated games host must not serve the project tree");
  console.log("PASS: shared and dedicated WebSockets, query forwarding, static paths, cache headers, and private relay routes.");
} finally {
  for (const container of containers.reverse()) await docker("rm", "-f", container).catch(() => {});
  if (createdNetwork) await docker("network", "rm", network);
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith("threadsite-caddy-"));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
