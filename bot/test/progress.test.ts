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
const { OpenCodeHarness } = await import("../src/opencode.js");

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

test("a closed turn drops live subagent lines but keeps the recorded roster for details", async () => {
  const progress = new DiscordProgress({ id: "roster", edit: async () => {} } as unknown as Message, "Updating");
  try {
    progress.callback({ kind: "heartbeat", text: "", activeSubagents: 1, subagents: [{ id: "ses_child", agent: "explore", steps: 3, status: "running" }],
      subagentHistory: [{ id: "ses_child", agent: "explore", steps: 3, status: "running" }] });
    const running = progress.readSnapshot();
    assert.equal(running.subagents?.length, 1);
    assert.equal(running.subagentHistory?.length, 1);
    await progress.close();
    const closed = progress.readSnapshot();
    assert.equal(closed.activeSubagents, 0);
    assert.equal(closed.subagents, undefined, "no child is live after the turn closes");
    assert.equal(closed.subagentHistory?.length, 1, "the finished roster stays stored for turn details");
  } finally { await progress.close(); }
});

test("the admin-set failover list overrides the configured one", async () => {
  const harness = new OpenCodeHarness();
  const error = new Error("provider request failed: 503 bad gateway") as Error & { providerBlip: boolean };
  error.providerBlip = true;
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
