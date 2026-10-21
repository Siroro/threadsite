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
  const result = (service as any).recoveryPrompt("workspace", "session", "Continue", undefined, "thread") as Promise<PromptResult>;
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
