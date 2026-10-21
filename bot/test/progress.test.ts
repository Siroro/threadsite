import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { EmbedBuilder, type Message, type MessageEditOptions } from "discord.js";
import { renderProgressCard, renderProgressText } from "../src/progress-view.js";
import { buildingSnapshot } from "./fixtures/progress.js";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const { DiscordProgress } = await import("../src/progress.js");
const { OpenCodeHarness } = await import("../src/opencode.js");

function embed(options: MessageEditOptions) {
  return (options.embeds![0] as EmbedBuilder).toJSON();
}

test("the card shows the real stage, plan, changes, usage, saved requests and links", () => {
  const state = buildingSnapshot();
  const options = renderProgressCard(state);
  const card = embed(options);
  assert.equal(options.content, "");
  assert.equal(card.color, 0x5865f2);
  assert.match(card.description!, /\*\*● Build\*\*/);
  assert.match(card.description!, /Your request/);
  assert.match(card.description!, /Agent update/);
  assert.match(card.fields!.find((field) => field.name.startsWith("Plan"))!.value, /Connect the live leaderboard/);
  assert.match(card.fields!.find((field) => field.name === "Changes this turn")!.value, /184 \/ −37/);
  assert.match(card.fields!.find((field) => field.name === "Usage")!.value, /28% context/);
  assert.doesNotMatch(JSON.stringify(card), /claude|gpt|surplus|provider\//i);
  assert.match(card.fields!.find((field) => field.name === "Next pass")!.value, /\*\*2\*\*/);
  assert.match(card.fields!.find((field) => field.name === "Project")!.value, /sumo-shove/);
  assert.match(card.footer!.text, /2m 14s.*24 actions.*1 running/);
  assert.deepEqual(options.allowedMentions, { parse: [] });
  assert.doesNotMatch(card.description!, /\d+%|ETA/);
});

test("questions take priority, show option descriptions, then retain the named decision", () => {
  const state = buildingSnapshot();
  state.questions = [{ question: "How should matches end?", options: [{ label: "First to five", description: "Short, competitive rounds" }] }];
  let card = embed(renderProgressCard(state));
  assert.equal(card.color, 0xf59e0b);
  assert.match(card.description!, /Waiting for your answer/);
  assert.doesNotMatch(card.description!, /Agent update/);
  assert.match(card.fields!.find((field) => field.name.includes("Your input"))!.value, /Short, competitive rounds/);
  assert.equal(card.fields!.some((field) => field.name === "Recent activity" || field.name === "Usage"), false);
  state.questions = undefined;
  state.questionPin = { question: "How should matches end?", resolution: "Shane chose First to five" };
  card = embed(renderProgressCard(state));
  assert.match(card.fields!.find((field) => field.name === "Decision")!.value, /Shane chose/);
});

test("long streamed text and adversarial markdown stay within Discord embed and text budgets", () => {
  const state = buildingSnapshot();
  const long = "[@everyone](https://example.invalid) *** ".repeat(1000);
  state.title = long;
  state.context.request = long;
  state.thought = long;
  state.plan = Array.from({ length: 100 }, () => ({ content: long, status: "pending" }));
  state.questions = Array.from({ length: 5 }, () => ({ question: long, options: Array.from({ length: 4 }, () => ({ label: long, description: long })) }));
  state.history = Array.from({ length: 10 }, () => ({ text: long, detail: long, at: state.startedAt }));
  const options = renderProgressCard(state);
  const builder = options.embeds![0] as EmbedBuilder;
  const card = builder.toJSON();
  assert.ok(builder.length <= 6000);
  assert.ok(card.title!.length <= 256);
  assert.ok(card.description!.length <= 4096);
  assert.ok(card.fields!.every((field) => field.value.length <= 1024));
  assert.ok(renderProgressText(state).content!.length <= 2000);
});

test("quiet activity shows its age without claiming a failure or estimating completion", () => {
  const state = buildingSnapshot();
  state.now += 60_000;
  const card = embed(renderProgressCard(state));
  assert.match(card.description!, /Running this activity · 1m 5s/);
  assert.doesNotMatch(card.description!, /failed|stalled|ETA|remaining/i);
});

test("a turn with no agent activity is flagged with /site stop guidance", () => {
  const state = buildingSnapshot();
  state.now += 6 * 60_000;
  state.stalledForMs = 6 * 60_000;
  const card = embed(renderProgressCard(state));
  assert.equal(card.color, 0xf59e0b);
  assert.match(card.description!, /No progress for 6m 0s/);
  assert.match(card.description!, /\/site stop/);
  assert.match(card.footer!.text, /No progress for 6m 0s/);
  assert.doesNotMatch(card.description!, /Generating|Running this activity/);
});

test("queued turns and pending questions are idle by design, not stalled", () => {
  const queued = buildingSnapshot();
  queued.phase = "queued";
  queued.stalledForMs = 20 * 60_000;
  assert.doesNotMatch(embed(renderProgressCard(queued)).description!, /No progress/);

  const waiting = buildingSnapshot();
  waiting.stalledForMs = 20 * 60_000;
  waiting.questions = [{ question: "Pick a theme", options: [{ label: "Dark" }] }];
  assert.doesNotMatch(embed(renderProgressCard(waiting)).description!, /No progress/);
});

test("the watchdog derives stall time from agent events, not queued-user notifications", async () => {
  const { config } = await import("../src/config.js");
  const original = config.turnStallWarnMs;
  (config as { turnStallWarnMs: number }).turnStallWarnMs = 10_000;
  const progress = new DiscordProgress({ id: "stall", edit: async () => {} } as unknown as Message, "Watching");
  const internals = progress as unknown as {
    lastActivityAt: number;
    snapshot: () => ReturnType<typeof buildingSnapshot>;
  };
  try {
    internals.lastActivityAt = Date.now() - 11_000;
    assert.ok((internals.snapshot().stalledForMs ?? 0) >= 10_000);

    // Agent activity clears the stall state.
    progress.callback({ kind: "thought", text: "Editing the leaderboard implementation" });
    assert.equal(internals.snapshot().stalledForMs, undefined);

    // A queued message is a user event, so it must not hide a wedged provider.
    internals.lastActivityAt = Date.now() - 11_000;
    progress.callback({ kind: "queue", text: "Saved requests", queuedRequests: 1 });
    assert.ok((internals.snapshot().stalledForMs ?? 0) >= 10_000);
  } finally {
    (config as { turnStallWarnMs: number }).turnStallWarnMs = original;
    await progress.close();
  }
});

test("progress edits are serialized and close waits before the final result can replace them", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const edits: MessageEditOptions[] = [];
  const message = { id: "status", edit: async (options: MessageEditOptions) => { edits.push(options); await blocked; } } as unknown as Message;
  const progress = new DiscordProgress(message, "Building the arena");
  progress.update("Preparing files");
  progress.callback({ text: "Editing player.ts", tool: { id: "one", name: "write", status: "running" } });
  progress.callback({ kind: "metrics", text: "Usage", metrics: { inputTokens: 100 } });
  await nextTick();
  assert.equal(edits.length, 1);
  let closed = false;
  const closing = progress.close().then(() => { closed = true; });
  await nextTick();
  assert.equal(closed, false);
  release();
  await closing;
  progress.update("Late event after finishing");
  await nextTick();
  assert.equal(edits.length, 1);
});

test("running/completed duplicates count as one tool action, and Stop remains available", async () => {
  const progress = new DiscordProgress({ id: "status", edit: async () => {} } as unknown as Message, "Updating");
  try {
    progress.enableStopButton();
    progress.callback({ text: "Editing", tool: { id: "one", name: "write", status: "running" } });
    progress.callback({ text: "Editing", tool: { id: "one", name: "write", status: "running" } });
    progress.callback({ text: "File saved", tool: { id: "one", name: "write", status: "completed" } });
    const snapshot = (progress as unknown as { snapshot: () => ReturnType<typeof buildingSnapshot> }).snapshot();
    assert.equal(snapshot.actions, 1);
    assert.equal(snapshot.activeTools, 0);
    assert.equal(snapshot.history.some((item) => item.key === "one"), false);
  } finally { await progress.close(); }
});

test("servers without embed permission fall back to text and keep working controls", async () => {
  const edits: MessageEditOptions[] = [];
  const message = { id: "fallback", edit: async (options: MessageEditOptions) => {
    edits.push(options);
    if (options.embeds?.length) throw Object.assign(new Error("Missing Permissions"), { code: 50013 });
  } } as unknown as Message;
  const progress = new DiscordProgress(message, "Updating without embeds");
  progress.enableStopButton();
  await nextTick();
  await progress.close();
  assert.equal(edits.length, 2);
  assert.match(edits[1].content!, /Updating without embeds/);
  assert.equal(edits[1].embeds!.length, 0);
  assert.equal(edits[1].components!.length, 1);
});

test("OpenCode feeds structured plan, public usage and tool events without exposing reasoning or spend", () => {
  const harness = new OpenCodeHarness();
  const updates: import("../src/progress.js").ProgressUpdate[] = [];
  const now = Date.now();
  const turn = {
    assistantMessageIds: new Set(["assistant"]), model: { providerID: "provider", modelID: "model" },
    outputTokens: 0, inputTokens: 0, cacheTokens: 0, contextTokens: 0, contextLimit: 100000, cost: 0, steps: 0,
    compactions: 0, baselineCompactions: 0, childSessions: new Set(), messageModels: new Map(), modelUsage: new Map(),
    startedAt: now - 1000, generationMs: 0, timedOutputTokens: 0, stepStartAtByMessage: new Map(), lastStepFinishAt: now - 1000,
    liveTokenSamples: [], livePartBytes: new Map(), deltaFedParts: new Set(), lastLiveStatsAt: 0,
  };
  const handle = (event: unknown) => (harness as unknown as { handleEvent: (...args: unknown[]) => void }).handleEvent(event, "/workspace/project", "session", (update: typeof updates[number]) => updates.push(update), turn);
  handle({ type: "todo.updated", properties: { sessionID: "session", todos: [{ content: "Add a leaderboard", status: "in_progress" }] } });
  assert.equal(updates.find((update) => update.kind === "plan")!.plan![0].content, "Add a leaderboard");
  handle({ type: "message.part.updated", properties: { part: { sessionID: "session", id: "tool", type: "tool", tool: "write", state: { status: "completed", input: { filePath: "/workspace/project/site/src/main.ts" } } } } });
  assert.equal(updates.find((update) => update.tool)?.tool?.status, "completed");
  handle({ type: "message.part.updated", properties: { part: { sessionID: "session", messageID: "assistant", id: "reasoning", type: "reasoning", text: "PRIVATE_REASONING_TEST_MARKER" } } });
  handle({ type: "message.part.updated", properties: { part: { sessionID: "session", messageID: "assistant", type: "step-finish", cost: 12345, tokens: { input: 1000, output: 120, cache: { read: 500, write: 0 } } } } });
  const metrics = updates.filter((update) => update.metrics).at(-1)!.metrics!;
  assert.equal(metrics.inputTokens, 1500);
  assert.equal(metrics.outputTokens, 120);
  assert.equal(metrics.cacheTokens, 500);
  assert.doesNotMatch(JSON.stringify(updates), /PRIVATE_REASONING_TEST_MARKER|12345|"cost"/);
});
