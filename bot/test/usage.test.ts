import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionMessage, TurnUsage } from "../src/opencode.js";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const { UsageLog } = await import("../src/usage.js");
const { annotateCatalogCosts, usageFromMessages, sessionUsageFromMessages, addUsage, reconcileUsage, reportedCost } = await import("../src/opencode.js");
const { formatCost } = await import("../src/util.js");

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

test("discounted marketplace charges stay visible instead of rounding to $0", () => {
  // A surplus marketplace call bills fractions of a cent (179 micro-dollars
  // per million input tokens), so a project's real spend sits far below one
  // cent. Rendering that as "$0" would read as free.
  assert.equal(formatCost(0.0005), "$0.0005");
  assert.equal(formatCost(0.0000123), "$0.000012");
  assert.equal(formatCost(0.0000001), "<$0.000001", "below micro precision, say so rather than claim zero");
  assert.equal(formatCost(0.009999), "$0.01", "ordinary sub-cent amounts keep two-decimal readability");
  assert.equal(formatCost(3.42), "$3.42");
  assert.equal(formatCost(0), "$0", "a genuine zero is still zero");
});

test("a gateway's own charge replaces the catalog estimate for the same tokens", () => {
  // Surplus reports what it actually charged in usage.buyer_cost_micro
  // (micro-dollars, sometimes a string); OpenCode leaves it unmapped, so the
  // catalog estimate stands unless the native payload is read.
  const step = (id: string, cost: number, native?: Record<string, unknown>): SessionMessage => ({
    info: { id, role: "assistant", providerID: "surplus", modelID: "qwen3.8-max-0902", time: { created: 1000 },
      tokens: { input: 2_000_000, output: 200_000, cache: { read: 1_800_000, write: 0 } }, cost, native }, parts: [],
  });
  const charged = usageFromMessages([step("a", 12.84, { buyer_cost_micro: 1_500_000 })])!;
  assert.equal(charged.cost, 1.5, "the reported charge, not the $12.84 catalog estimate");
  assert.equal(charged.models[0].reported, true);
  assert.equal(charged.models[0].cost, 1.5);
  assert.equal(charged.models[0].inputTokens, 3_800_000, "tokens still come from the provider's counts, cache included");
  assert.equal(charged.models[0].cacheTokens, 1_800_000);

  assert.equal(usageFromMessages([step("b", 12.84, { buyer_cost_micro: "1500000" })])!.cost, 1.5,
    "a micro-dollar string decodes too");
  assert.equal(usageFromMessages([step("c", 12.84, { buyer_cost_micro: 0 })])!.cost, 0,
    "a reported zero is authoritative, not a reason to fall back");
  assert.equal(usageFromMessages([step("d", 12.84)])!.cost, 12.84,
    "without a reported charge the catalog estimate stands");
  assert.equal(usageFromMessages([step("e", 12.84, { buyer_cost_micro: "n/a" })])!.cost, 12.84,
    "a malformed charge does not zero the figure");
  assert.equal(usageFromMessages([step("f", 12.84)])!.models[0].reported, undefined);
  assert.equal(reportedCost(undefined), undefined);
  assert.equal(reportedCost({ total_tokens: 5 }), undefined);
});

test("reconcile never lets a larger catalog estimate override a reported charge", () => {
  const step = (id: string, tokens: number, cost: number, native?: Record<string, unknown>): SessionMessage => ({
    info: { id, role: "assistant", providerID: "surplus", modelID: "qwen3.8-max-0902", time: { created: 1000 },
      tokens: { input: tokens, output: 0, cache: { read: 0, write: 0 } }, cost, native }, parts: [],
  });
  // The live stream kept the provider's charge; the saved history only has
  // OpenCode's estimate — and that estimate is larger.
  const observed = usageFromMessages([step("s1", 1_000, 1.5, { buyer_cost_micro: 1_500_000 })])!;
  const saved = usageFromMessages([step("h1", 1_500, 9.5)])!;
  const reconciled = reconcileUsage(observed, saved)!;
  assert.equal(reconciled.inputTokens, 1_500, "the fuller token counts still win");
  assert.equal(reconciled.models[0].cost, 1.5, "the reported charge beats the bigger estimate");
  assert.equal(reconciled.cost, 1.5, "and the total agrees with the model line");

  // Both sides estimates: the larger figure still wins, as before.
  const estA = usageFromMessages([step("s2", 1_000, 1.5)])!;
  const estB = usageFromMessages([step("h2", 1_500, 2.5)])!;
  assert.equal(reconcileUsage(estA, estB)!.cost, 2.5);
});

test("a turn total always equals the sum of its model lines", () => {
  // The pinned card shows the total and the per-model lines together; a total
  // that disagrees with them reads as a wrong price.
  const mixed = usageFromMessages([
    { info: { id: "a", role: "assistant", providerID: "surplus", modelID: "glm-5.3", time: { created: 1000 },
      tokens: { input: 1_000, output: 100, cache: { read: 0, write: 0 } }, cost: 9.99, native: { buyer_cost_micro: 400_000 } }, parts: [] },
    { info: { id: "b", role: "assistant", providerID: "opencode", modelID: "qwen-free", time: { created: 1100 },
      tokens: { input: 2_000, output: 50, cache: { read: 0, write: 0 } }, cost: 0.5 }, parts: [] },
  ])!;
  const sum = mixed.models.reduce((total, entry) => total + entry.cost, 0);
  assert.ok(Math.abs(mixed.cost - sum) < 1e-12);
  assert.equal(mixed.cost, 0.9, "one reported charge plus one estimate");
});

test("catalog rates re-price surplus-served models at another provider's list prices", () => {
  const step = (id: string, modelID: string, input: number, cacheRead: number, output: number, cost: number): SessionMessage => ({
    info: { id, role: "assistant", providerID: modelID.startsWith("opencode/") ? "opencode" : "surplus",
      modelID: modelID.replace(/^[a-z-]+\//, ""), time: { created: 1000 },
      tokens: { input, output, cache: { read: cacheRead, write: 0 } }, cost }, parts: [],
  });
  const usage = usageFromMessages([
    step("s1", "surplus/deepseek-4.1", 900, 100, 200, 0.021),
    step("s2", "surplus/glm-5.3", 50, 0, 10, 0.001),
    step("s3", "opencode/deepseek-4.1", 10, 0, 5, 0),
  ])!;
  annotateCatalogCosts(usage, [
    { id: "deepseek-4.1", providerID: "surplus", cost: [{ input: 0.27, output: 1.1 }] },
    { id: "deepseek-4.1", providerID: "deepseek", cost: [
      // Long-context tier first: the untiered base entry is the comparison.
      { tier: { type: "context", size: 200_000 }, input: 4, output: 18, cache: { read: 0.4, write: 4 } },
      { input: 2, output: 9, cache: { read: 0.2, write: 2 } },
    ] },
    { id: "glm-5.3", providerID: "zai" },
  ]);
  const deepseek = usage.models.find((entry) => entry.model === "surplus/deepseek-4.1")!;
  // 900 fresh + 100 cached reads at $2/$0.20, 200 output at $9, per million.
  assert.ok(Math.abs(deepseek.catalogCost! - (900 * 2 + 100 * 0.2 + 200 * 9) / 1_000_000) < 1e-12,
    "the same tokens at the vendor's list rates, cache priced as reads");
  assert.equal(usage.models.find((entry) => entry.model === "surplus/glm-5.3")!.catalogCost, undefined,
    "a model no other provider prices keeps no comparison");
  assert.equal(usage.models.find((entry) => entry.model === "opencode/deepseek-4.1")!.catalogCost, undefined,
    "only surplus-served models are re-priced");
  assert.ok(Math.abs(usage.catalogCost! - deepseek.catalogCost!) < 1e-12);

  // Several providers listing the same id resolve deterministically to the
  // alphabetically first priced one; without cache rates, cached tokens bill
  // at the input rate.
  const contested = usageFromMessages([step("c1", "surplus/deepseek-4.1", 900, 100, 200, 0.021)])!;
  annotateCatalogCosts(contested, [
    { id: "deepseek-4.1", providerID: "zzz-vendor", cost: [{ input: 3, output: 3 }] },
    { id: "deepseek-4.1", providerID: "aaa-vendor", cost: [{ input: 1, output: 2 }] },
  ]);
  const priced = contested.models.find((entry) => entry.model === "surplus/deepseek-4.1")!;
  assert.ok(Math.abs(priced.catalogCost! - ((900 + 100) * 1 + 200 * 2) / 1_000_000) < 1e-12,
    "aaa-vendor wins the tie and its input rate covers the cache");
});

test("reconcile keeps the stream's catalog comparison when fuller history is unpriced", () => {
  const observed = usageFromMessages([{
    info: { id: "s1", role: "assistant", providerID: "surplus", modelID: "deepseek-4.1", time: { created: 1000 },
      tokens: { input: 900, output: 200, cache: { read: 0, write: 0 } }, cost: 0.021 }, parts: [],
  }])!;
  annotateCatalogCosts(observed, [{ id: "deepseek-4.1", providerID: "deepseek", cost: [{ input: 2, output: 9 }] }]);
  const saved = usageFromMessages([{
    info: { id: "h1", role: "assistant", providerID: "surplus", modelID: "deepseek-4.1", time: { created: 1000 },
      tokens: { input: 1_500, output: 300, cache: { read: 0, write: 0 } }, cost: 0 }, parts: [],
  }])!;
  const reconciled = reconcileUsage(observed, saved)!;
  assert.equal(reconciled.inputTokens, 1_500, "the fuller token counts still win");
  assert.equal(reconciled.cost, 0.021, "an unpriced snapshot does not erase stream-reported spend");
  assert.ok(Math.abs(reconciled.models[0].catalogCost! - observed.models[0].catalogCost!) < 1e-12,
    "the fuller snapshot adopts the stream's catalog comparison");
  assert.ok(Math.abs(reconciled.catalogCost! - observed.catalogCost!) < 1e-12);
});

test("thread totals roll per-model catalog comparisons into lifetime figures", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-usage-catalog-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const log = new UsageLog(path.join(root, "usage.jsonl"));
  const usage = usageFromMessages([
    message("a", 1000),
    { info: { id: "b", role: "assistant", providerID: "surplus", modelID: "glm-5.3", time: { created: 1100 },
      tokens: { input: 1_000, output: 100, cache: { read: 0, write: 0 } }, cost: 0.5 }, parts: [] },
  ])!;
  for (const model of usage.models) if (model.model === "surplus/glm-5.3") model.catalogCost = 4.2;
  await log.record({ threadId: "thread", project: "Game", kind: "game-2d", usage });
  const total = await log.threadTotal("thread");
  assert.equal(total.cost, 0.51);
  assert.ok(Math.abs(total.catalogCost - 4.2) < 1e-12);
  assert.ok(Math.abs(total.models.get("surplus/glm-5.3")!.catalogCost! - 4.2) < 1e-12);
  assert.equal(total.models.get("test/model")!.catalogCost, undefined, "an unannotated model gains no figure");
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

test("thread totals keep whether a model's figure was a provider charge", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-usage-reported-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const log = new UsageLog(path.join(root, "usage.jsonl"));
  const charged = (id: string, model: string, cost: number, reported: boolean) => ({
    info: { id, role: "assistant", providerID: "surplus", modelID: model, time: { created: 1000 },
      tokens: { input: 1_000, output: 100, cache: { read: 0, write: 0 } }, cost: reported ? undefined : 9.9,
      ...(reported ? { native: { buyer_cost_micro: Math.round(cost * 1_000_000) } } : {}) }, parts: [],
  });
  await log.record({ threadId: "t", project: "P", kind: "site",
    usage: usageFromMessages([charged("a", "real", 0.001, true)]) });
  await log.record({ threadId: "t", project: "P", kind: "site",
    usage: usageFromMessages([charged("b", "estimate", 9.9, false)]) });
  // One real charge plus one estimate on the same model is a mixed line.
  await log.record({ threadId: "t", project: "P", kind: "site",
    usage: usageFromMessages([charged("c", "mixed", 0.001, true)]) });
  await log.record({ threadId: "t", project: "P", kind: "site",
    usage: usageFromMessages([charged("d", "mixed", 9.9, false)]) });
  const total = await log.threadTotal("t");
  assert.equal(total.models.get("surplus/real")!.reported, true, "a reported charge stays reported through the rollup");
  assert.equal(total.models.get("surplus/real")!.unreported, undefined);
  assert.equal(total.models.get("surplus/estimate")!.unreported, true, "an estimate is marked");
  assert.equal(total.models.get("surplus/mixed")!.unreported, true, "one estimate makes the whole line an estimate");
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
