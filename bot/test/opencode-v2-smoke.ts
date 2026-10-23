// Opt-in contract check against the pinned, real OpenCode 2 CLI. All model
// responses are scripted locally; no provider credentials or paid calls.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { OpenCode } from "@opencode/client";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const binary = process.env.OPENCODE_V2_BINARY;
assert.ok(binary, "Set OPENCODE_V2_BINARY to the OpenCode 2.1.3 executable");
const { buildV2Config } = await import("../../opencode/v2/config.mjs");
const { buildSurplusProvider } = await import("../../opencode/surplus-adapter.mjs");
const { OpenCodeV2Harness } = await import("../src/opencode-v2.js");
const { config } = await import("../src/config.js");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-v2-smoke-"));
const workspace = path.join(root, "workspace", "guild", "thread");
await fs.mkdir(path.join(workspace, "site", "src"), { recursive: true });
await fs.writeFile(path.join(workspace, "AGENTS.md"), "Smoke fixture. Follow the user's task.");
const lspCommand = process.env.OPENCODE_LSP_SMOKE_COMMAND ? JSON.parse(process.env.OPENCODE_LSP_SMOKE_COMMAND) : undefined;
const source = 'export const count: number = "wrong";\n';
await fs.writeFile(path.join(workspace, "site", "src", "lsp-smoke.ts"), source);
const docsCalls: string[] = [];
const browserCalls: string[] = [];
const qaRequests: Array<{ tools: string[]; hasImage: boolean }> = [];
const screenshot = (await fs.readFile(new URL("../assets/skills/threejs-game-studio/assets/scorecard-anchors/scene-1.jpg", import.meta.url))).toString("base64");
const docsOffline = process.env.OPENCODE_DOCS_SMOKE_OFFLINE === "1";
const docs = http.createServer(async (request, response) => {
  if (request.method !== "POST") { response.writeHead(405).end(); return; }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const message = JSON.parse(Buffer.concat(chunks).toString());
  const browser = request.url === "/browser";
  if (message.id === undefined) { response.writeHead(202).end(); return; }
  if (docsOffline && !browser) {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Documentation fixture unavailable" }));
    return;
  }
  let result: any = {};
  if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: "context7-fixture", version: "1" } };
  if (message.method === "tools/list") result = { tools: (browser ? ["browser_navigate", "browser_take_screenshot"] : ["resolve-library-id", "query-docs", "unexpected-write"]).map((name) => ({
    name, description: "Public API docs fixture", inputSchema: { type: "object", properties: {} },
  })) };
  if (message.method === "tools/call") {
    (browser ? browserCalls : docsCalls).push(message.params.name);
    result = browser && message.params.name === "browser_take_screenshot"
      ? { content: [{ type: "image", mimeType: "image/jpeg", data: screenshot }] }
      : { content: [{ type: "text", text: browser ? "Preview loaded" : "Fixture library documentation" }] };
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
});
docs.listen(0, "127.0.0.1");
await once(docs, "listening");
const docsPort = (docs.address() as import("node:net").AddressInfo).port;
const models = new Set<string>();
const efforts: string[] = [];
const toolNames = new Set<string>();
let providerRequests = 0;
const provider = http.createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (body.model === "glm-5.3") {
    assert.equal(body.options?.reasoningEffort, undefined);
    assert.equal(body.options?.reasoning_effort, undefined);
    efforts.push(body.reasoning_effort);
  }
  providerRequests++;
  models.add(body.model);
  if (body.model === "vision") {
    await fs.writeFile(path.join(root, `qa-request-${qaRequests.length}.json`), JSON.stringify(body, null, 2));
    qaRequests.push({ tools: (body.tools ?? []).map((tool: any) => tool.function.name), hasImage: JSON.stringify(body.messages).includes("image_url") });
    // Keep QA in flight long enough for the root to finish independent work.
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  for (const tool of body.tools ?? []) toolNames.add(tool.function?.name);
  const user = body.messages.filter((message: any) => message.role === "user").at(-1);
  const text = JSON.stringify(user?.content ?? "");
  const compaction = JSON.stringify(body.messages).includes("<template>");
  const reply = compaction ? "## Objective\n- Verify the isolated ThreadSite fixture.\n\n## Work State\n### Completed\n- Runtime checks and durable notes.\n\n## Next Move\n1. Finish the remaining smoke checks." : "Smoke Project";
  const last = body.messages.at(-1);
  let calls = text.includes("Build smoke") && last?.role !== "tool" ? [
    { id: "call_plan", name: "todowrite", arguments: JSON.stringify({ todos: [{ content: "Verify runtime", status: "in_progress" }] }) },
    { id: "call_notes", name: "project_notes", arguments: JSON.stringify({ note: "[decision] Preserve the smoke test fixture." }) },
    { id: "call_question", name: "question", arguments: JSON.stringify({ questions: [{ header: "Colour", question: "Choose a colour", options: [{ label: "Blue", description: "Blue palette" }] }] }) },
  ] : [];
  if (text.includes("Effort wire smoke") && last?.role !== "tool") calls = [
    { id: `effort_read_${efforts.length}`, name: "read", arguments: JSON.stringify({ path: "site/src/lsp-smoke.ts" }) },
  ];
  if (text.includes("Delegate smoke") && last?.role !== "tool") calls = [{ id: "call_child", name: "subagent",
    arguments: JSON.stringify({ agent: text.includes("explore") ? "explore" : "general", description: "Inspect the fixture",
      prompt: "Child inspection smoke: read site/src/lsp-smoke.ts and summarize.", background: false }) }];
  if (text.includes("Child inspection smoke") && last?.role !== "tool") calls = [{ id: "call_child_read", name: "read",
    arguments: JSON.stringify({ path: "site/src/lsp-smoke.ts" }) }];
  if (text.includes("Browser QA smoke")) {
    // Let the event subscription attach before the scripted delegation starts.
    if (last?.role !== "tool") await new Promise((resolve) => setTimeout(resolve, 250));
    if (last?.role !== "tool") calls = [{ id: "call_browser_qa", name: "subagent",
      arguments: JSON.stringify({ agent: "browser-qa", model: "threadsite-test/text", background: true,
        description: "Inspect the preview", prompt: "Inspect browser fixture at http://127.0.0.1:8080/100/200/. Navigate and take a screenshot, then report." }) }];
    else if (last.tool_call_id === "call_browser_qa") calls = [{ id: "call_independent_read", name: "read",
      arguments: JSON.stringify({ path: "site/src/lsp-smoke.ts" }) }];
  }
  if (text.includes("Inspect browser fixture") && !JSON.stringify(body.messages).includes("image_url")) calls = [{
    id: last?.role === "tool" ? "call_screenshot" : "call_navigate",
    name: last?.role === "tool" ? "playwright_browser_take_screenshot" : "playwright_browser_navigate",
    arguments: last?.role === "tool" ? "{}" : JSON.stringify({ url: "http://127.0.0.1:8080/100/200/" }),
  }];
  if (text.includes("Stop smoke") && last?.role !== "tool") calls = [{ id: "call_stop_question", name: "question",
    arguments: JSON.stringify({ questions: [{ header: "Wait", question: "Wait for stop", options: [{ label: "Wait", description: "Keep waiting" }] }] }) }];
  if (text.includes("Documentation smoke") && last?.role !== "tool") calls = [
    { id: "call_resolve", name: "context7_resolve-library-id", arguments: "{}" },
    { id: "call_docs", name: "context7_query-docs", arguments: "{}" },
  ];
  if (text.includes("Language server smoke") && last?.role !== "tool") calls = [
    { id: "call_write", name: "write", arguments: JSON.stringify({ path: "site/src/lsp-smoke.ts", content: source }) },
    { id: "call_lsp", name: "lsp", arguments: JSON.stringify({ operation: "hover", path: "site/src/lsp-smoke.ts", line: 1, character: 14 }) },
  ];
  if (!body.stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "chat_smoke", object: "chat.completion", model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const frame = (delta: any, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({
    id: "chat_smoke", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model,
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  frame({ role: "assistant" });
  if (calls.length) {
    frame({ tool_calls: calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) });
    frame({}, "tool_calls");
  } else { frame({ content: reply }); frame({}, "stop"); }
  response.write(`data: ${JSON.stringify({ id: "chat_smoke", object: "chat.completion.chunk", model: body.model, choices: [],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 20 } } })}\n\n`);
  response.end("data: [DONE]\n\n");
});
provider.listen(0, "127.0.0.1");
await once(provider, "listening");
const providerPort = (provider.address() as import("node:net").AddressInfo).port;
const lease = http.createServer();
lease.listen(0, "127.0.0.1");
await once(lease, "listening");
const port = (lease.address() as import("node:net").AddressInfo).port;
await new Promise<void>((resolve) => lease.close(() => resolve()));
const base = JSON.parse(await fs.readFile(new URL("../../opencode/opencode.json", import.meta.url), "utf8"));
base.providers = { "threadsite-test": { package: "@ai-sdk/openai-compatible", name: "Local scripted provider",
  settings: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "test-only" },
  models: {
    text: { name: "Test", limit: { context: 32000, output: 2048 }, capabilities: { tools: true, input: ["text"], output: ["text"] } },
    child: { name: "Child test", limit: { context: 32000, output: 2048 }, capabilities: { tools: true, input: ["text"], output: ["text"] } },
    vision: { name: "Vision QA test", limit: { context: 32000, output: 2048 }, capabilities: { tools: true, input: ["text", "image"], output: ["text"] } },
  } } };
const surplus = await buildSurplusProvider({ env: { SURPLUS_BASE_URL: `http://127.0.0.1:${providerPort}/v1` },
  fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "glm-5.3",
    supported_parameters: ["tools", "reasoning_effort"], architecture: { input_modalities: ["text"] } }] }) }) });
base.providers.surplus = surplus.provider;
base.mcp = { servers: { playwright: { type: "remote", url: `http://127.0.0.1:${docsPort}/browser`, disabled: false, oauth: false, codemode: false, timeout: { startup: 5000, catalog: 5000, execution: 5000 } } } };
base.lsp = lspCommand ? { typescript: { ...base.lsp.typescript, command: lspCommand } } : false;
base.formatter = false;
for (const agent of Object.values(base.agents) as any[]) agent.model = "threadsite-test/text";
const runtime = buildV2Config(base, { pluginPath: pathToFileURL(path.resolve(import.meta.dirname, "../../opencode/v2")).href,
  env: { OPENCODE_BROWSER_QA_MODEL: "threadsite-test/vision" } });
for (const agent of ["general", "explore"]) runtime.agents[agent].model = "threadsite-test/child";
runtime.mcp.servers.context7.url = `http://127.0.0.1:${docsPort}/mcp`;
const configFile = path.join(root, "opencode.json");
await fs.writeFile(configFile, JSON.stringify(runtime));
const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
  cwd: workspace, windowsHide: true,
  env: { ...process.env, OPENCODE_CONFIG: configFile, OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_PASSWORD: "smoke-test-only", OPENCODE_TEST_HOME: root,
    XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state") },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (data) => { output += data; });
child.stderr.on("data", (data) => { output += data; });
const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { Authorization: `Basic ${Buffer.from("opencode:smoke-test-only").toString("base64")}` } });
try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { await client.server.info({ signal: AbortSignal.timeout(1000) }); break; }
    catch (error) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`OpenCode did not become ready: ${output}`, { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  config.opencodeReconcilePollMs = 100;
  config.opencodeReconcileTimeoutMs = 30_000;
  config.workspaceRoot = path.join(root, "workspace");
  const harness = new OpenCodeV2Harness(client);
  assert.match(await harness.health(), /^ok/);
  const sessionID = await harness.createSession(workspace, "Smoke");
  let plugins = await client.plugin.list({ location: { directory: workspace } });
  for (let i = 0; i < 30 && !plugins.data.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    plugins = await client.plugin.list({ location: { directory: workspace } });
  }
  assert.ok(plugins.data.some((plugin) => plugin.id === "threadsite.v2" && plugin.state.status === "active"), JSON.stringify(plugins));
  const effortSession = await harness.createSession(workspace, "Effort wire check");
  try {
    for (const [level, effective] of [["minimal", "low"], ["low", "low"], ["medium", "high"], ["high", "high"], ["xhigh", "max"], ["max", "max"], ["auto", undefined]]) {
      const before = efforts.length;
      const result = await harness.prompt(workspace, effortSession, "Effort wire smoke", "surplus/glm-5.3", undefined, "sitebuilder", level);
      assert.equal(result.text, "Smoke Project");
      assert.deepEqual(efforts.slice(before), [effective, effective], "the effective effort must survive tool calls and variant changes; only auto may omit it");
    }
  } finally { await client.session.remove({ sessionID: effortSession }); }
  let answered = false;
  const result = await harness.prompt(workspace, sessionID, "Build smoke", "threadsite-test/text", async (update) => {
    if (update.question && !update.question.resolved && !answered) {
      answered = true;
      assert.equal(await harness.steer(workspace, sessionID, "Finish the current task"), true);
      await harness.replyToQuestion(workspace, update.question.requestID, [["Blue"]]);
    }
  });
  assert.equal(result.text, "Smoke Project");
  assert.equal(answered, true);
  assert.ok(result.usage.steps >= 2);
  assert.ok(result.usage.inputTokens > 0);
  assert.match(await fs.readFile(path.join(workspace, "PROJECT_NOTES.md"), "utf8"), /Preserve the smoke/);
  for (const name of ["todowrite", "todoread", "project_notes", "js_syntax_check", "asset_download", "asset_import"]) assert.ok(toolNames.has(name), `Missing production tool ${name}`);
  assert.ok(![...toolNames].some((name) => name.startsWith("playwright")));
  if (!docsOffline) {
    await harness.prompt(workspace, sessionID, "Documentation smoke", "threadsite-test/text");
    assert.deepEqual(docsCalls.sort(), ["query-docs", "resolve-library-id"]);
  } else {
    assert.deepEqual(docsCalls, []);
    assert.ok(!toolNames.has("context7_query-docs"), "an unavailable documentation service must not block builder work");
  }
  assert.ok(!toolNames.has("context7_unexpected-write"));
  if (lspCommand) {
    await harness.prompt(workspace, sessionID, "Language server smoke", "threadsite-test/text");
    const messages = JSON.stringify(await harness.listMessages(workspace, sessionID));
    assert.match(messages, /LSP errors detected/);
    assert.match(messages, /not assignable to type/);
    assert.match(messages, /const count: number/);
  }
  assert.equal(await harness.steer(workspace, sessionID, "Too late"), false);
  const title = await harness.generateTitle(workspace, "Name this fixture", "threadsite-test/text");
  assert.equal(title.title, "Smoke Project");
  const delegatedAgents: string[] = [];
  for (const agent of ["general", "explore"]) {
    const delegated = await harness.prompt(workspace, sessionID, `Delegate smoke ${agent}`, "threadsite-test/text");
    assert.ok(delegated.usage.steps >= 4, "billing includes root delegation, child read/response and root completion");
    const children = (await harness.usageMessages(workspace, sessionID)).filter((message) =>
      message.info?.sessionID !== sessionID && message.info?.agent === agent);
    assert.ok(children.some((message) => message.parts?.some((part) => part.type === "tool"
      && part.tool === "read" && part.state?.status === "completed")), `${agent} must execute the delegated read`);
    assert.ok(children.some((message) => message.parts?.some((part) => part.type === "text" && part.text === "Smoke Project")),
      `${agent} must return its result`);
    assert.ok(children.every((message) => message.info?.modelID === "child"), `${agent} must use its configured model`);
    delegatedAgents.push(agent);
  }
  const qaProgress: import("../src/progress.js").ProgressUpdate[] = [];
  const browserQa = await harness.prompt(workspace, sessionID, "Browser QA smoke", "threadsite-test/text", (update) => { qaProgress.push(update); });
  const activeQa = qaProgress.filter((update) => update.activeSubagents !== undefined).map((update) => update.activeSubagents);
  await fs.writeFile(path.join(root, "qa-progress.json"), JSON.stringify(qaProgress, null, 2));
  assert.ok(activeQa.includes(1), "native background QA appears as an active subagent");
  assert.equal(activeQa.at(-1), 0, "completed QA disappears from the live count");
  assert.ok(qaProgress.every((update) => !update.tool?.name.startsWith("playwright_")), "child browser actions stay off the parent feed");
  assert.deepEqual(browserCalls, ["browser_navigate", "browser_take_screenshot"]);
  assert.ok(qaRequests.length >= 3);
  assert.ok(qaRequests.every((request) => request.tools.length > 0 && request.tools.every((name) => name.startsWith("playwright_"))),
    "QA receives only browser tools");
  assert.ok(qaRequests.some((request) => request.hasImage), "the dedicated vision model receives the screenshot");
  assert.ok(browserQa.usage.models?.some((model) => model.model === "threadsite-test/vision" && model.outputTokens > 0),
    "the original turn includes completed background QA usage");
  const qaHistory = await harness.listMessages(workspace, sessionID);
  assert.ok(qaHistory.some((message) => message.parts?.some((part) => part.type === "tool" && part.tool === "subagent"
    && part.state?.input?.agent === "browser-qa" && part.state?.input?.background === true)), "QA stays in background mode");
  const rawRoot = (await client.message.list({ sessionID })).data;
  const independent = rawRoot.find((message) => message.type === "assistant" && message.content.some((part) =>
    part.type === "tool" && part.id === "call_independent_read"));
  const qaChild = (await client.session.list()).data.find((session) => session.parentID === sessionID && session.agent === "browser-qa");
  assert.ok(qaChild);
  const qaSteps = (await client.message.list({ sessionID: qaChild.id })).data.filter((message) => message.type === "assistant");
  assert.ok(independent && qaSteps.some((message) => message.time.completed! > independent.time.created),
    "the builder performs independent work before the background inspection finishes");
  let qaStop: Promise<boolean> | undefined;
  const stoppedQa = harness.prompt(workspace, sessionID, "Browser QA smoke stop", "threadsite-test/text", (update) => {
    if (!qaStop && update.tool?.name === "subagent" && update.tool.status === "completed") {
      qaStop = harness.abortTurn(workspace, sessionID);
    }
  });
  await assert.rejects(stoppedQa, /stopped/);
  assert.equal(await qaStop, true, "stop interrupts QA and drains its native completion notification");
  assert.equal(await harness.isBusy(workspace, sessionID), false);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await harness.isBusy(workspace, sessionID), false, "late QA completion cannot restart a stopped builder");
  const parked = await client.session.synthetic({ sessionID, text: "Parked QA recovery fixture: the inspection found no defects.",
    metadata: { source: "subagent", agent: "browser-qa", childID: qaChild.id, state: "completed" }, resume: false });
  assert.ok((await client.session.inbox.list({ sessionID })).some((item) => item.id === parked.id));
  const recovered = new OpenCodeV2Harness(client);
  const stopRecovery = await recovered.watchExistingTurn(workspace, sessionID);
  try {
    const recoveryDeadline = Date.now() + 10_000;
    while (await recovered.isBusy(workspace, sessionID)) {
      assert.ok(Date.now() < recoveryDeadline, "a parked QA result must resume during owned recovery");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const recoveredMessages = (await client.message.list({ sessionID })).data;
    assert.equal(recoveredMessages.filter((message) => message.id === parked.id).length, 1, "receipt replay must remain idempotent");
    assert.ok(recoveredMessages.some((message) => message.type === "assistant" && message.time.created >= parked.time.created));
  } finally { await stopRecovery(); }
  await harness.compactSession(workspace, sessionID, "threadsite-test", "text");
  assert.ok((await harness.listMessages(workspace, sessionID)).some((message) => message.parts?.some((part) => part.type === "compaction")));
  await harness.setProviderToken("openai", "smoke-test-only");
  await harness.clearProviderToken("openai");
  const saved = await harness.usageMessages(workspace, sessionID);
  assert.ok(saved.length >= 4);
  const userID = await harness.lastUserMessageId(workspace, sessionID);
  assert.ok(userID);
  await harness.revertSession(workspace, sessionID, userID);
  let stopping = false;
  const interrupted = harness.prompt(workspace, sessionID, "Stop smoke", "threadsite-test/text", async (update) => {
    if (update.question && !update.question.resolved && !stopping) {
      stopping = true;
      assert.equal(await harness.abortTurn(workspace, sessionID), true);
    }
  });
  await assert.rejects(interrupted, /stopped/);
  assert.equal(stopping, true);
  assert.equal(await harness.isBusy(workspace, sessionID), false);
  await harness.deleteSessionsInDirectory(workspace, sessionID);
  assert.deepEqual(await harness.workspaceSessions(), []);
  assert.deepEqual([...models], ["glm-5.3", "text", "child", "vision"]);
  console.log(JSON.stringify({ ok: true, providerRequests, steps: result.usage.steps, delegatedAgents, browserCalls, tools: [...toolNames].sort(), root }));
} catch (error) {
  console.error(`Smoke artifacts: ${root}`);
  console.error(output.split("\n").filter((line) => /WARN|ERROR|plugin|failed/i.test(line)).join("\n").slice(-12000));
  throw error;
} finally {
  child.kill();
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5000))]);
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  docs.closeAllConnections();
  await new Promise<void>((resolve) => docs.close(() => resolve()));
}
