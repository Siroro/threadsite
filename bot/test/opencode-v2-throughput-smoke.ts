// Opt-in real-provider timing check. Isolated state; only advertised zero-cost
// OpenCode models are permitted. No Discord, deployment or production data.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { OpenCode, type SessionMessageInfo } from "@opencode/client";

process.env.DISCORD_BOT_TOKEN ||= "isolated-test";
process.env.DISCORD_APPLICATION_ID ||= "isolated-test";
const binary = process.env.OPENCODE_V2_BINARY;
assert.ok(binary, "Set OPENCODE_V2_BINARY to the OpenCode 2.1.3 executable");
const { buildV2Config } = await import("../../opencode/v2/config.mjs");
const { OpenCodeV2Harness } = await import("../src/opencode-v2.js");
const { DiscordProgress } = await import("../src/progress.js");
const { renderProgressCard } = await import("../src/progress-view.js");
const { formatTokensPerSecond } = await import("../src/util.js");
const { config } = await import("../src/config.js");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-v2-throughput-"));
const workspace = path.join(root, "workspace");
await fs.mkdir(path.join(workspace, "site", "data"), { recursive: true });
await fs.writeFile(path.join(workspace, "AGENTS.md"), "Timing calibration: follow the user's read-only task exactly.");
const links = Array.from({ length: 13 }, () => `${randomUUID()}.json`);
const marker = `finished-${randomUUID()}`;
for (let index = 0; index < links.length; index++) await fs.writeFile(path.join(workspace, "site", "data", links[index]),
  JSON.stringify(index === links.length - 1 ? { marker } : { next: `site/data/${links[index + 1]}` }));

const legacy = JSON.parse(await fs.readFile(new URL("../../opencode/opencode.json", import.meta.url), "utf8"));
legacy.mcp = {};
legacy.lsp = false;
legacy.formatter = false;
const runtime = buildV2Config(legacy, { env: { OPENCODE_WEBSEARCH_PROVIDER: "off", CONTEXT7_ENABLED: "0" },
  pluginPath: pathToFileURL(path.resolve(import.meta.dirname, "../../opencode/v2")).href });
runtime.agents.sitebuilder.system = "Follow the user's read-only calibration task. Use read, one file per model step. No other tools.";
runtime.agents.sitebuilder.steps = 30;
runtime.agents.sitebuilder.permissions = [{ action: "*", resource: "*", effect: "deny" }, { action: "read", resource: "*", effect: "allow" }];
runtime.providers = {};
const configFile = path.join(root, "opencode.json");
await fs.writeFile(configFile, JSON.stringify(runtime));
const lease = http.createServer();
lease.listen(0, "127.0.0.1");
await once(lease, "listening");
const port = (lease.address() as import("node:net").AddressInfo).port;
await new Promise<void>((resolve) => lease.close(() => resolve()));
const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
  cwd: workspace, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/API_KEY|TOKEN|PASSWORD/.test(name))),
    OPENCODE_CONFIG: configFile, OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_PASSWORD: "isolated-timing-only",
    XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state") },
});
let logs = "";
child.stdout.on("data", (data) => { logs += data; });
child.stderr.on("data", (data) => { logs += data; });
const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`,
  headers: { Authorization: `Basic ${Buffer.from("opencode:isolated-timing-only").toString("base64")}` } });
let sessionID: string | undefined;
let card: InstanceType<typeof DiscordProgress> | undefined;
const events = new AbortController();
let subscribed: Promise<void> | undefined;
console.log(`Live throughput evidence: ${root}`);
try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { await client.server.info({ signal: AbortSignal.timeout(1_000) }); break; }
    catch (error) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error("Isolated OpenCode did not start", { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const catalog = (await client.model.list()).data;
  const free = catalog.filter((model) => model.providerID === "opencode" && model.enabled && model.capabilities.tools
    && model.cost.length > 0 && model.cost.every((tier) => tier.input === 0 && tier.output === 0
      && (!tier.cache || Object.values(tier.cache).every((value) => value === 0))));
  const requested = process.env.OPENCODE_THROUGHPUT_MODEL?.replace(/^opencode\//, "");
  const model = requested ? free.find((model) => model.id === requested)
    : free.find((model) => model.id === "mimo-v2.6-flash-free") ?? free[0];
  assert.ok(model, "No requested zero-cost, tool-capable OpenCode model is available");
  const selected = `opencode/${model.id}`;
  console.log(`Selected ${selected}; every advertised cost tier is zero.`);
  config.opencodeReconcilePollMs = 250;
  config.opencodeReconcileTimeoutMs = 120_000;
  const harness = new OpenCodeV2Harness(client);
  sessionID = await harness.createSession(workspace, "Throughput calibration");
  const trace: object[] = [];
  subscribed = (async () => {
    try {
      for await (const event of client.event.subscribe({ signal: events.signal })) {
        if (!event.type.startsWith("session.step.") || !("sessionID" in event.data) || event.data.sessionID !== sessionID) continue;
        trace.push(event);
      }
    } catch (error) { if (!events.signal.aborted) throw error; }
  })();
  const updates: object[] = [];
  card = new DiscordProgress({ id: "isolated-throughput", edit: async () => {} } as any, "Throughput calibration");
  const timeout = setTimeout(() => { void harness.abortTurn(workspace, sessionID!); }, 240_000);
  let result;
  try {
    result = await harness.prompt(workspace, sessionID,
      `Start by reading ${`site/data/${links[0]}`}. Each JSON file names the next file. Read only that next file, one at a time, until a file contains marker. Do not list, glob, search, use shell or delegate. Finish by printing the marker exactly.`,
      selected, (update) => {
        card!.callback(update);
        if (update.kind === "metrics") {
          updates.push({ at: Date.now(), metrics: update.metrics, card: card!.readSnapshot().metrics });
          if (update.metrics?.steps) console.log(`step ${update.metrics.steps}: average ${update.metrics.outputTokensPerSecond?.toFixed(2) ?? "unavailable"} tok/s`);
        }
      });
  } finally { clearTimeout(timeout); }
  assert.ok(result.text.includes(marker), "Real model must finish the sequential read task");
  assert.ok(result.usage.steps >= 10, "Need a sustained multi-step real-provider sample");
  assert.equal(result.usage.cost, 0);
  const messages: SessionMessageInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.message.list({ sessionID, limit: 100, cursor });
    messages.push(...page.data);
    cursor = page.cursor.next ?? undefined;
  } while (cursor);
  const measured = messages.filter((message): message is Extract<SessionMessageInfo, { type: "assistant" }> => message.type === "assistant" && !!message.tokens
    && message.time.streamed !== undefined && message.time.streamed > message.time.created);
  const generationMs = measured.reduce((sum, message) => sum + (message.time.streamed! - message.time.created), 0);
  const outputTokens = measured.reduce((sum, message) => sum + message.tokens!.output + message.tokens!.reasoning, 0);
  const expected = outputTokens * 1000 / generationMs;
  const rendered = renderProgressCard(card.readSnapshot());
  const displayedRate = `avg ~${formatTokensPerSecond(expected)} tok/s`;
  const report = { model: selected, steps: result.usage.steps, measuredSteps: measured.length, generationMs, outputTokens,
    expectedTokensPerSecond: expected, displayedRate, usage: result.usage, displayedMetrics: card.readSnapshot().metrics };
  await fs.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(root, "messages.json"), JSON.stringify(messages, null, 2));
  await fs.writeFile(path.join(root, "step-events.json"), JSON.stringify(trace, null, 2));
  await fs.writeFile(path.join(root, "progress.json"), JSON.stringify(updates, null, 2));
  await fs.writeFile(path.join(root, "card.json"), JSON.stringify(rendered, null, 2));
  assert.equal(result.usage.generationMs, generationMs);
  assert.equal(result.usage.timedOutputTokens, outputTokens);
  assert.equal(result.usage.outputTokensPerSecond, expected);
  assert.equal(card.readSnapshot().metrics?.liveTokensPerSecond, undefined);
  assert.equal(card.readSnapshot().metrics?.outputTokensPerSecond, expected);
  assert.ok(JSON.stringify(rendered).includes(displayedRate), "Discord payload must show the independently calculated rate");
  console.log(`PASS ${JSON.stringify(report)}`);
} finally {
  events.abort();
  await subscribed;
  await card?.close();
  if (sessionID) await client.session.interrupt({ sessionID, resume: false }).catch(() => {});
  child.kill();
  await fs.writeFile(path.join(root, "server.log"), logs);
}
