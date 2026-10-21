import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionMessage } from "../src/opencode.js";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const { UsageLog } = await import("../src/usage.js");
const { OpenCodeHarness, usageFromMessages, reconcileUsage } = await import("../src/opencode.js");

function message(id: string, created: number, input = 100, output = 20): SessionMessage {
  return { info: { id, role: "assistant", providerID: "test", modelID: "model", time: { created },
    tokens: { input, output, cache: { read: 30, write: 5 }, reasoning: 2 }, cost: 0.01 },
  parts: [{ id: `part-${id}`, type: "step-finish", tokens: { input, output, cache: { read: 30, write: 5 }, reasoning: 2 }, cost: 0.01 }] };
}

test("saved billing counts each message/step once, includes cache/reasoning, and honors turn boundaries", () => {
  const first = message("first", 1000);
  first.parts!.push(first.parts![0]);
  const fallback = message("fallback", 1500);
  fallback.parts = [];
  const saved = usageFromMessages([message("old", 500), first, first, fallback, message("next", 2100)], 1000, 2000)!;
  assert.equal(saved.inputTokens, 270);
  assert.equal(saved.outputTokens, 44);
  assert.equal(saved.cacheTokens, 70);
  assert.equal(saved.cost, 0.02);
  assert.equal(saved.steps, 2);
  assert.equal(saved.models[0].model, "test/model");
  assert.equal(usageFromMessages([first], 1000, 2000, new Set(["first"])), undefined);
  assert.equal(reconcileUsage(saved, saved)!.inputTokens, 270, "replayed history does not add spend");
});

test("turn revisions survive reopening the ledger, concurrent appends and a torn final line", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-usage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "usage.jsonl");
  const input = { id: "turn", sessionId: "session", threadId: "thread", project: "Game", kind: "game-3d" };
  const log = new UsageLog(file);
  await log.record({ ...input, pending: true });
  const usage = usageFromMessages([message("done", Date.now())])!;
  await log.record({ ...input, usage, failed: true });
  await log.record({ ...input, usage }); // restarted delivery succeeds
  const reopened = new UsageLog(file);
  let total = await reopened.threadTotal("thread");
  assert.equal(total.turns, 1);
  assert.equal(total.failedTurns, 0);
  assert.equal(total.inputTokens, 135);
  await reopened.record(input); // history unavailable during a second restart
  assert.equal((await reopened.threadTotal("thread")).inputTokens, 135);
  await fs.appendFile(file, '{"v":1,"truncated":');
  await Promise.all(Array.from({ length: 5 }, (_, i) => reopened.record({ ...input, id: `extra-${i}`, usage })));
  total = await new UsageLog(file).threadTotal("thread");
  assert.equal(total.turns, 6);
  assert.equal(total.inputTokens, 810);
});

test("legacy zero-token entries backfill within their windows, retaining failures and turn counts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-usage-backfill-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "usage.jsonl");
  const entry = { v: 1, label: "turn", threadId: "thread", project: "Game", kind: "game-3d",
    inputTokens: 0, outputTokens: 0, cacheTokens: 0, cost: 0, models: [] };
  await fs.writeFile(file, [
    { ...entry, ts: new Date(2000).toISOString(), failed: true },
    { ...entry, ts: new Date(4000).toISOString() },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n");
  const log = new UsageLog(file);
  const messages = [message("first", 1000), message("second", 3000, 200, 40), message("future", 5000)];
  assert.equal(await log.reconcileThread("thread", "session", messages), true);
  assert.equal(await new UsageLog(file).reconcileThread("thread", "session", messages), false);
  const total = await new UsageLog(file).threadTotal("thread");
  assert.equal(total.turns, 2);
  assert.equal(total.failedTurns, 1);
  assert.equal(total.inputTokens, 370);
  assert.equal(total.outputTokens, 64);
  assert.equal((await log.modelBreakdown()).models[0].inputTokens, 370);
});

test("prompt usage is recovered without any live events, including paginated and child history", async () => {
  const harness = new OpenCodeHarness();
  const stub = harness as any;
  let sent = false;
  const started = Date.now() + 1000;
  const all = Array.from({ length: 205 }, (_, i) => message(`m${String(i).padStart(3, "0")}`, started + i));
  const cursors: string[] = [];
  stub.startEventStream = async () => { throw new Error("stream unavailable"); };
  stub.client = { session: {
    prompt: async () => { sent = true; return { data: { parts: [{ type: "text", text: "Finished" }] } }; },
    messages: async ({ sessionID, limit, before }: { sessionID: string; limit: number; before?: string }) => {
      if (!sent) return { data: [] };
      if (sessionID === "child") return { data: [message("child-message", started + 100)] };
      if (before) cursors.push(before);
      const eligible = before ? all.filter((m) => m.info!.id! < before) : all;
      return { data: eligible.slice(-limit) };
    },
    children: async ({ sessionID }: { sessionID: string }) => ({ data: sessionID === "root" ? [{ id: "child" }] : [] }),
  } };
  const result = await harness.prompt("/workspace", "root", "Build the game");
  assert.equal(result.text, "Finished");
  assert.equal(result.usage.steps, 206);
  assert.equal(result.usage.inputTokens, 206 * 135);
  assert.deepEqual(cursors, ["m005"]);
});
