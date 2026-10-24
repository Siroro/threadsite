import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import type { OpenCodeClient, SessionMessageInfo } from "@opencode/client";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const { OpenCodeV2Harness } = await import("../src/opencode-v2.js");
const { applicationMessage } = await import("../src/opencode-v2-messages.js");
const { usageFromMessages, isTerminalAssistant } = await import("../src/opencode-shared.js");
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
      update: async (input: any) => { calls.push({ name: "update", input }); Object.assign(session,
        input.permissions ? { permissions: input.permissions } : {}, input.metadata ? { metadata: input.metadata } : {}); },
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

test("model capabilities and cache entries belong to the requested workspace", async () => {
  const f = fixture();
  const queried: Array<string | undefined> = [];
  f.client.model.list = async (input: any) => {
    queried.push(input.location?.directory);
    return { data: [{ id: "vision", providerID: "test", enabled: true, status: "active",
      capabilities: { input: input.location?.directory === "/vision" ? ["text", "image"] : ["text"] } }] };
  };
  assert.equal(await f.harness.modelAcceptsAttachments("test", "vision"), false);
  assert.equal(await f.harness.modelAcceptsAttachments("test", "vision", "/vision"), true);
  assert.equal(await f.harness.modelAcceptsAttachments("test", "vision", "/text"), false);
  assert.equal(await f.harness.modelAcceptsAttachments("test", "missing", "/vision"), undefined);
  assert.equal(await f.harness.modelAcceptsAttachments("test", "vision", "/vision"), true);
  assert.deepEqual(queried, [undefined, "/vision", "/text"]);
});

test("model switches refresh browser permissions on the same persistent session", async () => {
  const f = fixture();
  const send = f.client.session.prompt;
  let turn = 0;
  f.client.session.prompt = async (input: any) => {
    await send(input);
    for (const message of f.history.slice(-2)) message.id += `_${++turn}`;
  };
  const offered: string[] = [];
  for (const model of ["test/vision", "test/text", "test/missing", "test/vision"]) {
    await f.harness.prompt("/w", "ses_root", "Build", model);
    offered.push(f.session.permissions.find((rule: any) => rule.action === "threadsite_browser").effect);
  }
  assert.deepEqual(offered, ["allow", "deny", "deny", "allow"]);
  assert.equal(await f.harness.modelAcceptsAttachments("test", "text"), false);
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

function backgroundQa(): SessionMessageInfo {
  return { ...assistant("msg_qa_start", 100, ""), content: [{ type: "tool", id: "call_qa", name: "subagent",
    time: { created: Date.now(), completed: Date.now() }, state: { status: "completed",
      input: { agent: "browser-qa", background: true }, output: "QA running",
      metadata: { sessionID: "ses_qa", status: "running" } } }] } as SessionMessageInfo;
}

function qaReceipt(id = "msg_qa_result"): any {
  return { id, type: "synthetic", time: { created: Date.now() }, text: "QA found a clipped button",
    metadata: { source: "subagent", childID: "ses_qa", agent: "browser-qa", state: "completed" } };
}

test("background QA keeps a finished parent turn open until its result is reviewed", async () => {
  const f = fixture();
  const oldPoll = config.opencodeReconcilePollMs;
  config.opencodeReconcilePollMs = 1;
  let submitted = false;
  let polls = 0;
  f.client.session.prompt = async (input: any) => {
    f.calls.push({ name: "prompt", input });
    f.history.push({ id: input.id, type: "user", text: input.text, time: { created: Date.now() } }, backgroundQa(),
      assistant("msg_independent", 100, "Independent edits finished"),
      { id: "msg_parent_idle", type: "idle", outcome: "succeeded", time: { created: Date.now() } });
    submitted = true;
  };
  f.client.session.active = async () => {
    if (submitted) {
      polls++;
      if (polls === 2) f.history.push(qaReceipt());
      if (polls === 4) f.history.push(assistant("msg_review", 100, "QA reviewed"),
        { id: "msg_review_idle", type: "idle", outcome: "succeeded", time: { created: Date.now() } });
    }
    return {};
  };
  try {
    const result = await f.harness.prompt("/w", "ses_root", "Build", "test/text");
    assert.equal(result.text, "QA reviewed", "an old idle marker cannot finish a turn after a new QA result");
    assert.ok(polls >= 4);
    assert.equal(f.calls.filter((call) => call.name === "prompt").length, 1, "waiting must not submit another builder prompt");
  } finally { config.opencodeReconcilePollMs = oldPoll; }
});

test("pending QA remains busy across the native completion-notification gap", async () => {
  const f = fixture();
  f.history.push(backgroundQa());
  assert.equal(await f.harness.isBusy("/w", "ses_root"), true, "parent idle and child absent from active is insufficient");
  f.history.push(qaReceipt());
  assert.equal(await f.harness.isBusy("/w", "ses_root"), false);
  f.history.push({ ...backgroundQa(), id: "msg_qa_recheck", time: { created: Date.now() + 10, completed: Date.now() + 11 } });
  assert.equal(await f.harness.isBusy("/w", "ses_root"), true, "a previous report cannot settle a new inspection in the same child session");
});

test("stop drains background QA notifications and durably cancels them before the final parent interrupt", async () => {
  const f = fixture();
  f.history.push(backgroundQa());
  f.session.metadata = { other: "preserved" };
  f.client.session.get = async ({ sessionID }: any) => sessionID === "ses_qa"
    ? { ...f.session, id: "ses_qa", parentID: "ses_root", agent: "browser-qa" } : f.session;
  const interrupt = f.client.session.interrupt;
  f.client.session.interrupt = async (input: any) => {
    if (input.sessionID === "ses_qa") f.setInbox([{ ...qaReceipt(), payload: qaReceipt(), delivery: "queue" }]);
    return interrupt(input);
  };
  assert.equal(await f.harness.abortTurn("/w", "ses_root"), true);
  assert.deepEqual(f.calls.map((call) => call.name), ["interrupt", "update", "cancel", "interrupt"]);
  assert.equal(f.calls[0].input.sessionID, "ses_qa");
  assert.equal(f.calls.at(-1)?.input.sessionID, "ses_root");
  assert.ok(f.calls.filter((call) => call.name === "interrupt").every((call) => call.input.resume === false));
  assert.equal(f.session.metadata.other, "preserved");
  const restarted = new OpenCodeV2Harness(f.client);
  assert.equal(await restarted.isBusy("/w", "ses_root"), false, "a cancelled inbox result must not leave stale QA pending after restart");
  f.history.push({ ...backgroundQa(), id: "msg_qa_after_stop", time: { created: Date.now() + 10, completed: Date.now() + 11 } });
  assert.equal(await restarted.isBusy("/w", "ses_root"), true, "cancellation receipts apply to the old call, not all future QA in that session");
  assert.equal(await f.harness.steer("/w", "ses_root", "Continue"), false);
});

test("stop never interrupts a QA session owned by another parent or workspace", async () => {
  for (const child of [{ parentID: "other", location: { directory: "/w" } },
    { parentID: "ses_root", location: { directory: "/other" } }]) {
    const f = fixture();
    f.history.push(backgroundQa());
    f.client.session.get = async ({ sessionID }: any) => sessionID === "ses_qa" ? { ...f.session, ...child } : f.session;
    await assert.rejects(f.harness.abortTurn("/w", "ses_root"), /different parent|different project/);
    assert.deepEqual(f.calls, []);
  }
});

test("restart recovery wakes the persisted QA receipt only for an attached, unstopped turn", async () => {
  const f = fixture();
  const receipt = qaReceipt();
  f.setInbox([{ id: receipt.id, type: "synthetic", payload: { text: receipt.text, metadata: receipt.metadata }, delivery: "queue" }]);
  assert.equal(await f.harness.isBusy("/w", "ses_root"), true);
  assert.deepEqual(f.calls, [], "status checks without a recovery owner cannot wake a session");
  const stop = await f.harness.watchExistingTurn("/w", "ses_root", undefined, 0);
  try {
    assert.equal(await f.harness.isBusy("/w", "ses_root"), true);
    const resumed = f.calls.find((call) => call.name === "steer")?.input;
    assert.equal(resumed.id, receipt.id, "native admission deduplicates the saved message ID");
    assert.equal(resumed.text, receipt.text);
    assert.equal(resumed.resume, true);
    assert.equal(resumed.model, undefined);
    await f.harness.abortTurn("/w", "ses_root");
    const count = f.calls.filter((call) => call.name === "steer").length;
    assert.equal(await f.harness.isBusy("/w", "ses_root"), false);
    assert.equal(f.calls.filter((call) => call.name === "steer").length, count);
  } finally { await stop(); }
});

test("a long browser QA provider retry cancels only optional inspection and leaves the builder running", async () => {
  const f = fixture();
  f.setActive(true);
  const stop = await f.harness.watchExistingTurn("/w", "ses_root", undefined, 0);
  try {
    const internal = f.harness as any;
    const watch = internal.watches.get("ses_root");
    internal.event({ type: "session.created", data: { sessionID: "ses_qa", parentID: "ses_root", agent: "browser-qa" } }, "/w", "ses_root", watch);
    internal.event({ type: "session.retry.scheduled", data: { sessionID: "ses_qa",
      at: Date.now() + config.opencodeQuotaBlockMinRetryMs + 10_000, error: { message: "QA provider quota exhausted" } } }, "/w", "ses_root", watch);
    assert.equal(watch.quota, undefined, "optional QA does not set the root turn's quota block");
    assert.equal(internal.quotas.size, 0);
    assert.deepEqual(f.calls.filter((call) => call.name === "interrupt").map((call) => call.input), [{ sessionID: "ses_qa", resume: false }]);
    assert.equal(internal.stopped.has("ses_root"), false);
  } finally { await stop(); }
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
  root[0].time = { created: 1_000, streamed: 3_000, completed: 9_000 };
  root[1].time = { created: 20_000, streamed: 22_000, completed: 50_000 };
  child[0].time = { created: 20_000, streamed: 21_000, completed: 22_000 };
  f.client.session.list = async () => ({ data: [f.session, { ...f.session, id: "ses_child", parentID: "ses_root", agent: "explore" }], cursor: {} });
  f.client.message.list = async ({ sessionID }: any) => ({ data: sessionID === "ses_child" ? child : root, cursor: {} });
  const messages = await f.harness.usageMessages("/w", "ses_root");
  const usage = usageFromMessages([...messages, ...messages]);
  assert.equal(usage?.steps, 3);
  assert.equal(usage?.inputTokens, 660);
  assert.equal(usage?.outputTokens, 36);
  const final = await (f.harness as any).finalUsage("/w", "ses_root", 0, new Set(), {
    steps: new Map(), timings: new Map(), compactions: 0 });
  assert.equal(final.timedOutputTokens, 36);
  assert.equal(final.generationMs, 5_000, "overlapping child/provider windows exclude tool execution time");
  assert.equal(final.outputTokensPerSecond, 7.2);
  assert.deepEqual(final.sessions.map((entry: any) => [entry.root ? "root" : entry.agent, entry.steps, entry.inputTokens]),
    [["root", 2, 340], ["explore", 1, 320]],
    "the split attributes root and child steps with the child's agent name");
  assert.deepEqual(final.sessions.map((entry: any) => entry.models?.map((model: any) => model.model)),
    [["test/text"], ["test/text"]], "each session carries the model its steps actually ran");
  assert.equal(final.sessions.reduce((sum: number, entry: any) => sum + entry.inputTokens, 0), final.inputTokens,
    "the split sums to the billed totals");
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

test("root tool events retain their targets while child work stays out of the public activity feed", async () => {
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
    // Child tools and reports belong to the builder, not the public activity feed.
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
    assert.deepEqual(tools.map((update) => update.tool.status), ["running", "completed", "running", "error"]);
    assert.match(tools[0].detail ?? "", /site\/src\/main\.ts$/);
    // Shell activity is the command itself, flagged so service-wait heuristics never match it.
    assert.equal(tools[2].command, true);
    assert.equal(tools[2].detail, undefined);
    assert.ok(!updates.some((update) => /still streaming|Researched arena layouts/.test(update.text)));
  } finally { await stop(); }
});

test("the live card counts executing children and removes the section after all children stop", async () => {
  const { DiscordProgress } = await import("../src/progress.js");
  const { renderProgressCard, renderProgressOverview } = await import("../src/progress-view.js");
  const { cardView, assertV2 } = await import("./fixtures/cards.js");
  const f = fixture();
  f.setActive(true);
  const progress = new DiscordProgress({ id: "subagents", edit: async () => {} } as any, "Updating");
  progress.callback({ text: "Editing the main scene" });
  const stop = await f.harness.watchExistingTurn("/w", "ses_root", progress.callback);
  try {
    const internal = f.harness as any;
    const watch = internal.watches.get("ses_root");
    const send = (id: string, type: string, data: object = {}) => internal.event({ type, created: Date.now(),
      data: { sessionID: id, ...data } }, "/w", "ses_root", watch, progress.callback);
    const initial = progress.readSnapshot();
    const fields = cardView(renderProgressCard(initial)).fields.length;
    send("ses_child", "session.created", { parentID: "ses_root", agent: "browser-qa" });
    assert.equal(progress.readSnapshot().activeSubagents, 0, "an idle saved child is not active");
    send("ses_child", "session.execution.started");
    send("ses_child", "session.status", { status: { type: "busy" } });
    assert.equal(progress.readSnapshot().activeSubagents, 1, "repeat status is not another subagent");
    send("ses_root", "session.status", { status: { type: "idle" } });
    assert.equal(progress.readSnapshot().activeSubagents, 1, "background QA remains active while the parent is idle");
    send("ses_nested", "session.created", { parentID: "ses_child", agent: "explore" });
    send("ses_nested", "session.execution.started");
    send("ses_unrelated", "session.execution.started");
    assert.equal(progress.readSnapshot().activeSubagents, 2, "only descendants count");
    for (const render of [renderProgressCard, renderProgressOverview]) {
      const before = cardView(render(initial));
      const during = render(progress.readSnapshot());
      assertV2(during);
      const added = cardView(during).fields.filter((field) => !before.fields.some((old) => old.name === field.name));
      assert.equal(added.length, 1);
      const lines = added[0].value.split("\n");
      assert.equal(lines.length, 2, "the added section shows one line per live child");
      assert.match(lines[0], /browser-qa/, "the browser-QA child is named on its line");
    }
    send("ses_child", "session.step.ended", { assistantMessageID: "msg_qa", tokens: { input: 1, output: 1, reasoning: 0 }, finish: "tool-calls" });
    assert.equal(progress.readSnapshot().activeSubagents, 2, "a model step ending is not session completion");
    send("ses_child", "session.execution.succeeded");
    assert.equal(progress.readSnapshot().activeSubagents, 1);
    send("ses_nested", "session.execution.failed");
    assert.equal(progress.readSnapshot().activeSubagents, 0);
    assert.equal(cardView(renderProgressCard(progress.readSnapshot())).fields.length, fields);
    send("ses_child", "session.execution.started");
    send("ses_child", "session.execution.interrupted");
    assert.equal(progress.readSnapshot().activeSubagents, 0);
    send("ses_child", "session.execution.started");
    send("ses_child", "session.deleted");
    assert.equal(progress.readSnapshot().activeSubagents, 0);
    assert.deepEqual(progress.readSnapshot().latest, initial.latest, "child presence never replaces the builder's activity");
    assert.deepEqual(progress.readSnapshot().history, initial.history);
  } finally { await stop(); await progress.close(); }
});

test("the subagent lines name each child, its steps and its current tool", async () => {
  const f = fixture();
  f.setActive(true);
  const { DiscordProgress } = await import("../src/progress.js");
  const { renderProgressCard, progressDetailSections } = await import("../src/progress-view.js");
  const { cardView } = await import("./fixtures/cards.js");
  const progress = new DiscordProgress({ id: "subdetail", edit: async () => {} } as any, "Updating");
  const stop = await f.harness.watchExistingTurn("/w", "ses_root", progress.callback);
  try {
    const internal = f.harness as any;
    const watch = internal.watches.get("ses_root");
    const send = (id: string, type: string, data: object = {}) => internal.event({ type, created: Date.now(),
      data: { sessionID: id, ...data } }, "/w", "ses_root", watch, progress.callback);
    send("ses_child", "session.created", { parentID: "ses_root", agent: "explore" });
    send("ses_child", "session.execution.started");
    send("ses_child", "session.step.ended", { assistantMessageID: "c_m1", tokens: { input: 10, output: 5 }, finish: "tool-calls" });
    send("ses_child", "session.step.ended", { assistantMessageID: "c_m2", tokens: { input: 10, output: 5 }, finish: "stop" });
    send("ses_child", "session.step.ended", { assistantMessageID: "c_m2", tokens: { input: 10, output: 5 }, finish: "stop" });
    send("ses_child", "session.tool.input.started", { id: "c_t1", name: "read" });
    send("ses_child", "session.tool.called", { id: "c_t1", input: { filePath: "/w/site/src/arena.ts" } });
    const field = cardView(renderProgressCard(progress.readSnapshot())).fields.find((item) => item.name === "Active subagents")!;
    assert.match(field.value, /\*\*explore\*\*/, "the child's agent is named");
    assert.match(field.value, /2 steps/, "a retried or replayed step counts once");
    assert.match(field.value, /📚 Reading · site\/src\/arena\.ts/, "the child's current tool is shown");
    send("ses_child", "session.execution.succeeded");
    assert.equal(cardView(renderProgressCard(progress.readSnapshot())).fields.some((item) => item.name === "Active subagents"), false,
      "the section leaves when the child finishes");
    // The finished child stays recorded for the turn's details panel.
    const roster = progress.readSnapshot().subagentHistory!;
    assert.equal(roster.length, 1);
    assert.equal(roster[0].status, "finished");
    assert.equal(roster[0].steps, 2);
    const detail = progressDetailSections(progress.readSnapshot()).find((section) => section.key === "subagents");
    assert.match(detail!.text, /\*\*explore\*\* · 2 steps · finished/);
    assert.match(detail!.text, /Last action: 📚 Reading · site\/src\/arena\.ts/);
  } finally { await stop(); await progress.close(); }
});

test("reattachment reconciles active descendants and clears stale counts on status polls and detach", async () => {
  const f = fixture();
  const child = { ...f.session, id: "ses_child", parentID: "ses_root" };
  f.client.session.list = async () => ({ data: [f.session, child,
    { ...child, id: "ses_foreign", location: { directory: "/other" } }], cursor: {} });
  let active: Record<string, unknown> = { ses_child: {}, ses_foreign: {} };
  f.client.session.active = async () => active;
  const updates: any[] = [];
  const stop = await f.harness.watchExistingTurn("/w", "ses_root", (update) => { updates.push(update); });
  try {
    for (let i = 0; i < 50 && !updates.some((update) => update.activeSubagents === 1); i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(updates.filter((update) => update.activeSubagents !== undefined).at(-1)?.activeSubagents, 1);
    active = {};
    await f.harness.isBusy("/w", "ses_root");
    assert.equal(updates.at(-1).activeSubagents, 0, "polling repairs a missed terminal event");
    active = { ses_child: {} };
    await f.harness.isBusy("/w", "ses_root");
    assert.equal(updates.at(-1).activeSubagents, 1);
  } finally { await stop(); }
  assert.equal(updates.at(-1).activeSubagents, 0, "a detached watcher cannot leave a live indicator behind");
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

test("average tok/s pairs streamed windows and tokens: retries re-anchor and untimed steps stay billed", async () => {
  const f = fixture();
  f.setActive(true);
  const updates: any[] = [];
  const stop = await f.harness.watchExistingTurn("/w", "ses_root", (update) => { updates.push(update); });
  try {
    const internal = f.harness as any;
    const watch = internal.watches.get("ses_root");
    const send = (type: string, created: number, content: object) => internal.event({ type, created, data: {
      sessionID: "ses_root", ...content } }, "/w", "ses_root", watch, (update: any) => { updates.push(update); });
    const model = { id: "text", providerID: "test" };
    const tokens = { input: 100, output: 400, reasoning: 100, cache: { read: 0, write: 0 } };
    send("session.step.started", 1_000, { assistantMessageID: "msg_a", model, started: 1_000 });
    send("session.step.streamed", 5_000, { assistantMessageID: "msg_a" });
    send("session.step.ended", 5_050, { assistantMessageID: "msg_a", finish: "stop", cost: 0.01, tokens });
    // The live card shows the anchored window only: 500 tokens over the 4s
    // started→streamed span, never a rate invented from step-end spacing.
    const liveA = updates.filter((update) => update.kind === "metrics").at(-1)!.metrics;
    assert.equal(liveA.generationMs, 4_000);
    assert.equal(liveA.timedOutputTokens, 500);
    assert.equal(liveA.outputTokensPerSecond, 125);
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
    // Steps whose started/streamed anchors never reached the bot (SSE gap,
    // parallel subagent bursts) must not invent a rate from step-end spacing:
    // their tokens stay billed while live and final averages describe only
    // the anchored steps.
    send("session.step.ended", 21_020, { assistantMessageID: "msg_x", finish: "stop", cost: 0.01,
      tokens: { ...tokens, output: 10_000, reasoning: 0 } });
    send("session.step.ended", 21_021, { assistantMessageID: "msg_y", finish: "stop", cost: 0.01,
      tokens: { ...tokens, output: 10_000, reasoning: 0 } });
    const liveB = updates.filter((update) => update.kind === "metrics").at(-1)!.metrics;
    assert.equal(liveB.generationMs, 5_000);
    assert.equal(liveB.timedOutputTokens, 550);
    assert.equal(liveB.outputTokensPerSecond, 110);
    assert.equal(liveB.outputTokens, 20_550, "untimed steps keep their tokens billed");
    const partial = await internal.finalUsage("/w", "ses_root", 0, new Set(), watch);
    assert.equal(partial.outputTokensPerSecond, 110);
    // A failed untimed attempt must not poison the measured samples.
    send("session.step.started", 30_000, { assistantMessageID: "msg_c", model, started: 30_000 });
    send("session.step.failed", 31_000, { assistantMessageID: "msg_c", error: { message: "provider unavailable" } });
    const failed = await internal.finalUsage("/w", "ses_root", 0, new Set(), watch);
    assert.equal(failed.outputTokensPerSecond, 110);
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
    since: now - 1, baseline: new Set(), steps: new Map(), timings: new Map(), compactions: 0 });
  assert.equal(usage.generationMs, 3_000);
  assert.equal(usage.timedOutputTokens, 350);
  assert.equal(usage.outputTokensPerSecond, 350 / 3);
});

test("a 100-step Surplus turn never divides untimed output by another step's duration", async () => {
  const f = fixture();
  f.setActive(true);
  const updates: any[] = [];
  const progress = (update: any) => { updates.push(update); };
  const stop = await f.harness.watchExistingTurn("/w", "ses_root", progress, 0);
  try {
    const internal = f.harness as any;
    const watch = internal.watches.get("ses_root");
    const model = { id: "deepseek", providerID: "surplus" };
    for (let index = 0; index < 100; index++) {
      const id = `msg_rate_${index}`;
      const started = 1_000 + index * 10_000;
      // One measured step; the others have zero/reversed/missing timestamps.
      // Every step is billed, but only the measured step belongs in the rate.
      const streamed = index === 0 ? started + 1_000 : index % 3 === 0 ? undefined : started - index % 2;
      const tokens = { input: 500, output: index === 0 ? 80 : 121_000, reasoning: index === 0 ? 20 : 0,
        cache: { read: 0, write: 0 } };
      const send = (type: string, created: number, data: object) => internal.event({ type, created,
        data: { sessionID: "ses_root", assistantMessageID: id, ...data } }, "/w", "ses_root", watch, progress);
      send("session.step.started", started, { model, started });
      if (streamed !== undefined) send("session.step.streamed", streamed, {});
      send("session.step.ended", started + 8_000, { finish: "tool-calls", cost: 0.01, tokens });
      f.history.push({ type: "assistant", id, agent: "sitebuilder", model, content: [], finish: "tool-calls",
        time: { created: started, streamed, completed: started + 8_000 }, tokens, cost: 0.01 });
    }
    const live = updates.filter((update) => update.kind === "metrics").at(-1).metrics;
    assert.equal(live.steps, 100);
    assert.equal(live.outputTokens, 100 + 99 * 121_000);
    assert.equal(live.timedOutputTokens, 100);
    assert.equal(live.generationMs, 1_000);
    assert.equal(live.outputTokensPerSecond, 100);
    const saved = await internal.finalUsage("/w", "ses_root", 0, new Set(), watch);
    assert.equal(saved.outputTokens, live.outputTokens);
    assert.equal(saved.timedOutputTokens, 100);
    assert.equal(saved.generationMs, 1_000);
    assert.equal(saved.outputTokensPerSecond, 100);
  } finally { await stop(); }
});

test("live averages recover all 100 measured steps from history and deduplicate replayed step ends", async () => {
  const f = fixture();
  f.setActive(true);
  const model = { id: "deepseek", providerID: "surplus" };
  const tokens = { input: 500, output: 200, reasoning: 100, cache: { read: 0, write: 0 } };
  for (let index = 0; index < 100; index++) f.history.push({ type: "assistant", id: `msg_saved_${index}`,
    agent: "sitebuilder", model, content: [], finish: "tool-calls", tokens, cost: 0.01,
    time: { created: index * 10_000 + 1_000, streamed: index * 10_000 + 3_000, completed: index * 10_000 + 9_000 } });
  const updates: any[] = [];
  const progress = (update: any) => { updates.push(update); };
  const stop = await f.harness.watchExistingTurn("/w", "ses_root", progress, 0);
  try {
    const internal = f.harness as any;
    const watch = internal.watches.get("ses_root");
    const recovered = updates.filter((update) => update.kind === "metrics").at(-1)?.metrics;
    assert.equal(recovered?.steps, 100);
    assert.equal(recovered?.outputTokensPerSecond, 150);
    // SSE can repeat records already reconciled from durable history.
    internal.event({ type: "session.step.ended", created: 999_000, data: { sessionID: "ses_root",
      assistantMessageID: "msg_saved_99", finish: "tool-calls", cost: 0.01, tokens } }, "/w", "ses_root", watch, progress);
    const replayed = updates.filter((update) => update.kind === "metrics").at(-1).metrics;
    assert.equal(replayed.steps, 100);
    assert.equal(replayed.outputTokens, 30_000);
    assert.equal(replayed.generationMs, 200_000);
    assert.equal(replayed.outputTokensPerSecond, 150);
  } finally { await stop(); }
});

test("a completed provider window replaces a burst live estimate on the actual progress card", async () => {
  const { DiscordProgress } = await import("../src/progress.js");
  const f = fixture();
  f.setActive(true);
  const card = new DiscordProgress({ id: "rate", edit: async () => {} } as any, "Rate test");
  const progress = (update: any) => card.callback(update);
  const stop = await f.harness.watchExistingTurn("/w", "ses_root", progress, 0);
  try {
    const internal = f.harness as any;
    const watch = internal.watches.get("ses_root");
    const send = (type: string, created: number, data: object) => internal.event({ type, created,
      data: { sessionID: "ses_root", assistantMessageID: "msg_burst", ...data } }, "/w", "ses_root", watch, progress);
    send("session.step.started", 1_000, { model: { id: "deepseek", providerID: "surplus" }, started: 1_000 });
    send("session.reasoning.delta", 1_010, { ordinal: 0, delta: "A large buffered reasoning chunk. ".repeat(1_000) });
    assert.ok(card.readSnapshot().metrics!.liveTokensPerSecond! > 1_000);
    send("session.step.streamed", 2_000, {});
    send("session.step.ended", 9_000, { finish: "tool-calls", cost: 0,
      tokens: { input: 500, output: 80, reasoning: 20, cache: { read: 0, write: 0 } } });
    assert.equal(card.readSnapshot().metrics!.liveTokensPerSecond, undefined, "completed usage clears the burst estimate immediately");
    assert.equal(card.readSnapshot().metrics!.outputTokensPerSecond, 100);
  } finally { await stop(); await card.close(); }
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
