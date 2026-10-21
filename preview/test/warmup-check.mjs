// Opt-in browser warm-up check, in the style of browser-smoke.mjs.
//
//   docker build -t threadsite-preview-test:local ./preview
//   npm --prefix preview run test:warmup
//
// There is no GPU, so Chromium runs on SwiftShader and launching it is the most
// expensive step of a browser turn. start.mjs opens one MCP session at boot so
// the shared browser is already up when the agent's first navigation or the
// harness QA pass arrives. This verifies that the browser really is running
// before any client connects, that it survives those clients disconnecting, and
// that per-client storage isolation is unaffected.
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
const docker = async (...args) =>
  (await exec("docker", args, { maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Count Chromium processes inside the container. /proc is readable without
// extra tooling, and the count is a direct signal that the browser is up.
const CHROME_COUNT =
  "const fs=require('fs');let n=0;" +
  "for(const d of fs.readdirSync('/proc')){if(!/^\\d+$/.test(d))continue;" +
  "try{if(/chrom/i.test(fs.readFileSync('/proc/'+d+'/comm','utf8')))n++;}catch{}}console.log(n)";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-warmup-"));
const site = path.join(root, "100", "200", "site");
const clients = [];
let container;
try {
  await fs.mkdir(site, { recursive: true });
  await fs.writeFile(
    path.join(site, "index.html"),
    `<!doctype html><html><head><title>Warm-up check</title>
    <style>body{margin:0;background:#14213d;color:#fff;font:24px sans-serif}</style></head>
    <body><h1>Warm-up check</h1><canvas id="c" width="1440" height="900"></canvas>
    <script>const g=document.getElementById('c').getContext('webgl2');
    if(g){g.clearColor(0.2,0.7,0.9,1);g.clear(g.COLOR_BUFFER_BIT);}</script></body></html>`,
  );

  // Same limits as docker-compose.yml so the timings are representative.
  container = await docker(
    "run",
    "-d",
    "--rm",
    "--init",
    "--read-only",
    "--tmpfs",
    "/tmp:size=512m,mode=1777",
    "--shm-size",
    "512m",
    "--cpus",
    "4",
    "--memory",
    "3g",
    "--security-opt",
    "no-new-privileges:true",
    "--cap-drop",
    "ALL",
    "-p",
    "127.0.0.1::8931",
    "--mount",
    `type=bind,source=${root},target=/workspace,readonly`,
    "-e",
    "XDG_CACHE_HOME=/tmp/cache",
    "-e",
    "XDG_CONFIG_HOME=/tmp/config",
    process.env.PREVIEW_TEST_IMAGE || "threadsite-preview-test:local",
  );
  const port = (await docker("port", container, "8931/tcp")).split(":").at(-1);
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  // Node fetch ignores a custom Host header; the MCP host allowlist is real, so
  // use native HTTP for this port-mapped test instead of weakening the allowlist.
  const mcpFetch = (input, init = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        input,
        {
          method: init.method,
          signal: init.signal,
          headers: {
            ...Object.fromEntries(new Headers(init.headers)),
            host: "preview:8931",
          },
        },
        (response) =>
          resolve(
            new Response(
              [204, 304].includes(response.statusCode)
                ? null
                : Readable.toWeb(response),
              { status: response.statusCode, headers: response.headers },
            ),
          ),
      );
      req.on("error", reject);
      req.end(init.body);
    });
  async function client() {
    const instance = new Client({
      name: `warmup-${randomUUID()}`,
      version: "1",
    });
    await instance.connect(
      new StreamableHTTPClientTransport(url, { fetch: mcpFetch }),
    );
    clients.push(instance);
    return instance;
  }
  const call = async (name, args, instance) => {
    const result = await instance.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
    return result;
  };
  const text = (result) =>
    result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  const chromeCount = () =>
    docker("exec", container, "node", "-e", CHROME_COUNT).then(Number);

  // The MCP port opens before Chromium has launched, so poll for the warm-up's
  // own completion line rather than sampling the log once.
  for (let attempt = 0; ; attempt++) {
    try {
      await fetch(url);
      break;
    } catch (error) {
      if (attempt > 160) throw error;
      await sleep(250);
    }
  }
  let logs = "";
  for (let attempt = 0; attempt < 240; attempt++) {
    logs = await docker("logs", container);
    if (/browser warmed|warm-up skipped/.test(logs)) break;
    await sleep(250);
  }
  assert.match(
    logs,
    /browser warmed/,
    `warm-up did not report success:\n${logs}`,
  );

  // The whole point: a browser is already running before any client connects.
  const before = await chromeCount();
  assert.ok(
    before >= 1,
    `warm-up reported success but no Chromium process is running (${before})`,
  );

  const first = await client();
  const firstStarted = Date.now();
  await call(
    "browser_navigate",
    { url: "http://127.0.0.1:8080/100/200/" },
    first,
  );
  const firstMs = Date.now() - firstStarted;
  assert.match(
    text(await call("browser_snapshot", {}, first)),
    /Warm-up check/,
  );
  assert.match(
    text(
      await call(
        "browser_evaluate",
        {
          function:
            "() => !!document.querySelector('canvas').getContext('webgl2')",
        },
        first,
      ),
    ),
    /true/,
  );
  await call(
    "browser_evaluate",
    { function: "() => localStorage.setItem('isolation', 'first')" },
    first,
  );
  await first.close();

  // Disconnecting the only other client must not tear the warm browser down.
  const afterClose = await chromeCount();
  assert.ok(
    afterClose >= 1,
    `the warmed browser was closed when a client disconnected (${afterClose})`,
  );

  const second = await client();
  const secondStarted = Date.now();
  await call(
    "browser_navigate",
    { url: "http://127.0.0.1:8080/100/200/" },
    second,
  );
  const secondMs = Date.now() - secondStarted;
  // Isolation is unchanged: the second client gets a fresh context.
  assert.match(
    text(
      await call(
        "browser_evaluate",
        { function: "() => localStorage.getItem('isolation')" },
        second,
      ),
    ),
    /null/,
  );
  assert.ok((await chromeCount()) >= 1);

  console.log(
    `PASS: browser warm before first client (${before} Chromium processes), ` +
      `survives client disconnect, per-client contexts still isolated. ` +
      `First navigation ${firstMs}ms, second ${secondMs}ms.`,
  );
} catch (error) {
  if (container) console.error(await docker("logs", container).catch(() => ""));
  throw error;
} finally {
  await Promise.allSettled(clients.map((instance) => instance.close()));
  if (container) await docker("rm", "-f", container).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
