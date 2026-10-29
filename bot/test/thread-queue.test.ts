import assert from "node:assert/strict";
import { test } from "node:test";
import { ThreadQueue } from "../src/thread-queue.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("threads progress independently and failures do not block their successors", async () => {
  const queue = new ThreadQueue();
  const blocked = gate();
  const started = gate();
  const order: string[] = [];
  const first = queue.enqueue("a", async () => { started.resolve(); await blocked.promise; order.push("first"); throw new Error("failed"); });
  const failed = assert.rejects(first, /failed/);
  const second = queue.enqueue("a", async () => { order.push("second"); });
  await started.promise;
  await queue.enqueue("b", async () => { order.push("independent"); });
  assert.deepEqual(order, ["independent"]);
  blocked.resolve();
  await Promise.all([failed, second]);
  assert.deepEqual(order, ["independent", "first", "second"]);
});

test("sever releases one successor while later work stays serialized", async () => {
  const queue = new ThreadQueue();
  const abandoned = gate();
  const running = gate();
  const successor = gate();
  const started = gate();
  const order: number[] = [];
  const first = queue.enqueue("a", async () => { running.resolve(); await abandoned.promise; });
  await running.promise;
  const second = queue.enqueue("a", async () => { order.push(2); started.resolve(); await successor.promise; });
  const third = queue.enqueue("a", async () => { order.push(3); });
  assert.deepEqual(queue.sever("a"), { releasedWaiter: true });
  await started.promise;
  assert.deepEqual(order, [2]);
  abandoned.resolve();
  await first;
  assert.deepEqual(order, [2]);
  successor.resolve();
  await Promise.all([second, third]);
  assert.deepEqual(order, [2, 3]);
});

test("sever with no waiters allows new work past an abandoned tail", async () => {
  const queue = new ThreadQueue();
  const blocked = gate();
  const running = gate();
  const first = queue.enqueue("a", async () => { running.resolve(); await blocked.promise; });
  await running.promise;
  assert.deepEqual(queue.sever("a"), { releasedWaiter: false });
  assert.equal(await queue.enqueue("a", async () => 42), 42);
  blocked.resolve();
  await first;
});
