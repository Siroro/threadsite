import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import type { OpenCodeClient, SessionMessageInfo } from "@opencode/client";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const { OpenCodeV2Harness } = await import("../src/opencode-v2.js");
const { applicationMessage } = await import("../src/opencode-v2-messages.js");
const { usageFromMessages, isTerminalAssistant } = await import("../src/opencode-v1.js");
const { config } = await import("../src/config.js");

function fixture() {
  const session: any = { id: "ses_root", location: { directory: "/w" }, agent: "sitebuilder",
    model: { providerID: "test", id: "text", variant: "high" }, permissions: [] };
  const history: SessionMessageInfo[] = [];
  const calls: Array<{ name: string; input: any }> = [];
  let active = false;
  let inbox: any[] = [];
  let forms: any[] = [];
  const client: any = {
    plugin: { list: async () => ({ data: [{ id: "threadsite.v2", state: { status: "active" } }] }) },
    model: { list: async () => ({ data: [
      { id: "text", providerID: "test", enabled: true, status: "active", capabilities: { input: ["text", "pdf"] }, limit: { context: 12345 } },
      { id: "vision", providerID: "test", enabled: true, status: "active", capabilities: { input: ["text", "image"] }, limit: { context: 23456 } },
    ] }) },
    session: {
      get: async () => session,
      active: async () => active ? { ses_root: { type: "running" } } : {},
      list: async () => ({ data: [session], cursor: {} }),
      update: async (input: any) => { calls.push({ name: "update", input }); session.permissions = input.permissions; },
      switchAgent: async (input: any) => { session.agent = input.agent; },
      switchModel: async (input: any) => { calls.push({ name: "model", input }); session.model = input.model; },
      prompt: async (input: any) => {
        calls.push({ name: "prompt", input });
        history.push({ id: input.id, type: "user", text: input.text, time: { created: Date.now() } });
        history.push(assistant("msg_step", 100, "Done"));
        history.push({ type: "idle", id: "msg_idle", outcome: "succeeded", time: { created: Date.now() + 1 } });
        return { id: input.id };
      },
      synthetic: async (input: any) => { calls.push({ name: "steer", input }); },
      interrupt: async (input: any) => { calls.push({ name: "interrupt", input }); active = false; return { interrupted: true }; },
      inbox: { list: async () => inbox, cancel: async (input: any) => { calls.push({ name: "cancel", input }); inbox = inbox.filter((item) => item.id !== input.inboxID); } },
      form: { list: async () => forms, reply: async (input: any) => { calls.push({ name: "answer", input }); },
        cancel: async (input: any) => { calls.push({ name: "cancelForm", input }); forms = forms.filter((form) => form.id !== input.formID); } },
      revert: { stage: async (input: any) => { calls.push({ name: "stage", input }); }, commit: async (input: any) => { calls.push({ name: "commit", input }); } },
      remove: async (input: any) => { calls.push({ name: "remove", input }); },
    },
    message: { list: async () => ({ data: [...history].reverse(), cursor: {} }) },
    form: { list: async () => ({ data: forms }) },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      if (!signal.aborted) await once(signal, "abort");
    } },
  };
  const harness = new OpenCodeV2Harness(client as OpenCodeClient);
  return { harness, client, session, history, calls, setActive: (value: boolean) => { active = value; },
    setInbox: (value: any[]) => { inbox = value; }, setForms: (value: any[]) => { forms = value; } };
}

function assistant(id: string, input: number, text: string): SessionMessageInfo {
  return { type: "assistant", id, agent: "sitebuilder", model: { id: "text", providerID: "test" },
    time: { created: Date.now(), completed: Date.now() }, finish: "stop", content: [{ type: "text", text }],
    tokens: { input, output: 10, reasoning: 2, cache: { read: 20, write: 0 } }, cost: 0.01 };
}

test("native v2 prompt sends files, model variant and permissions separately and returns saved billing", async () => {
  const f = fixture();
  const result = await f.harness.prompt("/w", "ses_root", "Build", "test/vision", undefined, "sitebuilder", "high",
    [{ mime: "image/png", dataUrl: "data:image/png;base64,AAAA", filename: "sample.png" }]);
  assert.equal(result.text, "Done");
  assert.equal(result.usage.inputTokens, 120);
  assert.equal(result.usage.outputTokens, 12);
  assert.equal(result.usage.contextLimit, 23456);
  assert.deepEqual(f.calls.find((call) => call.name === "model")?.input.model, { id: "vision", providerID: "test", variant: "high" });
  const prompt = f.calls.find((call) => call.name === "prompt")!.input;
  assert.deepEqual(prompt.files, [{ uri: "data:image/png;base64,AAAA", name: "sample.png" }]);
  assert.equal(prompt.model, undefined, "v2 model selection is a session operation");
  assert.equal(f.session.permissions.find((rule: any) => rule.action === "threadsite_browser").effect, "allow");
});

test("a lost submission reply reconciles the persisted input without submitting twice", async () => {
  const f = fixture();
  const send = f.client.session.prompt;
  f.client.session.prompt = async (input: any) => { await send(input); throw new TypeError("fetch failed after server accepted input"); };
  assert.equal((await f.harness.prompt("/w", "ses_root", "Build", "test/text")).text, "Done");
  assert.equal(f.calls.filter((call) => call.name === "prompt").length, 1);
});

test("v2 rejects concurrent turns and never reconfigures an already running session", async () => {
  const f = fixture();
  f.setActive(true);
  await assert.rejects(f.harness.prompt("/w", "ses_root", "Build", "test/text"), (error: any) => error.mayStillBeRunning === true);
  assert.deepEqual(f.calls, []);
});

test("unknown and text-only models remove browser access on every turn", async () => {
  for (const model of ["test/text", "test/missing"]) {
    const f = fixture();
    await f.harness.prompt("/w", "ses_root", "Build", model);
    assert.equal(f.session.permissions.find((rule: any) => rule.action === "threadsite_browser").effect, "deny");
    assert.equal(f.session.permissions.find((rule: any) => rule.action === "playwright_*").effect, "deny");
  }
});

test("steering uses native non-resuming delivery and preserves the running variant", async () => {
  const f = fixture();
  assert.equal(await f.harness.steer("/w", "ses_root", "Finish"), false);
  f.setActive(true);
  assert.equal(await f.harness.steer("/w", "ses_root", "Finish"), true);
  const input = f.calls.find((call) => call.name === "steer")!.input;
  assert.equal(input.resume, false);
  assert.equal(input.delivery, "steer");
  assert.equal(input.model, undefined);
  assert.equal(f.session.model.variant, "high");
});

test("stopping cancels queued inputs and questions before interrupting without resume", async () => {
  const f = fixture();
  f.setActive(true);
  f.setInbox([{ id: "msg_pending" }]);
  f.setForms([{ id: "frm_question" }]);
  assert.equal(await f.harness.abortTurn("/w", "ses_root"), true);
  assert.deepEqual(f.calls.map((call) => call.name), ["cancel", "cancelForm", "interrupt"]);
  assert.equal(f.calls.at(-1)!.input.resume, false);
  assert.equal(await f.harness.steer("/w", "ses_root", "Do more"), false);
});

test("session ownership is verified before a mutation and revert leaves workspace Git to the harness", async () => {
  const f = fixture();
  await assert.rejects(f.harness.revertSession("/other", "ses_root", "msg_user"), /different project/);
  assert.deepEqual(f.calls, []);
  await f.harness.revertSession("/w", "ses_root", "msg_user");
  assert.equal(f.calls[0].input.files, false);
  assert.deepEqual(f.calls.map((call) => call.name), ["stage", "commit"]);
});

test("native forms survive reattachment and Discord option labels map back to values", async () => {
  const f = fixture();
  f.setForms([{ id: "frm_question", sessionID: "ses_root", title: "Choose", fields: [
    { key: "q0", type: "string", title: "Palette", description: "Which palette?", options: [{ value: "warm", label: "Warm colours" }] },
    { key: "q1", type: "multiselect", title: "Modes", options: [{ value: "solo", label: "Solo" }] },
  ] }]);
  const questions = await f.harness.listPendingQuestions("/w");
  assert.equal(questions[0].questions[0].question, "Which palette?");
  assert.equal(questions[0].questions[1].multiple, true);
  await f.harness.replyToQuestion("/w", "frm_question", [["Warm colours"], ["Solo"]]);
  assert.deepEqual(f.calls[0].input.answer, { q0: "warm", q1: ["solo"] });
});

test("execution records distinguish completed turns from intermediate assistant stops", () => {
  const message = applicationMessage(assistant("msg_step", 50, "Intermediate"), "ses_root");
  assert.equal(isTerminalAssistant(message.info, { since: 0, agent: "sitebuilder" }), false);
  const idle = applicationMessage({ type: "idle", id: "msg_idle", outcome: "succeeded", time: { created: Date.now() } }, "ses_root");
  assert.equal(isTerminalAssistant(idle.info, { since: 0, agent: "sitebuilder" }), true);
  const interrupted = applicationMessage({ type: "idle", id: "msg_idle", outcome: "interrupted", time: { created: Date.now() } }, "ses_root");
  assert.equal(isTerminalAssistant(interrupted.info, { since: 0, agent: "sitebuilder" }), false);
});

test("every persisted v2 model step is billed once, including child usage", async () => {
  const f = fixture();
  const root = [assistant("msg_a", 100, "Step A"), assistant("msg_b", 200, "Step B")];
  const child = [assistant("msg_c", 300, "Child")];
  f.client.session.list = async () => ({ data: [f.session, { ...f.session, id: "ses_child", parentID: "ses_root" }], cursor: {} });
  f.client.message.list = async ({ sessionID }: any) => ({ data: sessionID === "ses_child" ? child : root, cursor: {} });
  const messages = await f.harness.usageMessages("/w", "ses_root");
  const usage = usageFromMessages([...messages, ...messages]);
  assert.equal(usage?.steps, 3);
  assert.equal(usage?.inputTokens, 660);
  assert.equal(usage?.outputTokens, 36);
});

test("root finish-up budget counts persisted steps and sends a single non-resuming receipt", async () => {
  const f = fixture();
  const oldLimit = config.opencodeMaxSteps;
  config.opencodeMaxSteps = 10;
  f.setActive(true);
  f.history.push(...Array.from({ length: 9 }, (_, i) => assistant(`msg_${i}`, 1, "work")));
  try {
    const stop = await f.harness.watchExistingTurn("/w", "ses_root", undefined, Date.now() - 1000);
    for (let i = 0; i < 20 && !f.calls.some((call) => call.name === "steer"); i++) await new Promise((resolve) => setImmediate(resolve));
    const steers = f.calls.filter((call) => call.name === "steer");
    assert.equal(steers.length, 1);
    assert.match(steers[0].input.text, /^\[THREADSITE_FORCE_FINISH\]/);
    assert.equal(steers[0].input.resume, false);
    await stop();
  } finally { config.opencodeMaxSteps = oldLimit; }
});

test("native pagination follows the cursor without resending order and recovers history beyond one page", async () => {
  const f = fixture();
  const pages: any[] = [];
  f.client.message.list = async (input: any) => {
    pages.push(input);
    if (!input.cursor) return { data: [assistant("msg_latest", 200, "Latest")], cursor: { next: "older-page" } };
    assert.equal(input.order, undefined, "the native API rejects cursor plus order");
    return { data: [assistant("msg_older", 100, "Older")], cursor: {} };
  };
  const messages = await f.harness.usageMessages("/w", "ses_root");
  assert.equal(messages.length, 2);
  assert.equal(pages.length, 2);
  assert.equal(usageFromMessages(messages)?.inputTokens, 340);
});

test("status heartbeats cannot extend a stalled turn, and failed interruption preserves uncertainty", async () => {
  const original = { poll: config.opencodeReconcilePollMs, timeout: config.opencodeReconcileTimeoutMs };
  config.opencodeReconcilePollMs = 2;
  config.opencodeReconcileTimeoutMs = 12;
  try {
    const f = fixture();
    let submissions = 0;
    const updates: any[] = [];
    f.client.session.prompt = async () => { submissions++; f.setActive(true); return {}; };
    f.client.session.interrupt = async () => { throw new TypeError("fetch failed"); };
    await assert.rejects(f.harness.prompt("/w", "ses_root", "Work", "test/text", (update) => { updates.push(update); }), (error: any) =>
      /timed out without progress/.test(error.message) && error.mayStillBeRunning === true);
    assert.equal(submissions, 1);
    const busyBeats = updates.filter((update) => update.kind === "heartbeat" && update.active);
    assert.ok(busyBeats.length > 0, "the reconcile poll still reports the busy flag");
    assert.ok(busyBeats.every((update) => !update.text), "a busy poll heartbeat carries no display text that could bury the activity line");
  } finally { config.opencodeReconcilePollMs = original.poll; config.opencodeReconcileTimeoutMs = original.timeout; }
});

test("a pending native question pauses inactivity until the user answers", async () => {
  const original = { poll: config.opencodeReconcilePollMs, timeout: config.opencodeReconcileTimeoutMs };
  config.opencodeReconcilePollMs = 2;
  config.opencodeReconcileTimeoutMs = 12;
  try {
    const f = fixture();
    const complete = f.client.session.prompt;
    let answerTimer: NodeJS.Timeout;
    f.client.session.prompt = async (input: any) => {
      f.setActive(true);
      f.setForms([{ id: "frm_pending", sessionID: "ses_root", title: "Choose", fields: [{ key: "q0", type: "string", title: "Choose" }] }]);
      answerTimer = setTimeout(async () => { f.setForms([]); await complete(input); f.setActive(false); }, 40);
      return { id: input.id };
    };
    try { assert.equal((await f.harness.prompt("/w", "ses_root", "Work", "test/text")).text, "Done"); }
    finally { clearTimeout(answerTimer!); }
    assert.ok(!f.calls.some((call) => call.name === "interrupt"));
  } finally { config.opencodeReconcilePollMs = original.poll; config.opencodeReconcileTimeoutMs = original.timeout; }
});

test("persisted finish-up receipts prevent repeat steering after a restart, even beyond 100 steps", async () => {
  const f = fixture();
  const now = Date.now();
  f.setActive(true);
  f.history.push({ id: "msg_real_user", type: "user", text: "Build", time: { created: now - 500 } });
  f.history.push(...Array.from({ length: 185 }, (_, i) => assistant(`msg_${i}`, 1, "Work")));
  f.history.push({ id: "msg_receipt", type: "synthetic", text: "[THREADSITE_FORCE_FINISH]\nFinish now", time: { created: now + 1 } });
  const stop = await f.harness.watchExistingTurn("/w", "ses_root", undefined, now - 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.filter((call) => call.name === "steer").length, 0);
  assert.equal(await f.harness.lastUserMessageId("/w", "ses_root"), "msg_real_user", "synthetic steering is not the user's undo boundary");
  await stop();
});

test("a failed native runtime plugin prevents every prompt and mutation", async () => {
  const f = fixture();
  f.client.plugin.list = async () => ({ data: [{ id: "threadsite.v2", state: { status: "failed", error: "bad plugin" } }] });
  await assert.rejects(f.harness.prompt("/w", "ses_root", "Build", "test/text"), /runtime plugin is unavailable/);
  assert.deepEqual(f.calls, []);
});

test("native session removal stops descendants before a cascading parent delete", async () => {
  const f = fixture();
  const sessions = new Map([
    ["ses_root", f.session], ["ses_child", { ...f.session, id: "ses_child", parentID: "ses_root" }],
  ]);
  f.client.session.get = async ({ sessionID }: any) => {
    if (!sessions.has(sessionID)) throw new Error("Session not found");
    return sessions.get(sessionID);
  };
  f.client.session.remove = async ({ sessionID }: any) => {
    f.calls.push({ name: "remove", input: { sessionID } });
    sessions.delete(sessionID);
    if (sessionID === "ses_root") sessions.delete("ses_child");
  };
  await (f.harness as any).sweep([
    { id: "ses_root", directory: "/w" }, { id: "ses_child", directory: "/w", parentID: "ses_root" },
  ]);
  assert.deepEqual(f.calls.map((call) => call.input.sessionID), ["ses_child", "ses_root"]);
  f.client.session.remove = async () => { throw new Error("403 permission denied"); };
  sessions.set("ses_root", f.session);
  await assert.rejects((f.harness as any).sweep([{ id: "ses_root", directory: "/w" }]), /403/);
});

test("a native user interruption cannot be resurrected by steering or the recovery watcher", async () => {
  const f = fixture();
  f.setActive(true);
  const stop = await f.harness.watchExistingTurn("/w", "ses_root");
  const internal = f.harness as any;
  internal.event({ type: "session.execution.interrupted", data: { sessionID: "ses_root", reason: "user" } },
    "/w", "ses_root", internal.watches.get("ses_root"));
  assert.equal(await f.harness.steer("/w", "ses_root", "Continue"), false);
  await stop();
  assert.ok(!f.calls.some((call) => call.name === "steer"));
});

test("a queued compaction is successful only when its persisted result succeeds", async () => {
  const f = fixture();
  f.client.session.compact = async () => {
    f.history.push({ type: "compaction", id: "msg_compaction", status: "failed", reason: "manual", time: { created: Date.now() },
      error: { type: "compaction.failed", message: "Summary did not match the required template" } });
    return {};
  };
  f.client.session.wait = async () => {};
  await assert.rejects(f.harness.compactSession("/w", "ses_root", "test", "text"), /compaction failed.*required template/);
});

test("tool events carry rich labels, file targets and subagent attribution", async () => {
  const f = fixture();
  f.setActive(true);
  const updates: any[] = [];
  const stop = await f.harness.watchExistingTurn("/w", "ses_root", (update) => { updates.push(update); });
  try {
    const internal = f.harness as any;
    const watch = internal.watches.get("ses_root");
    const send = (type: string, data: object) => internal.event({ type, created: Date.now(), data: {
      sessionID: "ses_root", ...data } }, "/w", "ses_root", watch, (update: any) => { updates.push(update); });
    send("session.tool.input.started", { id: "tool_edit", name: "edit" });
    send("session.tool.called", { id: "tool_edit", input: { filePath: "/w/site/src/main.ts" } });
    send("session.tool.success", { id: "tool_edit" });
    send("session.tool.input.started", { id: "tool_shell", name: "shell" });
    send("session.tool.called", { id: "tool_shell", input: { command: "node scripts/build.js" } });
    send("session.tool.failed", { id: "tool_shell", error: "exit 1" });
    // A subagent child session attributes its tools and finishes with one public summary line.
    internal.event({ type: "session.created", created: Date.now(), data: { sessionID: "ses_child", parentID: "ses_root" } },
      "/w", "ses_root", watch, (update: any) => { updates.push(update); });
    const childSend = (type: string, data: object) => internal.event({ type, created: Date.now(), data: {
      sessionID: "ses_child", ...data } }, "/w", "ses_root", watch, (update: any) => { updates.push(update); });
    childSend("session.tool.input.started", { id: "tool_web", name: "websearch" });
    childSend("session.tool.called", { id: "tool_web", input: {} });
    childSend("session.tool.success", { id: "tool_web" });
    childSend("session.text.ended", { assistantMessageID: "msg_child", ordinal: 0, text: "Researched arena layouts." });
    childSend("session.text.delta", { assistantMessageID: "msg_child2", ordinal: 0, delta: "still streaming" });
    const tools = updates.filter((update) => update.tool);
    assert.deepEqual(tools.map((update) => update.tool.status), ["running", "completed", "running", "error", "running", "completed"]);
    assert.deepEqual(tools.map((update) => update.text), [
      "✏️ Editing", "✅ Edited",
      "⚙️ Running a command", "⚠️ Shell hit an error",
      "🤖 Subagent — 🔎 Searching the web", "🤖 Subagent — 🔎 Web research gathered",
    ]);
    assert.match(tools[0].detail ?? "", /site\/src\/main\.ts$/);
    assert.equal(tools[2].detail, "node scripts/build.js");
    // Only the finished child message goes public; streamed child deltas never render.
    assert.deepEqual(updates.filter((update) => !update.tool && update.text?.startsWith("🤖 Subagent:")).map((update) => update.text),
      ["🤖 Subagent: Researched arena layouts."]);
  } finally { await stop(); }
});

test("native text and reasoning with the same ordinal never share streamed buffers or public narration", async () => {
  const f = fixture();
  f.setActive(true);
  const updates: any[] = [];
  const stop = await f.harness.watchExistingTurn("/w", "ses_root", (update) => { updates.push(update); });
  try {
    const internal = f.harness as any;
    const watch = internal.watches.get("ses_root");
    const send = (type: string, content: object) => internal.event({ type, created: Date.now(), data: {
      sessionID: "ses_root", assistantMessageID: "msg_stream", ordinal: 0, ...content,
    } }, "/w", "ses_root", watch, (update: any) => { updates.push(update); });
    send("session.reasoning.delta", { delta: "Private reasoning." });
    send("session.reasoning.ended", { text: "Private reasoning." });
    send("session.text.delta", { delta: "Public" });
    send("session.reasoning.delta", { delta: " Still private." });
    send("session.text.delta", { delta: " update." });
    send("session.text.ended", { text: "Public update." });
    const narration = updates.filter((update) => update.kind === "thought");
    assert.deepEqual(narration.map((update) => update.text), ["Public", "Public update."]);
    assert.ok(updates.some((update) => update.kind === "thinking" && update.text === "Private reasoning. Still private."));
    assert.notEqual(narration[0].narrationId, updates.find((update) => update.kind === "thinking").narrationId);
  } finally { await stop(); }
});

test("average tok/s uses opencode's streamed windows: retries re-anchor and unstreamed steps withhold the rate", async () => {
  const f = fixture();
  f.setActive(true);
  const stop = await f.harness.watchExistingTurn("/w", "ses_root");
  try {
    const internal = f.harness as any;
    const watch = internal.watches.get("ses_root");
    const send = (type: string, created: number, content: object) => internal.event({ type, created, data: {
      sessionID: "ses_root", ...content } }, "/w", "ses_root", watch);
    const model = { id: "text", providerID: "test" };
    const tokens = { input: 100, output: 400, reasoning: 100, cache: { read: 0, write: 0 } };
    send("session.step.started", 1_000, { assistantMessageID: "msg_a", model, started: 1_000 });
    send("session.step.streamed", 5_000, { assistantMessageID: "msg_a" });
    send("session.step.ended", 5_050, { assistantMessageID: "msg_a", finish: "stop", cost: 0.01, tokens });
    send("session.step.started", 10_000, { assistantMessageID: "msg_b", model, started: 10_000 });
    send("session.step.streamed", 14_000, { assistantMessageID: "msg_b" });
    // A retried step re-anchors: the first streamed window is discarded and only
    // the post-retry generation counts, exactly like opencode's message updater.
    send("session.step.started", 20_000, { assistantMessageID: "msg_b", model, started: 20_000 });
    send("session.step.streamed", 21_000, { assistantMessageID: "msg_b" });
    send("session.step.ended", 21_010, { assistantMessageID: "msg_b", finish: "stop", cost: 0.01,
      tokens: { ...tokens, output: 50, reasoning: 0 } });
    const usage = await internal.finalUsage("/w", "ses_root", 0, new Set(), watch);
    assert.equal(usage.generationMs, 5_000);
    assert.equal(usage.timedOutputTokens, 550);
    assert.equal(usage.outputTokensPerSecond, 110);
    // A step that failed before streaming withholds the average instead of
    // letting the timed steps overstate the turn's rate.
    send("session.step.started", 30_000, { assistantMessageID: "msg_c", model, started: 30_000 });
    send("session.step.failed", 31_000, { assistantMessageID: "msg_c", error: { message: "provider unavailable" } });
    const withheld = await internal.finalUsage("/w", "ses_root", 0, new Set(), watch);
    assert.equal(withheld.outputTokensPerSecond, undefined);
  } finally { await stop(); }
});

test("persisted streamed windows rate the turn even when live events were never seen", async () => {
  const f = fixture();
  const now = Date.now();
  const step = (id: string, created: number, streamed: number, output: number): SessionMessageInfo => ({
    type: "assistant", id, agent: "sitebuilder", model: { id: "text", providerID: "test" },
    time: { created, streamed, completed: streamed + 10 }, finish: "stop", content: [],
    tokens: { input: 100, output, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.01 } as SessionMessageInfo);
  f.history.push(step("msg_p1", now, now + 2_000, 300));
  f.history.push(step("msg_p2", now + 3_000, now + 4_000, 50));
  const internal = f.harness as any;
  const usage = await internal.finalUsage("/w", "ses_root", now - 1, new Set(), {
    since: now - 1, baseline: new Set(), steps: new Map(), generationMs: 0, timedOutputTokens: 0, timedSteps: 0, compactions: 0 });
  assert.equal(usage.generationMs, 3_000);
  assert.equal(usage.timedOutputTokens, 350);
  assert.equal(usage.outputTokensPerSecond, 350 / 3);
});

test("session status beats carry the busy flag without claiming the activity line", async () => {
  const f = fixture();
  f.setActive(true);
  const updates: any[] = [];
  const stop = await f.harness.watchExistingTurn("/w", "ses_root", (update) => { updates.push(update); });
  try {
    const internal = f.harness as any;
    const watch = internal.watches.get("ses_root");
    const send = (type: string, content: object) => internal.event({ type, created: Date.now(), data: {
      sessionID: "ses_root", ...content } }, "/w", "ses_root", watch, (update: any) => { updates.push(update); });
    send("session.text.delta", { assistantMessageID: "msg_n", ordinal: 0, delta: "Composing the hero section" });
    // The status stream repeats on every event; its beats must stay textless so
    // the streamed activity keeps the headline after a reconnect reattaches.
    for (let i = 0; i < 3; i++) send("session.status", { status: { type: "busy" } });
    const beats = updates.filter((update) => update.kind === "heartbeat");
    assert.equal(beats.length, 3);
    assert.ok(beats.every((update) => !update.text), "status beats never carry display text");
    assert.ok(beats.every((update) => update.active === true), "the busy flag still lands");
  } finally { await stop(); }
});
