import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { TurnStepBudget, finishUpInstruction } from "../src/step-budget.js";
import type { SessionMessage } from "../src/opencode.js";

const since = Date.now();
function savedSteps(count: number): SessionMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    info: { id: `step-${i}`, role: "assistant", time: { created: since + i } },
    parts: [{ type: "step-finish" }],
  }));
}

test("force finish arrives at 90% once, with room for checks, despite replayed events", async () => {
  const sent: number[] = [];
  const budget = new TurnStepBudget({ limit: 200, since, read: async () => [],
    send: async (steps) => { sent.push(steps); return true; }, onError: assert.ifError });
  try {
    for (let i = 0; i < 179; i++) { budget.observe(`step-${i}`); budget.observe(`step-${i}`); }
    assert.deepEqual(sent, []);
    budget.observe("step-179");
    await nextTick();
    for (let i = 180; i < 220; i++) budget.observe(`step-${i}`);
    assert.deepEqual(sent, [180]);
  } finally { await budget.stop(); }
});

test("saved history restores missed steps and excludes the previous turn", async () => {
  const baseline = new Set(["previous"]);
  const sent: number[] = [];
  const budget = new TurnStepBudget({ limit: 10, since, baseline,
    read: async () => [
      ...savedSteps(9),
      { info: { id: "previous", role: "assistant", finish: "tool-calls", time: { created: since } } },
      { info: { id: "old", role: "assistant", finish: "stop", time: { created: since - 10_000 } } },
      { info: { id: "previous-receipt", role: "user", time: { created: since - 1 } },
        parts: [{ type: "text", text: finishUpInstruction(9, 10) }] },
    ], send: async (steps) => { sent.push(steps); return true; }, onError: assert.ifError });
  try {
    await budget.refresh();
    await nextTick();
    assert.deepEqual(sent, [9]);
    budget.observe("step-8");
    await budget.refresh();
    assert.deepEqual(sent, [9]);
  } finally { await budget.stop(); }
});

test("a persisted force steer suppresses another warning after a bot restart", async () => {
  const budget = new TurnStepBudget({ limit: 10, since,
    read: async () => [...savedSteps(10), {
      info: { id: "receipt", role: "user", time: { created: since + 20 } },
      parts: [{ type: "text", text: finishUpInstruction(9, 10) }],
    }], send: async () => { assert.fail("already steered this turn"); }, onError: assert.ifError });
  try { await budget.refresh(); budget.observe("step-11"); await nextTick(); }
  finally { await budget.stop(); }
});

test("stopping a watcher prevents a late history response from steering an idle/deleted turn", async () => {
  let release!: (messages: SessionMessage[]) => void;
  const budget = new TurnStepBudget({ limit: 2, since,
    read: () => new Promise((resolve) => { release = resolve; }),
    send: async () => { assert.fail("watcher stopped"); }, onError: assert.ifError });
  const reading = budget.refresh();
  await budget.stop();
  release(savedSteps(2));
  await reading;
  budget.observe("late-event");
});

test("a tiny custom budget still force-finishes after a single step", async () => {
  const sent: number[] = [];
  const budget = new TurnStepBudget({ limit: 1, since, read: async () => [],
    send: async (steps) => { sent.push(steps); return true; }, onError: assert.ifError });
  try {
    budget.observe("step-0");
    await nextTick();
    assert.deepEqual(sent, [1]);
  } finally { await budget.stop(); }
});
