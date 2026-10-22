import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { type Message, type MessageEditOptions } from "discord.js";
import { renderProgressOverview as renderProgressCard } from "../src/progress-view.js";
import { assertV2, cardView } from "./fixtures/cards.js";
import { requestDisplayText } from "../src/util.js";
import { buildingSnapshot } from "./fixtures/progress.js";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const { DiscordProgress } = await import("../src/progress.js");
const { LegacyOpenCodeHarness: OpenCodeHarness } = await import("../src/opencode.js");

test("long streamed text and adversarial markdown stay within Discord V2 text and component budgets", () => {
  const state = buildingSnapshot();
  const long = "[@everyone](https://example.invalid) *** ".repeat(1000);
  state.title = long;
  state.context.request = long;
  state.thought = long;
  state.plan = Array.from({ length: 100 }, () => ({ content: long, status: "pending" }));
  state.questions = Array.from({ length: 5 }, () => ({ question: long, options: Array.from({ length: 4 }, () => ({ label: long, description: long })) }));
  state.history = Array.from({ length: 10 }, () => ({ text: long, detail: long, at: state.startedAt }));
  const options = renderProgressCard(state);
  assertV2(options);
  assert.ok(cardView(options).text.length > 0);
});

test("a failed tool waits without a reason line while a provider retry states one", async () => {
  const progress = new DiscordProgress({ id: "amber", edit: async () => {} } as unknown as Message, "Updating");
  const snapshot = () => (progress as unknown as { snapshot: () => ReturnType<typeof buildingSnapshot> }).snapshot();
  try {
    progress.callback({ text: "🔧 Fixing the build", tool: { id: "t1", name: "bash", status: "error" } });
    assert.equal(snapshot().waiting, true);
    assert.equal(snapshot().waitingReason, undefined, "the errored tool headline is its own explanation");

    progress.callback({ text: "🔌 Waiting for the agent service to be reachable" });
    assert.equal(snapshot().waiting, true);
    assert.match(snapshot().waitingReason!, /agent service/);

    progress.callback({ text: "✏️ Editing" });
    assert.equal(snapshot().waiting, false);
    assert.equal(snapshot().waitingReason, undefined);
  } finally { await progress.close(); }
});

test("a repeating v2 session heartbeat cannot bury the running tool line", async () => {
  const progress = new DiscordProgress({ id: "beat", edit: async () => {} } as unknown as Message, "Updating");
  const snapshot = () => (progress as unknown as { snapshot: () => ReturnType<typeof buildingSnapshot> }).snapshot();
  try {
    progress.callback({ text: "✏️ Editing", detail: "site/src/main.ts", tool: { id: "t1", name: "edit", status: "running" } });
    // The v2 status stream repeats its busy text on every event.
    progress.callback({ kind: "heartbeat", text: "OpenCode status updated", active: true });
    progress.callback({ text: "🧠 Model is thinking" });
    assert.equal(snapshot().latest.text, "✏️ Editing");
    assert.equal(snapshot().latest.detail, "site/src/main.ts");
    assert.equal(snapshot().agentReportedActive, true, "the busy flag still lands even when the text is suppressed");

    // With no tool running, the deterministic poll heartbeat is status only
    // and never becomes the live activity line.
    progress.callback({ text: "✅ Edited", detail: "site/src/main.ts", tool: { id: "t1", name: "edit", status: "completed" } });
    progress.callback({ kind: "heartbeat", text: "", active: true });
    progress.callback({ kind: "heartbeat", text: "", active: true });
    assert.equal(snapshot().latest.text, "✅ Edited");
    assert.equal(snapshot().agentReportedActive, true);
    assert.ok(snapshot().history.every((item) => item.text !== ""), "textless heartbeats never enter the feed");
  } finally { await progress.close(); }
});

test("a merged prompt shows the user's own words, not the model-facing preamble", () => {
  const display = requestDisplayText(["Add a leaderboard", "Make the arena louder", "Fix the reset button"]);
  assert.doesNotMatch(display, /While updates were queued|apply all of them/);
  assert.equal(display, "Add a leaderboard · Make the arena louder · Fix the reset button");

  // Blank and whitespace-only entries never produce stray separators.
  assert.equal(requestDisplayText(["  only  ", "   ", ""]), "only");
  assert.equal(requestDisplayText([]), "");
});

test("the plan shows up to seven items instead of four", () => {
  const state = buildingSnapshot();
  state.plan = Array.from({ length: 12 }, (_, index) => ({
    content: `Task number ${index + 1}`,
    status: index < 2 ? "completed" as const : index === 2 ? "in_progress" as const : "pending" as const,
  }));
  const value = cardView(renderProgressCard(state)).fields!.find((field) => field.name.startsWith("Plan"))!.value;
  // The most recent completed item for context, then the in-progress and
  // pending work: seven lines total, up from four.
  for (let index = 2; index <= 8; index += 1) assert.match(value, new RegExp(`Task number ${index}\\b`));
  assert.doesNotMatch(value, /Task number 1\b|Task number 9\b/);
  assert.match(value, /more planned/);
  assert.ok(value.length <= 1024, `plan field is ${value.length} chars`);
});

test("the activity area shows the last three distinct actions with the current one marked", async () => {
  const progress = new DiscordProgress({ id: "tail", edit: async () => {} } as unknown as Message, "Updating");
  try {
    progress.callback({ text: "📚 Reading", detail: "site/src/arena.ts", tool: { id: "read", name: "read", status: "completed" } });
    // Three separate bash calls run the same command: each is its own tool, so
    // an un-deduped tail would show the identical line three times.
    for (const id of ["b1", "b2", "b3"]) progress.callback({ text: "npm test", command: true, tool: { id, name: "bash", status: "completed" } });
    progress.callback({ text: "✏️ Editing", detail: "site/src/player.ts", tool: { id: "edit", name: "edit", status: "running" } });
    const view = cardView(renderProgressCard(progress.readSnapshot()));
    assert.equal(view.description.match(/npm test/g)?.length, 1, "a re-run command occupies one line, not three");
    assert.match(view.description, /▶ \*\*✏️ Editing · site\/src\/player\.ts\*\*/, "the current action is prefixed and bold");
    assert.equal(view.description.match(/▶/g)?.length, 1, "only the current action is marked");
    const read = view.description.indexOf("📚 Reading · site/src/arena.ts");
    const command = view.description.indexOf("npm test");
    const current = view.description.indexOf("▶");
    assert.ok(read >= 0 && read < command && command < current, "the tail runs oldest to newest");
    assert.doesNotMatch(view.description, /Preparing your update/, "older actions fall off the three-line tail");
  } finally { await progress.close(); }
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

test("progress needs no embed permission and nests Turn details and a red Stop in the V2 card", async () => {
  const edits: MessageEditOptions[] = [];
  const message = { id: "v2", edit: async (options: MessageEditOptions) => {
    assert.ok(!options.embeds?.length);
    edits.push(options);
  } } as unknown as Message;
  const progress = new DiscordProgress(message, "Updating without embeds");
  progress.enableStopButton();
  await nextTick();
  await progress.close();
  assert.equal(edits.length, 1);
  assertV2(edits[0]);
  assert.equal(edits[0].content, null, "clear the original acknowledgement when upgrading it");
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
  // Reasoning rides its own private channel: it reaches the owner-only
  // details panel but never becomes a public update or a spend figure.
  const thinking = updates.find((update) => update.kind === "thinking");
  assert.equal(thinking?.text, "PRIVATE_REASONING_TEST_MARKER");
  assert.equal(thinking?.narrationId, "reasoning");
  assert.equal(updates.some((update) => update.kind === "thought" && update.text.includes("PRIVATE_REASONING")), false);
  assert.doesNotMatch(JSON.stringify(updates.filter((update) => update.kind !== "thinking")), /12345|"cost"/);
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

test("an upstream blip gets quick nudges before the turn fails onto the failover model", async () => {
  const { config } = await import("../src/config.js");
  const originalNudges = config.opencodeBlipNudges;
  const originalFailover = [...config.opencodeFailoverModels];
  (config as { opencodeBlipNudges: number }).opencodeBlipNudges = 2;
  (config as { opencodeFailoverModels: string[] }).opencodeFailoverModels = ["other/backup"];
  try {
    const harness = new OpenCodeHarness();
    const stub = harness as unknown as {
      startEventStream: () => Promise<never>;
      client: { session: { prompt: (options: unknown) => Promise<unknown>; messages: () => Promise<unknown[]> } };
    };
    stub.startEventStream = async () => { throw new Error("no stream in test"); };
    stub.client.session.messages = async () => [];
    let sends = 0;
    stub.client.session.prompt = async () => {
      sends += 1;
      if (sends === 1) throw new Error("provider request failed: 503 upstream overloaded");
      return { data: { parts: [{ type: "text", text: "arena built" }] } };
    };
    const updates: string[] = [];
    const result = await harness.prompt("/w", "session", "Build the arena", undefined, (update) => updates.push(update.text));
    assert.match(result.text, /arena built/);
    assert.equal(sends, 2, "one nudge recovered the turn instead of failing it");
    assert.ok(updates.some((text) => /nudging it again/.test(text)), "the nudge is visible on the card");

    // Zero nudges restores the old fail-fast behavior.
    (config as { opencodeBlipNudges: number }).opencodeBlipNudges = 0;
    const disabled = new OpenCodeHarness();
    const disabledStub = disabled as unknown as {
      startEventStream: () => Promise<never>;
      client: { session: { prompt: (options: unknown) => Promise<unknown>; messages: () => Promise<unknown[]> } };
    };
    disabledStub.startEventStream = async () => { throw new Error("no stream in test"); };
    disabledStub.client.session.messages = async () => [];
    let disabledSends = 0;
    disabledStub.client.session.prompt = async () => {
      disabledSends += 1;
      throw new Error("provider request failed: 503 upstream overloaded");
    };
    await assert.rejects(disabled.prompt("/w", "session", "Build"), /upstream/);
    assert.equal(disabledSends, 1, "nudging disabled sends exactly once");

    // A persistent blip exhausts the budget, then marks the error for the backup model.
    (config as { opencodeBlipNudges: number }).opencodeBlipNudges = 1;
    const failing = new OpenCodeHarness();
    const failingStub = failing as unknown as {
      startEventStream: () => Promise<never>;
      client: { session: { prompt: (options: unknown) => Promise<unknown>; messages: () => Promise<unknown[]> } };
    };
    failingStub.startEventStream = async () => { throw new Error("no stream in test"); };
    failingStub.client.session.messages = async () => [];
    let attempts = 0;
    failingStub.client.session.prompt = async () => {
      attempts += 1;
      throw new Error("provider request failed: 503 bad gateway");
    };
    let failure!: Error & { providerHint?: string; providerBlip?: { reason: string } };
    try { await failing.prompt("/w", "session", "Build"); } catch (error) { failure = error as typeof failure; }
    assert.equal(attempts, 2, "the configured nudge budget ran before failing");
    assert.equal(failure.providerHint, "Provider upstream error");
    assert.equal(failure.providerBlip?.reason, "upstream error");
    assert.equal(harness.failoverModelForError(failure, "main/model"), "other/backup", "a persistent blip hands off to the backup model");
    assert.equal(harness.failoverModelForError(new Error("401 unauthorized"), "main/model"), undefined, "auth errors never fail over");
    assert.equal(harness.failoverModelForError(new Error("fetch failed: connection reset"), "main/model"), undefined, "transport errors follow reconciliation instead");
    assert.equal(harness.failoverModelForError(new Error("provider request failed: 503 once"), "main/model"), undefined, "an unmarked blip has not exhausted its nudges yet");
  } finally {
    (config as { opencodeBlipNudges: number }).opencodeBlipNudges = originalNudges;
    (config as { opencodeFailoverModels: string[] }).opencodeFailoverModels = originalFailover;
  }
});

test("the admin-set failover list overrides the configured one", async () => {
  const harness = new OpenCodeHarness();
  const error = new Error("provider request failed: 503 bad gateway") as Error & { providerBlip: { reason: string } };
  error.providerBlip = { reason: "upstream error" };
  harness.failoverModelSource = () => ["cmd/set-model"];
  assert.equal(harness.failoverModelForError(error, "main/model"), "cmd/set-model", "the command-set list wins over the environment");
  harness.failoverModelSource = () => null;
  assert.equal(harness.failoverModelForError(error, "main/model"), undefined, "null falls back to the configured list, which is empty here");
  harness.failoverModelSource = () => ["cmd/set-model", "main/other"];
  assert.equal(harness.failoverModelForError(error, "main/model"), "cmd/set-model", "the model just attempted is never retried");
});

test("public narration evicts old entries and updates streamed parts without growing the history", async () => {
  const progress = new DiscordProgress({ id: "amber", edit: async () => {} } as unknown as Message, "Updating");
  try {
    // Public narration filters incomplete stream fragments; send substantive
    // updates so this actually exercises retention rather than that filter.
    const updates = Array.from({ length: 60 }, (_, index) => ({ kind: "thought" as const,
      text: `Completed layout inspection for section ${index}.`, narrationId: `n${index}` }));
    for (const update of updates) progress.callback(update);
    const narration = progress.readSnapshot().narration!;
    assert.ok(narration.length > 0 && narration.length <= 40, "a chatty turn keeps a bounded, nonempty history");
    assert.deepEqual(narration.map((entry) => entry.key), updates.slice(-narration.length).map((update) => update.narrationId),
      "eviction retains the newest entries in order");

    const continued = { ...updates.at(-1)!, text: `${updates.at(-1)!.text} Verified its keyboard controls.` };
    progress.callback(continued);
    const streamed = progress.readSnapshot().narration!;
    assert.equal(streamed.length, narration.length, "continuing one streamed part does not add another entry");
    assert.equal(streamed.at(-1)?.text, continued.text);
    assert.deepEqual(streamed.slice(0, -1), narration.slice(0, -1));
  } finally { await progress.close(); }
});
