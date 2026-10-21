import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { EmbedBuilder, type Message, type MessageEditOptions } from "discord.js";
import { renderProgressCard, renderProgressText } from "../src/progress-view.js";
import { requestDisplayText } from "../src/util.js";
import { buildingSnapshot, mergedSnapshot } from "./fixtures/progress.js";

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
  // A single request stays off the card: it is already visible in the thread.
  assert.doesNotMatch(card.description!, /Your request/);
  assert.match(card.description!, /Agent update/);
  assert.match(card.fields!.find((field) => field.name.startsWith("Plan"))!.value, /Connect the live leaderboard/);
  assert.match(card.fields!.find((field) => field.name === "Changes this turn")!.value, /184 \/ −37/);
  assert.match(card.fields!.find((field) => field.name === "Usage")!.value, /28\.4k \/ 100\.0k · 28%/);
  assert.doesNotMatch(JSON.stringify(card), /claude|gpt|surplus|provider\//i);
  assert.match(card.fields!.find((field) => field.name === "Next pass")!.value, /\*\*2\*\*/);
  assert.match(card.fields!.find((field) => field.name === "Project")!.value, /sumo-shove/);
  assert.match(card.footer!.text, /2m 14s.*24 actions.*1 running/);
  // The card already updates in place; saying so only spends footer characters.
  assert.doesNotMatch(card.footer!.text, /Updates in place/);
  assert.deepEqual(options.allowedMentions, { parse: [] });
  assert.doesNotMatch(card.description!, /\d+%|ETA/);
});

test("the card carries no label that only repeats the line beneath it", () => {
  const state = buildingSnapshot();
  const description = embed(renderProgressCard(state)).description!;
  // The rail already names the phase, and the activity line describes itself.
  assert.doesNotMatch(description, /Right now|In the project queue/);
  assert.equal(embed(renderProgressCard(state)).author, undefined, "the embed needs no author chrome");

  // The queued variant must not say "Queued" twice.
  state.phase = "queued";
  const queued = embed(renderProgressCard(state)).description!;
  assert.equal((queued.match(/Queued/g) ?? []).length, 1);
  assert.doesNotMatch(queued, /In the project queue/);
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
  assert.match(card.description!, /Running · 1m 5s/);
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

test("a queued turn leads the rail instead of leaving every stage pending", () => {
  const state = buildingSnapshot();
  state.phase = "queued";
  const description = embed(renderProgressCard(state)).description!;
  assert.match(description, /^\*\*● Queued\*\*  ›  ○ Prepare/);
  assert.doesNotMatch(description, /● Build|✓ /);
  // The stage list still renders, so the reader knows what happens next.
  assert.match(description, /○ Publish/);
});

test("a non-question amber card explains what it is waiting on", () => {
  const state = buildingSnapshot();
  state.waiting = true;
  state.waitingReason = "A tool reported an error — the agent is retrying";
  let card = embed(renderProgressCard(state));
  assert.equal(card.color, 0xf59e0b);
  assert.match(card.description!, /A tool reported an error/);
  assert.doesNotMatch(card.description!, /Right now/);

  // Without a reason the card still says something rather than showing a bare amber frame.
  state.waitingReason = undefined;
  card = embed(renderProgressCard(state));
  assert.match(card.description!, /Waiting on the agent/);

  // A question owns the amber state and its own heading, so no duplicate warning.
  state.questions = [{ question: "Pick a theme", options: [{ label: "Dark" }] }];
  card = embed(renderProgressCard(state));
  assert.match(card.description!, /Waiting for your answer/);
  assert.doesNotMatch(card.description!, /Waiting on the agent|A tool reported/);
});

test("a failed tool or provider retry reaches the card with a stated reason", async () => {
  const progress = new DiscordProgress({ id: "amber", edit: async () => {} } as unknown as Message, "Updating");
  const snapshot = () => (progress as unknown as { snapshot: () => ReturnType<typeof buildingSnapshot> }).snapshot();
  try {
    progress.callback({ text: "🔧 Fixing the build", tool: { id: "t1", name: "bash", status: "error" } });
    assert.equal(snapshot().waiting, true);
    assert.match(snapshot().waitingReason!, /tool reported an error/);

    progress.callback({ text: "🔌 Waiting for the agent service to be reachable" });
    assert.equal(snapshot().waiting, true);
    assert.match(snapshot().waitingReason!, /agent service/);

    progress.callback({ text: "✏️ Editing code" });
    assert.equal(snapshot().waiting, false);
    assert.equal(snapshot().waitingReason, undefined);
  } finally { await progress.close(); }
});

test("a merged prompt shows the user's own words, not the model-facing preamble", () => {
  const merged = "Add a leaderboard\n\nWhile updates were queued, the user sent 2 more messages — apply all of them in this same pass:\n2. Make the arena louder\n3. Fix the reset button";
  const display = requestDisplayText(["Add a leaderboard", "Make the arena louder", "Fix the reset button"]);
  assert.doesNotMatch(display, /While updates were queued|apply all of them/);
  assert.equal(display, "Add a leaderboard · Make the arena louder · Fix the reset button");
  assert.match(merged, /While updates were queued/, "the prompt keeps its instructions for the model");

  // Blank and whitespace-only entries never produce stray separators.
  assert.equal(requestDisplayText(["  only  ", "   ", ""]), "only");
  assert.equal(requestDisplayText([]), "");
});

test("only a merged turn echoes the request, so the plan keeps the space", () => {
  const single = embed(renderProgressCard(buildingSnapshot()));
  assert.doesNotMatch(single.description!, /Your requests?/);

  const merged = embed(renderProgressCard(mergedSnapshot()));
  assert.match(merged.description!, /\*\*Your requests\*\*/);
  assert.match(merged.description!, /Add a proper leaderboard/);
  // The plan field is still present and unfiltered by the request block.
  assert.match(merged.fields!.find((field) => field.name.startsWith("Plan"))!.value, /Connect the live leaderboard/);
});

test("the plan shows up to seven items instead of four", () => {
  const state = buildingSnapshot();
  state.plan = Array.from({ length: 12 }, (_, index) => ({
    content: `Task number ${index + 1}`,
    status: index < 2 ? "completed" as const : index === 2 ? "in_progress" as const : "pending" as const,
  }));
  const value = embed(renderProgressCard(state)).fields!.find((field) => field.name.startsWith("Plan"))!.value;
  // The most recent completed item for context, then the in-progress and
  // pending work: seven lines total, up from four.
  for (let index = 2; index <= 8; index += 1) assert.match(value, new RegExp(`Task number ${index}\\b`));
  assert.doesNotMatch(value, /Task number 1\b|Task number 9\b/);
  assert.match(value, /more planned/);
  assert.ok(value.length <= 1024, `plan field is ${value.length} chars`);
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

test("a resumed session restores the plan the server already holds", async () => {
  const harness = new OpenCodeHarness();
  const updates: import("../src/progress.js").ProgressUpdate[] = [];
  const todos = [
    { content: "Extend the koi data model", status: "completed" },
    { content: "Wire the clinic actions", status: "in_progress" },
    { content: "Rebuild the keeper's desk UI", status: "pending" },
  ];
  const calls: string[] = [];
  const stub = harness as unknown as {
    client: { session: { todo: (options: { sessionID: string }) => Promise<unknown> } };
    rehydratePlan: (directory: string, sessionId: string, onProgress: unknown, options?: { onlyUnfinished?: boolean }) => Promise<void>;
  };
  stub.client.session.todo = async (options) => {
    calls.push(options.sessionID);
    return { data: todos };
  };

  await stub.rehydratePlan("/workspace/project", "session", (update: typeof updates[number]) => updates.push(update));
  const plan = updates.find((update) => update.kind === "plan")!.plan!;
  assert.deepEqual(plan.map((item) => item.status), ["completed", "in_progress", "pending"]);
  assert.equal(plan[1].content, "Wire the clinic actions");
  assert.deepEqual(calls, ["session"]);

  // An unknown status is surfaced as pending rather than dropped.
  updates.length = 0;
  stub.client.session.todo = async () => ({ data: [{ content: "Mystery", status: "blocked" }] });
  await stub.rehydratePlan("/workspace/project", "session", (update: typeof updates[number]) => updates.push(update));
  assert.equal(updates.find((update) => update.kind === "plan")!.plan![0].status, "pending");

  // A fresh turn inherits the previous list only while it still has work left.
  updates.length = 0;
  stub.client.session.todo = async () => ({ data: [{ content: "Finished", status: "completed" }] });
  await stub.rehydratePlan("/workspace/project", "session", (update: typeof updates[number]) => updates.push(update), { onlyUnfinished: true });
  assert.equal(updates.length, 0);

  // A failing or empty lookup must stay silent — the turn still runs.
  updates.length = 0;
  stub.client.session.todo = async () => { throw new Error("not found"); };
  await stub.rehydratePlan("/workspace/project", "session", (update: typeof updates[number]) => updates.push(update));
  assert.equal(updates.length, 0);
  stub.client.session.todo = async () => ({ data: [] });
  await stub.rehydratePlan("/workspace/project", "session", (update: typeof updates[number]) => updates.push(update));
  assert.equal(updates.length, 0);
});

test("a resumed turn's stall clock starts at supervision attach, not the original start", async () => {
  const { config } = await import("../src/config.js");
  const original = config.turnStallWarnMs;
  (config as { turnStallWarnMs: number }).turnStallWarnMs = 10_000;
  // The bot was down for 40 minutes before reattaching to the interrupted turn.
  const progress = new DiscordProgress({ id: "resumed", edit: async () => {} } as unknown as Message, "♻️ Recovering", Date.now() - 40 * 60_000);
  const internals = progress as unknown as { lastActivityAt: number; snapshot: () => ReturnType<typeof buildingSnapshot> };
  try {
    // The outage before the attach must not read as "no progress for 40m".
    assert.equal(internals.snapshot().stalledForMs, undefined);
    // Quiet supervision still trips the watchdog on its own, counting from the attach.
    internals.lastActivityAt = Date.now() - 11_000;
    assert.ok((internals.snapshot().stalledForMs ?? 0) >= 10_000);
    // The elapsed display keeps the turn's real age.
    assert.ok(internals.snapshot().now - internals.snapshot().startedAt >= 39 * 60_000);
  } finally {
    (config as { turnStallWarnMs: number }).turnStallWarnMs = original;
    await progress.close();
  }
});

test("a recovery watcher adopts existing child sessions into shared turn state", async () => {
  const harness = new OpenCodeHarness();
  const turns: Array<{ childSessions: Set<string> }> = [];
  const stub = harness as unknown as {
    client: { session: { list: () => Promise<unknown> } };
    startEventStream: (directory: string, sessionId: string, onProgress: undefined, turn: unknown) => Promise<{ stop: () => void; done: Promise<void> }>;
  };
  // Children created while the bot was down never announced themselves over
  // the stream; the session list is the only place they are discoverable.
  stub.client.session.list = async () => ({
    data: [
      { id: "child-1", directory: "/w", parentID: "session" },
      { id: "unrelated", directory: "/w" },
    ],
  });
  let connections = 0;
  stub.startEventStream = async (_directory, _sessionId, _onProgress, turn) => {
    connections += 1;
    turns.push(turn as { childSessions: Set<string> });
    let settle!: () => void;
    const done = new Promise<void>((resolve) => { settle = resolve; });
    return { stop: () => settle(), done };
  };
  const stopWatching = await harness.watchExistingTurn("/w", "session");
  try {
    while (connections < 1) await nextTick();
    await nextTick(); // let the post-connect adoption settle
    assert.ok(turns[0]!.childSessions.has("child-1"), "the pre-existing child session was adopted");
    assert.equal(turns[0]!.childSessions.has("unrelated"), false, "unrelated sessions stay filtered");
  } finally {
    await stopWatching();
  }
  assert.equal(connections, 1, "the watcher stays attached while the stream is live");
});

test("a stop landing during reconcile fails the turn instead of resurrecting it", async () => {
  const { config } = await import("../src/config.js");
  const originalTimeout = config.opencodeReconcileTimeoutMs;
  const originalPoll = config.opencodeReconcilePollMs;
  (config as { opencodeReconcileTimeoutMs: number }).opencodeReconcileTimeoutMs = 10_000;
  (config as { opencodeReconcilePollMs: number }).opencodeReconcilePollMs = 30;
  const harness = new OpenCodeHarness();
  const stub = harness as unknown as {
    startEventStream: () => Promise<never>;
    client: {
      session: {
        prompt: () => Promise<never>;
        messages: () => Promise<unknown[]>;
        status: () => Promise<Record<string, unknown>>;
        abort: () => Promise<unknown>;
      };
    };
  };
  let sends = 0;
  stub.startEventStream = async () => { throw new Error("no stream in test"); };
  stub.client.session.prompt = async () => { sends += 1; throw new Error("fetch failed: connection reset"); };
  stub.client.session.messages = async () => [];
  let abortFired = false;
  stub.client.session.status = async () => {
    // The user's stop lands while the reconcile loop is already polling: the
    // original request rejected long ago, so only the mark tells the loop.
    if (!abortFired) {
      abortFired = true;
      await harness.abortTurn("/w", "session");
    }
    return {}; // idle: nothing running server-side anymore
  };
  stub.client.session.abort = async () => ({});
  try {
    await assert.rejects(harness.prompt("/w", "session", "keep building"), /deliberately stopped while reconciling/i);
    // continueAfterRestart must never re-send the prompt the stop killed.
    assert.equal(sends, 1);
  } finally {
    (config as { opencodeReconcileTimeoutMs: number }).opencodeReconcileTimeoutMs = originalTimeout;
    (config as { opencodeReconcilePollMs: number }).opencodeReconcilePollMs = originalPoll;
  }
});

test("a stale abort mark from an earlier turn does not misclassify this turn's failure", async () => {
  const { config } = await import("../src/config.js");
  const originalTimeout = config.opencodeReconcileTimeoutMs;
  const originalPoll = config.opencodeReconcilePollMs;
  (config as { opencodeReconcileTimeoutMs: number }).opencodeReconcileTimeoutMs = 300;
  (config as { opencodeReconcilePollMs: number }).opencodeReconcilePollMs = 30;
  const harness = new OpenCodeHarness();
  const stub = harness as unknown as {
    startEventStream: () => Promise<never>;
    client: {
      session: {
        prompt: () => Promise<never>;
        messages: () => Promise<unknown[]>;
        status: () => Promise<Record<string, unknown>>;
        abort: () => Promise<unknown>;
      };
    };
  };
  stub.startEventStream = async () => { throw new Error("no stream in test"); };
  stub.client.session.prompt = async () => { throw new Error("fetch failed: connection reset"); };
  stub.client.session.messages = async () => [];
  stub.client.session.status = async () => ({});
  stub.client.session.abort = async () => ({});
  // A reconcile-timeout abort of the PREVIOUS turn left its mark behind; this
  // turn never carried an aborted request, so it must still reconcile rather
  // than report a deliberate stop it never suffered.
  await harness.abortTurn("/w", "session");
  try {
    await assert.rejects(harness.prompt("/w", "session", "try again"), (error: Error) =>
      /timed out while reconciling/i.test(error.message) && !/deliberately stopped/i.test(error.message));
  } finally {
    (config as { opencodeReconcileTimeoutMs: number }).opencodeReconcileTimeoutMs = originalTimeout;
    (config as { opencodeReconcilePollMs: number }).opencodeReconcilePollMs = originalPoll;
  }
});

test("a recovery watcher re-emits a question that was pending before the bot died", async () => {
  const harness = new OpenCodeHarness();
  const updates: Array<import("../src/progress.js").ProgressUpdate> = [];
  const stub = harness as unknown as {
    client: { question: { list: () => Promise<unknown> } };
    startEventStream: () => Promise<{ stop: () => void; done: Promise<void> }>;
  };
  // The question.asked event fired while the bot was down; the pending list is
  // the only way the parked turn's buttons can come back.
  stub.client.question.list = async () => ({
    data: [{ id: "q1", sessionID: "session", questions: [{ header: "Theme", question: "Dark or light?", options: [{ label: "Dark" }, { label: "Light" }] }] }],
  });
  stub.startEventStream = async () => {
    let settle!: () => void;
    const done = new Promise<void>((resolve) => { settle = resolve; });
    return { stop: () => settle(), done };
  };
  const stopWatching = await harness.watchExistingTurn("/w", "session", (update) => { updates.push(update); });
  try {
    while (!updates.some((update) => update.kind === "question")) await nextTick();
    const question = updates.find((update) => update.kind === "question")!.question!;
    assert.equal(question.requestID, "q1");
    assert.equal(question.questions[0]!.options.length, 2);
  } finally {
    await stopWatching();
  }
});

test("reconcile fails fast when the saved session no longer exists", async () => {
  const harness = new OpenCodeHarness();
  const stub = harness as unknown as {
    startEventStream: () => Promise<never>;
    client: {
      session: {
        prompt: () => Promise<never>;
        messages: () => Promise<never>;
        status: () => Promise<Record<string, unknown>>;
      };
    };
  };
  stub.startEventStream = async () => { throw new Error("no stream in test"); };
  stub.client.session.prompt = async () => { throw new Error("fetch failed: connection reset"); };
  stub.client.session.messages = async () => { throw new Error("404 session not found"); };
  stub.client.session.status = async () => ({});
  const startedAt = Date.now();
  // Must reject with the session-gone text well inside the 30-minute window,
  // so the caller's recreate-session-and-reprompt path can run.
  await assert.rejects(harness.prompt("/w", "session", "build"), /unknown session/i);
  assert.ok(Date.now() - startedAt < 5_000, "failed fast instead of polling the full reconcile window");
});

test("a mid-turn message steers the running session without aborting it", async () => {
  const harness = new OpenCodeHarness();
  const stub = harness as unknown as {
    startEventStream: () => Promise<never>;
    client: {
      session: {
        prompt: (options: unknown) => Promise<unknown>;
        promptAsync: (options: unknown) => Promise<unknown>;
        messages: () => Promise<unknown[]>;
      };
    };
  };
  stub.startEventStream = async () => { throw new Error("no stream in test"); };
  stub.client.session.messages = async () => [];
  // Steering must be impossible before any prompt request is in flight.
  assert.equal(await harness.steer("/w", "session", "make it harder"), false);

  let releasePrompt!: (value: unknown) => void;
  stub.client.session.prompt = () => new Promise((resolve) => { releasePrompt = resolve; });
  const asyncCalls: unknown[] = [];
  stub.client.session.promptAsync = async (options: unknown) => { asyncCalls.push(options); return {}; };
  const prompting = harness.prompt("/w", "session", "build the arena");
  await new Promise((resolve) => setImmediate(resolve));
  // Mid-turn: the steer is submitted to the busy session and accepted.
  // Payload construction (session/agent/preamble/user text) is covered
  // end-to-end by reliability.test.ts's steerActiveTurn test.
  assert.equal(await harness.steer("/w", "session", "make the ice slipperier"), true);
  assert.equal(asyncCalls.length, 1);
  // The original turn request was never disturbed: it completes normally.
  releasePrompt({ parts: [{ type: "text", text: "arena built" }] });
  const result = await prompting;
  assert.equal(result.text, "arena built");

  // After the turn settles, there is nothing running to steer.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await harness.steer("/w", "session", "again"), false);
});

test("a steering submission the server rejects reports failure, not success", async () => {
  const harness = new OpenCodeHarness();
  const stub = harness as unknown as {
    startEventStream: () => Promise<never>;
    client: {
      session: {
        prompt: (options: unknown) => Promise<unknown>;
        promptAsync: (options: unknown) => Promise<never>;
        messages: () => Promise<unknown[]>;
      };
    };
  };
  stub.startEventStream = async () => { throw new Error("no stream in test"); };
  stub.client.session.messages = async () => [];
  let releasePrompt!: (value: unknown) => void;
  stub.client.session.prompt = () => new Promise((resolve) => { releasePrompt = resolve; });
  stub.client.session.promptAsync = async () => { throw new Error("session busy"); };
  const prompting = harness.prompt("/w", "session", "build");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await harness.steer("/w", "session", "steer this"), false);
  releasePrompt({ parts: [{ type: "text", text: "done" }] });
  await prompting;
});
