import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPreviewServer } from "./server.mjs";

// The only ThreadSite-specific code is the static TypeScript preview server.
// Microsoft Playwright MCP owns browser sessions, interactions and image results.
const server = createPreviewServer({
  workspaceRoot: process.env.WORKSPACE_ROOT || "/workspace",
});
await new Promise((resolve) => server.listen(8080, "127.0.0.1", resolve));
const child = spawn(
  process.execPath,
  [
    fileURLToPath(new URL("./cli.js", import.meta.resolve("@playwright/mcp"))),
    "--config",
    fileURLToPath(new URL("./browser-config.json", import.meta.url)),
    "--port",
    "8931",
    "--host",
    "0.0.0.0",
    "--allowed-hosts",
    "preview:8931,localhost:8931,127.0.0.1:8931",
  ],
  { stdio: "inherit", cwd: "/tmp" },
);

for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
child.on("exit", (code) => {
  server.close();
  process.exit(code ?? 1);
});

// --- Browser warm-up -------------------------------------------------------
// There is no GPU here, so Chromium runs on SwiftShader and starting it is the
// most expensive single step of a browser turn. The MCP server launches the
// browser lazily on the first client session, which means that cost lands on
// whichever client navigates first: the agent's first playwright_browser_navigate
// or the harness QA pass, both of which run under a timeout.
//
// `isolated: true` means every client still gets its own fresh context (so
// storage isolation is unchanged) while all of them share one browser process,
// and that process lives as long as any session is connected. So one session
// opened here at boot leaves a launched browser for every later session to
// reuse. `timeouts.idle: 0` in browser-config.json stops Playwright from closing
// it again after an hour without tool calls, which would bring the cold start
// back. The probe page forces a WebGL context and a pixel read, because that is
// what actually initialises SwiftShader — a browser process alone does not.
const MCP_URL = "http://127.0.0.1:8931/mcp";
const WARMUP_PAGE =
  "data:text/html," +
  encodeURIComponent(
    "<canvas id=w></canvas><script>" +
      'const g=document.getElementById("w").getContext("webgl2");' +
      "if(g){g.clearColor(0,1,0,1);g.clear(g.COLOR_BUFFER_BIT);" +
      "g.readPixels(0,0,1,1,g.RGBA,g.UNSIGNED_BYTE,new Uint8Array(4));}" +
      "</script>",
  );

function waitForPort(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline)
          reject(new Error(`Playwright MCP did not listen on ${host}:${port}`));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

async function rpc(body, sessionId) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let json;
  try {
    if (
      (response.headers.get("content-type") || "").includes("text/event-stream")
    ) {
      const last = text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .at(-1);
      json = last ? JSON.parse(last.slice(5).trim()) : undefined;
    } else if (text) {
      json = JSON.parse(text);
    }
  } catch {
    json = undefined;
  }
  return {
    status: response.status,
    json,
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
  };
}

async function warmBrowser() {
  await waitForPort(8931, "127.0.0.1", 60_000);
  const init = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "threadsite-warmup", version: "1.0.0" },
    },
  });
  if (init.status >= 400 || init.json?.error || !init.sessionId) {
    throw new Error(`initialize failed (HTTP ${init.status})`);
  }
  await rpc(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    init.sessionId,
  );
  const navigated = await rpc(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: WARMUP_PAGE } },
    },
    init.sessionId,
  );
  if (navigated.json?.result?.isError) {
    throw new Error(
      `warm-up navigation failed: ${JSON.stringify(navigated.json.result).slice(0, 300)}`,
    );
  }
  // Deliberately no browser_close and no session DELETE: this open session is
  // what keeps the shared browser process alive for the sessions that follow.
  console.log("preview: browser warmed (Chromium + SwiftShader ready)");
}

// Warm-up is best-effort: a failure must never stop the service from serving.
warmBrowser().catch((error) =>
  console.error(`preview: browser warm-up skipped: ${error.message}`),
);
