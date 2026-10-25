import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ProgressCallback } from "../src/progress.js";
import type { PromptResult } from "../src/opencode.js";

process.env.DISCORD_BOT_TOKEN = "test";
process.env.DISCORD_APPLICATION_ID = "test";
const { ProjectService } = await import("../src/project.js");
const { config } = await import("../src/config.js");

function recovery(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let callback: ProgressCallback | undefined;
  let complete!: (result: PromptResult) => void;
  let aborted = 0;
  const prompt = new Promise<PromptResult>((resolve) => { complete = resolve; });
  const service = new ProjectService(
    { getModel: () => undefined, getEffort: () => undefined } as any,
    { prompt: (_dir: string, _session: string, _text: string, _model: unknown, progress: ProgressCallback) => {
      callback = progress;
      return prompt;
    }, abortTurn: async () => { aborted += 1; return true; } } as any,
    {} as any, {} as any,
  );
  const result = service.recoveryPrompt("workspace", "session", "Continue", undefined, "thread") as Promise<PromptResult>;
  // Attach immediately so a mocked deadline rejection is always observed.
  const outcome = result.then((value) => ({ value, error: undefined }), (error: Error) => ({ value: undefined, error }));
  return { outcome, progress: (update: Parameters<ProgressCallback>[0]) => callback?.(update), complete, aborted: () => aborted };
}

test("recovery can exceed the window while the agent continues making progress", async (t) => {
  const run = recovery(t);
  for (let index = 0; index < 4; index += 1) {
    t.mock.timers.tick(config.opencodeReconcileTimeoutMs - 1);
    await run.progress({ kind: "thought", text: `Completed step ${index}` });
  }
  run.complete({ text: "Finished", usage: {} });
  const outcome = await run.outcome;
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value?.text, "Finished");
  assert.equal(run.aborted(), 0);
});

test("status heartbeats cannot keep an inactive recovery alive", async (t) => {
  const run = recovery(t);
  t.mock.timers.tick(config.opencodeReconcileTimeoutMs - 1);
  await run.progress({ kind: "heartbeat", text: "Still busy", active: true });
  t.mock.timers.tick(1);
  const outcome = await run.outcome;
  assert.match(outcome.error?.message ?? "", /without agent progress/);
  assert.equal(run.aborted(), 1);
  run.complete({ text: "Late result", usage: {} });
});

test("recovery pauses its inactivity deadline while waiting for a question answer", async (t) => {
  const run = recovery(t);
  await run.progress({ kind: "question", text: "Pick a style", question: { requestID: "q1", questions: [] } });
  t.mock.timers.tick(config.opencodeReconcileTimeoutMs * 2);
  await run.progress({ kind: "question", text: "Answered", question: { requestID: "q1", questions: [], resolved: true } });
  t.mock.timers.tick(config.opencodeReconcileTimeoutMs - 1);
  run.complete({ text: "Finished after answer", usage: {} });
  assert.equal((await run.outcome).error, undefined);
  assert.equal(run.aborted(), 0);
});

test("the reattached busy poll never speaks over the live activity render", async () => {
  const original = { poll: config.opencodeReconcilePollMs };
  config.opencodeReconcilePollMs = 2;
  try {
    const beats: Parameters<ProgressCallback>[0][] = [];
    let polls = 0;
    const service = new ProjectService(
      { getModel: () => undefined, getEffort: () => undefined } as any,
      { health: async () => "ok", watchExistingTurn: async () => async () => {},
        isBusy: async () => { polls += 1; return polls <= 2; } } as any,
      {} as any, {} as any,
    );
    const tracker = service.attachTracker((update) => { beats.push(update); });
    await service.waitForIdleTurn("workspace", "session", (update) => { beats.push(update); }, tracker);
    // While the interrupted turn runs, the poll reports the busy flag only: the
    // reattached event stream owns the visible feed, and a repeated technical
    // "still running" line would bury the live tool activity under it.
    assert.ok(beats.length >= 3, "both busy polls and the idle transition speak");
    assert.ok(beats.slice(0, -1).every((update) => update.kind === "heartbeat" && !update.text && update.active === true),
      "busy polls stay textless status flags");
    const finished = beats.at(-1)!;
    assert.equal(finished.kind, "heartbeat");
    assert.equal(finished.active, false);
    assert.match(finished.text ?? "", /has finished/);
  } finally { config.opencodeReconcilePollMs = original.poll; }
});

test("a reattached turn that keeps making progress outlives the recovery window", async () => {
  const original = { poll: config.opencodeReconcilePollMs, window: config.opencodeReconcileTimeoutMs };
  config.opencodeReconcilePollMs = 2;
  config.opencodeReconcileTimeoutMs = 60;
  try {
    let polls = 0;
    let aborted = 0;
    const service = new ProjectService(
      { getModel: () => undefined, getEffort: () => undefined } as any,
      { health: async () => "ok", watchExistingTurn: async () => async () => {},
        isBusy: async () => { polls += 1; return polls <= 120; },
        abortTurn: async () => { aborted += 1; return true; } } as any,
      {} as any, {} as any,
    );
    const tracker = service.attachTracker(undefined);
    // Streamed narration keeps arriving well past the window: once the agent is
    // confirmed working there is no wall clock, only the inactivity deadline.
    const feeding = setInterval(() => { tracker.progress({ kind: "thought", text: `Working ${Date.now()}` }); }, 8);
    try {
      await service.waitForIdleTurn("workspace", "session", undefined, tracker);
    } finally { clearInterval(feeding); }
    assert.equal(aborted, 0, "a progressing turn is never cut down mid-work");
    assert.ok(polls > 30, "the wait ran well past the window before the turn finished");
  } finally {
    config.opencodeReconcilePollMs = original.poll;
    config.opencodeReconcileTimeoutMs = original.window;
  }
});

test("a reattached turn that falls silent is stopped, and a pending question pauses the clock", async () => {
  const original = { poll: config.opencodeReconcilePollMs, window: config.opencodeReconcileTimeoutMs };
  config.opencodeReconcilePollMs = 2;
  config.opencodeReconcileTimeoutMs = 40;
  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    let aborted = 0;
    const service = new ProjectService(
      { getModel: () => undefined, getEffort: () => undefined } as any,
      { health: async () => "ok", watchExistingTurn: async () => async () => {},
        isBusy: async () => true,
        abortTurn: async () => { aborted += 1; return true; } } as any,
      {} as any, {} as any,
    );
    const tracker = service.attachTracker(undefined);
    const outcome = service.waitForIdleTurn("workspace", "session", undefined, tracker)
      .then(() => { throw new Error("the silent turn must be stopped, not awaited to idle"); }, (error: Error) => error);
    // A pending user question legitimately idles the agent: the stall clock
    // pauses, so several windows may pass without an abort.
    tracker.progress({ kind: "question", text: "Pick a palette", question: { requestID: "q1", questions: [] } });
    await settle(config.opencodeReconcileTimeoutMs * 3);
    assert.equal(aborted, 0, "no stall abort while the agent waits for an answer");
    tracker.progress({ kind: "question", text: "Answered", question: { requestID: "q1", questions: [], resolved: true } });
    const error = await outcome;
    assert.match(error.message, /stopped making progress/);
    assert.equal(aborted, 1, "the silent server-side turn was aborted, not left burning tokens");
  } finally {
    config.opencodeReconcilePollMs = original.poll;
    config.opencodeReconcileTimeoutMs = original.window;
  }
});
