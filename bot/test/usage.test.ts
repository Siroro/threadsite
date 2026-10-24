import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionMessage, TurnUsage } from "../src/opencode.js";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const { UsageLog } = await import("../src/usage.js");
const { usageFromMessages, sessionUsageFromMessages, addUsage, reconcileUsage } = await import("../src/opencode.js");

function message(id: string, created: number, input = 100, output = 20): SessionMessage {
  return { info: { id, role: "assistant", providerID: "test", modelID: "model", time: { created },
    tokens: { input, output, cache: { read: 30, write: 5 }, reasoning: 2 }, cost: 0.01 }, parts: [] };
}

test("saved billing counts each message/step once, includes cache/reasoning, and honors turn boundaries", () => {
  const first = message("first", 1000);
  const second = message("second", 1500);
  const unbilled: SessionMessage = { info: { id: "idle", role: "assistant", time: { created: 1800 } } };
  const saved = usageFromMessages([message("old", 500), first, first, second, unbilled, message("next", 2100)], 1000, 2000)!;
  assert.equal(saved.inputTokens, 270);
  assert.equal(saved.outputTokens, 44);
  assert.equal(saved.cacheTokens, 70);
  assert.equal(saved.cost, 0.02);
  assert.equal(saved.steps, 2);
  assert.equal(saved.models[0].model, "test/model");
  assert.equal(usageFromMessages([first], 1000, 2000, new Set(["first"])), undefined);
  assert.equal(reconcileUsage(saved, saved)!.inputTokens, 270, "replayed history does not add spend");
});

test("saved history never contributes a tok/s rate: without live anchors the windows are meaningless", () => {
  // Steps recovered from saved messages have no first-sighting anchors, and the
  // gaps between their step-finishes say nothing about generation time —
  // parallel subagent steps land in bursts that would rate a turn at 100k+ tok/s.
  const recovered = usageFromMessages([message("a", Date.now() - 60_000), message("b", Date.now()), message("c", Date.now())])!;
  assert.equal(recovered.steps, 3);
  assert.equal(recovered.outputTokens, 66);
  assert.equal(recovered.outputTokensPerSecond, undefined);
  assert.equal(recovered.generationMs, undefined);
  assert.equal(recovered.timedOutputTokens, undefined);
});

test("reconcile keeps either side's spend when the fuller token snapshot is unpriced", () => {
  // A surplus-style provider: the stream's step events quote real spend while
  // the saved message records report none — and either side can be the one
  // with the fuller token counts.
  const step = (id: string, input: number, output: number, cost: number): SessionMessage => ({
    info: { id, role: "assistant", providerID: "surplus", modelID: "deepseek-4.1", time: { created: 1000 },
      tokens: { input, output, cache: { read: 0, write: 0 } }, cost }, parts: [],
  });
  const stream = usageFromMessages([step("s1", 1_000, 200, 0.4)])!;
  const unpricedHistory = usageFromMessages([step("h1", 1_500, 300, 0)])!;
  const reconciled = reconcileUsage(stream, unpricedHistory)!;
  assert.equal(reconciled.inputTokens, 1_500, "the fuller token counts still win");
  assert.equal(reconciled.outputTokens, 300);
  assert.equal(reconciled.cost, 0.4, "an unpriced snapshot does not erase stream-reported spend");
  assert.equal(reconciled.models.find((entry) => entry.model === "surplus/deepseek-4.1")!.cost, 0.4);

  const unpricedStream = usageFromMessages([step("s2", 2_000, 400, 0)])!;
  const pricedHistory = usageFromMessages([step("h2", 100, 20, 0.2)])!;
  assert.equal(reconcileUsage(unpricedStream, pricedHistory)!.cost, 0.2,
    "an unpriced stream does not erase history-reported spend either");
});

test("the session split attributes root and subagent figures that sum to the turn totals", () => {
  const step = (id: string, sessionID: string, created: number, input: number, output: number, cost = 0, modelID = "deepseek-4.1"): SessionMessage => ({
    info: { id, sessionID, role: "assistant", providerID: "surplus", modelID, time: { created },
      tokens: { input, output, cache: { read: 0, write: 0 } }, cost }, parts: [],
  });
  const turn = [
    step("old", "ses_root", 500, 900, 100),            // before the turn's window
    step("base", "ses_root", 900, 800, 80),            // baseline message of a recovered turn
    step("r1", "ses_root", 1000, 1_000, 200, 0.3),
    step("r1", "ses_root", 1000, 1_000, 200, 0.3),     // replayed history counts once
    step("r2", "ses_root", 1050, 500, 100, 0.1, "glm-5.3"), // mid-session failover to another model
    step("e1", "ses_explore", 1100, 300, 40, 0.05, "glm-5.3"),
    step("q1", "ses_qa", 1200, 100, 10, 0.01),
    { info: { id: "untimed", sessionID: "ses_root", role: "assistant", time: { created: 1300 } }, parts: [] }, // no provider counts
  ];
  const totals = usageFromMessages(turn, 1000, Infinity, new Set(["base"]))!;
  const agents = new Map([["ses_explore", "explore"], ["ses_qa", "browser-qa"]]);
  const split = sessionUsageFromMessages(turn, "ses_root", (id) => agents.get(id), 1000, Infinity, new Set(["base"]));
  assert.deepEqual(split.map((entry) => entry.sessionID), ["ses_root", "ses_explore", "ses_qa"],
    "the root session leads, then children by volume");
  assert.equal(split[0].root, true);
  assert.equal(split[0].agent, undefined);
  assert.equal(split[0].steps, 2, "the windowed, non-baseline root steps are the only ones attributed");
  assert.equal(split[1].agent, "explore");
  assert.equal(split[2].agent, "browser-qa");
  for (const field of ["inputTokens", "outputTokens", "cost"] as const) {
    assert.equal(split.reduce((sum, entry) => sum + entry[field], 0), totals[field],
      `the split's ${field} sums to the turn totals`);
  }
  // The failover is attributed per model, inside the session that ran it.
  assert.deepEqual(split[0].models?.map((entry) => [entry.model, entry.inputTokens]),
    [["surplus/deepseek-4.1", 1_000], ["surplus/glm-5.3", 500]]);
  assert.deepEqual(split[1].models?.map((entry) => entry.model), ["surplus/glm-5.3"]);
  // An unobserved child still gets a bucket, labeled as a generic subagent.
  assert.equal(sessionUsageFromMessages([step("x", "ses_ghost", 1500, 10, 1)], "ses_root", () => undefined)[0].agent, "subagent");
});

test("addUsage merges repair passes without double-counting a session", () => {
  const usage = (sessions: TurnUsage["sessions"], inputTokens: number, steps: number, cost: number): TurnUsage => ({
    inputTokens, outputTokens: 10, cacheTokens: 0, contextTokens: 0, compactions: 0, steps, cost, models: [], sessions,
  });
  const root = (inputTokens: number, steps: number): TurnUsage["sessions"] =>
    [{ sessionID: "ses_root", root: true, inputTokens, outputTokens: 10, cacheTokens: 0, cost: 0.1, steps }];
  const first = usage(root(100, 2), 100, 2, 0.2);
  const repair = usage([...root(150, 3),
    { sessionID: "ses_fix", agent: "general", inputTokens: 0, outputTokens: 0, cacheTokens: 0, cost: 0, steps: 0 }], 150, 3, 0.3);
  const merged = addUsage(first, repair)!;
  assert.equal(merged.inputTokens, 250);
  assert.deepEqual(merged.sessions?.map((entry) => [entry.sessionID, entry.inputTokens, entry.steps]),
    [["ses_root", 250, 5], ["ses_fix", 0, 0]], "the root session sums across passes; children keep their own");
  assert.equal(merged.sessions?.[0].root, true);
  assert.equal(addUsage(first, undefined)!.sessions?.length, 1, "a pass without a split keeps the other's");
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

test("side prompts spend tokens without counting as turns", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-usage-side-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "usage.jsonl");
  const log = new UsageLog(file);
  const usage = usageFromMessages([message("done", Date.now())])!;
  await log.record({ label: "turn", threadId: "thread", project: "Game", kind: "game-2d", usage });
  await log.record({ label: "title", threadId: "thread", project: "Game", kind: "game-2d", usage });
  const total = await new UsageLog(file).threadTotal("thread");
  assert.equal(total.turns, 1, "only real agent turns count as turns");
  assert.equal(total.inputTokens, 270, "side prompts still spent their tokens");
});

test("missing turn usage reconciles within saved boundaries, retaining failures and turn counts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-usage-backfill-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "usage.jsonl");
  const entry = { v: 1, label: "turn", threadId: "thread", project: "Game", kind: "game-3d",
    inputTokens: 0, outputTokens: 0, cacheTokens: 0, cost: 0, models: [] };
  await fs.writeFile(file, [
    { ...entry, id: "first-turn", sessionId: "session", startedAt: new Date(1000).toISOString(), ts: new Date(2000).toISOString(), failed: true },
    { ...entry, id: "second-turn", sessionId: "session", startedAt: new Date(3000).toISOString(), ts: new Date(4000).toISOString() },
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

test("project deletion erases every usage revision while preserving other projects and ignoring late events", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-usage-delete-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const file = path.join(root, "usage.jsonl");
  const log = new UsageLog(file);
  const input = { id: "turn", threadId: "gone", project: "Private project name", kind: "site" };
  await log.record({ ...input, pending: true });
  await log.record({ ...input, usage: usageFromMessages([message("completed", Date.now())]) });
  await log.record({ id: "other", threadId: "keep", project: "Keep", kind: "site" });
  await log.forgetThread("gone");
  await log.record(input);
  assert.doesNotMatch(await fs.readFile(file, "utf8"), /Private project name|gone/);
  assert.equal((await new UsageLog(file).threadTotal("gone")).turns, 0);
  assert.equal((await new UsageLog(file).threadTotal("keep")).turns, 1);
});
