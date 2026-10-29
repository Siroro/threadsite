import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeUpdateBatch } from "../src/update-batch.js";

test("batching respects the composed prompt limit and keeps overflow with its images", () => {
  const batch = Array.from({ length: 120 }, (_, id) => ({ prompt: `request ${id}`, images: [id], id }));
  const complete = mergeUpdateBatch<number, typeof batch[number]>(batch, 10_000);
  const limit = complete.prompt.length - 1;
  const result = mergeUpdateBatch<number, typeof batch[number]>(batch, limit);
  assert.ok(result.prompt.length <= limit);
  assert.ok(result.overflow.length > 0);
  const consumed = batch.length - result.overflow.length;
  assert.deepEqual(result.images, batch.slice(0, consumed).map((entry) => entry.id));
  assert.deepEqual(result.overflow, batch.slice(consumed));
  // The exact composed boundary accepts all requests; one character less does not.
  assert.equal(mergeUpdateBatch(batch, complete.prompt.length).overflow.length, 0);
  const next = mergeUpdateBatch(result.overflow, 10_000);
  assert.equal(next.prompt, batch.at(-1)!.prompt);
  assert.equal(next.display, undefined);
});

test("a request that cannot merge does not allow later requests to jump the queue", () => {
  const batch = [{ prompt: "first", images: [1] }, { prompt: "x".repeat(200), images: [2] }, { prompt: "last", images: [3] }];
  const result = mergeUpdateBatch(batch, 200);
  assert.equal(result.prompt, "first");
  assert.deepEqual(result.images, [1]);
  assert.deepEqual(result.overflow, batch.slice(1));
  assert.throws(() => mergeUpdateBatch([], 200));
  assert.throws(() => mergeUpdateBatch(batch, 4));
  assert.throws(() => mergeUpdateBatch(batch, NaN));
});
