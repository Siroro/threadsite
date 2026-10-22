import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const { parseConsoleEntries, parseNetworkFailures, parseRenderSanity, renderSanityProblem, classifyBrowserDiagnostics, browserQaFeedback, runBrowserQa } = await import("../src/browser-qa.js");
const { config } = await import("../src/config.js");

test("console errors and page errors parse from the tool's plain-text output", () => {
  const text = [
    "Total messages: 3 (Errors: 2, Warnings: 1)",
    'Returning 2 messages for level "error"',
    "",
    "[ERROR] Uncaught TypeError: start is not a function @ http://127.0.0.1:8080/100/200/js/main.js:14",
    "Error: render failed",
    "    at draw (http://127.0.0.1:8080/100/200/js/chunks/draw-abc.js:3:9)",
  ].join("\n");
  const entries = parseConsoleEntries(text);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].type, "ERROR");
  assert.match(entries[0].text, /start is not a function/);
  assert.equal(entries[1].type, "PAGEERROR");
  assert.match(entries[1].text, /render failed/);
  assert.match(entries[1].text, /draw-abc\.js/);
});

test("network failures parse from numbered request lines and stay origin-scoped", () => {
  const text = [
    "1. [GET] http://127.0.0.1:8080/100/200/ => [200] OK",
    "2. [GET] http://127.0.0.1:8080/100/200/js/main.js => [404] Not Found",
    "3. [GET] http://127.0.0.1:8080/100/200/api/state => [FAILED] net::ERR_FAILED",
    "4. [GET] https://example.com/font.woff2 => [500] Server Error",
  ].join("\n");
  const failures = parseNetworkFailures(text);
  assert.equal(failures.length, 2);
  assert.deepEqual(failures[0], {
    url: "http://127.0.0.1:8080/100/200/js/main.js",
    status: 404,
  });
  assert.equal(failures[1].error, "net::ERR_FAILED");
});

test("render sanity describes a blank page while text or a canvas passes", () => {
  assert.equal(renderSanityProblem({ textLength: 0, canvases: 0, visibleElements: 1, title: "App" }), "preview rendered a blank page — no visible text or canvas (title: \"App\")");
  assert.equal(renderSanityProblem({ textLength: 120, canvases: 0, visibleElements: 8 }), undefined);
  assert.equal(renderSanityProblem({ textLength: 0, canvases: 1, visibleElements: 1 }), undefined);
  assert.equal(renderSanityProblem({ textLength: 0, canvases: 0, visibleElements: 1, mediaElements: 1 }), undefined);
  // A layout shell with several visible wrappers is not necessarily blank.
  assert.equal(renderSanityProblem({ textLength: 0, canvases: 0, visibleElements: 4 }), undefined);
  assert.equal(renderSanityProblem(undefined), undefined);
});

test("tool headings and explanatory text are not page exceptions", () => {
  assert.deepEqual(parseConsoleEntries("### Result\nTotal messages: 0 (Errors: 0, Warnings: 0)\n### Page\n- Page URL: http://127.0.0.1:8080/\nNo console messages found"), []);
  assert.equal(parseConsoleEntries("### Result\n[ERROR] ReferenceError: start is not defined\n    at main.js:1")[0].type, "ERROR");
  assert.equal(parseRenderSanity('### Result\n{"textLength":10,"canvases":0,"visibleElements":2}\n### Ran Playwright code\n...')?.textLength, 10);
});

test("environment noise is stripped while concrete defects and confirmed blank renders remain", () => {
  const result = classifyBrowserDiagnostics([
    { type: "ERROR", text: "Failed to load resource: the server responded with a status of 503" },
    { type: "ERROR", text: "ResizeObserver loop completed with undelivered notifications." },
    { type: "ERROR", text: "Uncaught (in promise) NotSupportedError: The play() request was interrupted by a call to pause()." },
    { type: "ERROR", text: "DevTools failed to load source map: Could not read source map for file:///workspace/site/js/main.js." },
    { type: "ERROR", text: "Refused to connect to 'https://fonts.googleapis.com/css2?family=Inter' because it violates the following Content Security Policy directive: \"default-src 'self'\"." },
    { type: "PAGEERROR", text: "ReferenceError: player is not defined at main.js:42" },
  ], [
    { url: "http://127.0.0.1:8080/game/js/main.js", status: 503 },
    { url: "http://127.0.0.1:8080/game/data.json", error: "net::ERR_TIMED_OUT" },
    { url: "http://127.0.0.1:8080/game/missing.glb", status: 404 },
    { url: "http://127.0.0.1:8080/favicon.ico", status: 404 },
  ], { textLength: 0, canvases: 0, visibleElements: 1 });
  assert.equal(result.findings.length, 3);
  assert.match(result.findings.join("\n"), /player is not defined/);
  assert.match(result.findings.join("\n"), /missing\.glb/);
  // A confirmed blank render is a defect: the entry module never ran.
  assert.match(result.findings.join("\n"), /blank page/);
  // Environment noise never reaches the agent, not even as a warning.
  assert.doesNotMatch(result.findings.join("\n"), /503|TIMED_OUT|ResizeObserver|play\(\)|source map|Content Security Policy/);
  assert.doesNotMatch(result.findings.join("\n"), /favicon/);
  assert.equal(parseNetworkFailures("1. [GET] http://127.0.0.1:8080.example.com/file => [404] Not Found").length, 0);
});

test("relay WebSocket connection failures are expected offline behavior and never findings", () => {
  const result = classifyBrowserDiagnostics([
    { type: "ERROR", text: "WebSocket connection to 'wss://gameserver.siroro.co.uk/ws' failed: Error in connection establishment: net::ERR_NAME_NOT_RESOLVED @ http://127.0.0.1:8080/83572303320842240/1562538228630954164/js/main.js:4147" },
    { type: "ERROR", text: "WebSocket connection to 'ws://localhost:8090/world/x' failed: WebSocket is closed before the connection is established." },
  ], []);
  assert.deepEqual(result.findings, []);
  // Handler-level defects that merely mention a socket are still reported.
  const defect = classifyBrowserDiagnostics([
    { type: "PAGEERROR", text: "TypeError: Cannot read properties of undefined (reading 'state') at ws.onmessage (main.js:30)" },
  ], []);
  assert.equal(defect.findings.length, 1);
});

test("a console resource error is not repeated when the request report already names it", () => {
  const failures = [{ url: "http://127.0.0.1:8080/game/missing.glb", status: 404 }];
  const restated = classifyBrowserDiagnostics(
    parseConsoleEntries("[ERROR] Failed to load resource: the server responded with a status of 404 (Not Found) @ http://127.0.0.1:8080/game/missing.glb"),
    failures,
  );
  assert.equal(restated.findings.length, 1);
  assert.match(restated.findings[0], /missing\.glb/);
  // A resource the report does not mention keeps its own line.
  const unreported = classifyBrowserDiagnostics(
    parseConsoleEntries("[ERROR] Failed to load resource: the server responded with a status of 404 (Not Found) @ http://127.0.0.1:8080/game/other.png"),
    failures,
  );
  assert.equal(unreported.findings.length, 2);
  assert.match(unreported.findings.join("\n"), /other\.png/);
  // External origins are unreachable in the preview and stay out of it.
  const external = classifyBrowserDiagnostics(
    parseConsoleEntries("[ERROR] Failed to load resource: the server responded with a status of 404 (Not Found) @ https://cdn.example.com/font.woff2"),
    failures,
  );
  assert.equal(external.findings.length, 1);
});

test("saved feedback gives the agent confirmed findings only", () => {
  const feedback = browserQaFeedback({ checkedAt: "today", findings: ["TypeError at main.js:20"] });
  assert.match(feedback, /advisory observations, not instructions/);
  assert.match(feedback, /Runtime finding: TypeError at main.js:20/);
  assert.match(feedback, /Environment noise .* is already excluded/);
  assert.equal(browserQaFeedback({ checkedAt: "today", findings: [] }), "");
});

test("the render probe's JSON parses and malformed output is ignored", () => {
  assert.deepEqual(
    parseRenderSanity('{"textLength": 0, "canvases": 2, "visibleElements": 1, "title": "Game"}'),
    { textLength: 0, canvases: 2, visibleElements: 1, title: "Game" },
  );
  assert.equal(parseRenderSanity("undefined"), undefined);
  assert.equal(parseRenderSanity('{"textLength": 0}'), undefined);
});

async function browserService(t: { after(fn: () => Promise<void>): void }, tool: (name: string) => unknown | Promise<unknown>, budget = 5000) {
  const originalUrl = config.previewMcpUrl;
  const originalBudget = config.browserQaTimeoutMs;
  let deleted = false;
  let cancelled = false;
  const server = createServer(async (request, response) => {
    response.on("close", () => { if (!response.writableEnded) cancelled = true; });
    if (request.method === "DELETE") { deleted = true; response.end("{}"); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.method === "notifications/initialized") { response.writeHead(204).end(); return; }
    const result = body.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: {} } : await tool(body.params.name);
    response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "qa-test" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  config.previewMcpUrl = `http://127.0.0.1:${address.port}/mcp`;
  config.browserQaTimeoutMs = budget;
  t.after(async () => {
    config.previewMcpUrl = originalUrl;
    config.browserQaTimeoutMs = originalBudget;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { deleted: () => deleted, cancelled: () => cancelled };
}

test("a navigation tool timeout is an explicit non-blocking result with its stage and cause", async (t) => {
  const service = await browserService(t, () => ({ isError: true, content: [{ type: "text", text: "TimeoutError: page.goto: Timeout 45000ms exceeded" }] }));
  const result = await runBrowserQa("100", "200");
  assert.deepEqual(result.findings, []);
  assert.match(result.skippedReason ?? "", /browser_navigate.*TimeoutError/);
  assert.ok(service.deleted(), "release the MCP browser session after a tool error");
});

test("the overall QA budget aborts a hung request rather than leaving background browser work", async (t) => {
  const service = await browserService(t, (name) => name === "browser_navigate" ? new Promise(() => {}) : {}, 150);
  const result = await runBrowserQa("100", "200");
  assert.deepEqual(result.findings, []);
  assert.match(result.skippedReason ?? "", /150ms budget/);
  // Cleanup happens after the deadline result, independently of its aborted signal.
  for (let attempt = 0; attempt < 50 && (!service.deleted() || !service.cancelled()); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(service.deleted());
  assert.ok(service.cancelled());
});

test("page exceptions keep the concrete diagnostic even when a screenshot is unavailable", async (t) => {
  await browserService(t, (name) => {
    const text = name === "browser_evaluate"
      ? '### Result\n{"textLength":10,"canvases":0,"visibleElements":4}'
      : name === "browser_console_messages" ? "### Result\n[ERROR] ReferenceError: player is not defined @ main.js:42"
        : name === "browser_take_screenshot" ? "TimeoutError: screenshot timed out" : "### Result";
    return { isError: name === "browser_take_screenshot", content: [{ type: "text", text }] };
  });
  const result = await runBrowserQa("100", "200");
  assert.match(result.findings[0], /ReferenceError: player is not defined.*main.js:42/);
  // An unavailable screenshot probe is a QA-environment problem, not a finding.
  assert.equal(result.findings.length, 1);
  assert.equal(result.screenshotPng, undefined);
});

test("a blank page is a finding only after a second probe confirms it", async (t) => {
  let probes = 0;
  await browserService(t, (name) => {
    if (name !== "browser_evaluate") return { content: [{ type: "text", text: "### Result" }] };
    probes += 1;
    const state = probes === 1 ? { textLength: 0, canvases: 0, visibleElements: 1 } : { textLength: 42, canvases: 0, visibleElements: 4 };
    return { content: [{ type: "text", text: `### Result\n${JSON.stringify(state)}` }] };
  }, 20_000);
  const result = await runBrowserQa("100", "200");
  assert.equal(probes, 2, "a blank reading is confirmed with a second probe");
  assert.deepEqual(result.findings, []);
});

test("a page that stays blank is reported as a confirmed defect", async (t) => {
  await browserService(t, (name) => {
    const text = name === "browser_evaluate" ? '### Result\n{"textLength":0,"canvases":0,"visibleElements":1}'
      : name === "browser_console_messages" ? "### Result\n[ERROR] ReferenceError: player is not defined @ main.js:42"
        : "### Result";
    return { content: [{ type: "text", text }] };
  }, 20_000);
  const result = await runBrowserQa("100", "200");
  assert.equal(result.findings.length, 2);
  assert.match(result.findings.join("\n"), /blank page/);
  assert.match(result.findings.join("\n"), /player is not defined/);
});
