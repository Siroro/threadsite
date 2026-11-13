import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeError } from "../src/logger.js";

test("undefined rejection reasons can be serialized without throwing", () => {
  assert.equal(serializeError(undefined).message, "undefined");
  assert.equal(serializeError(null).message, "null");
});

test("credential arrays are redacted while diagnostic arrays and usage counts survive", () => {
  const error = Object.assign(new Error("Request failed"), {
    headers: { authorization: ["fake-auth-a", "fake-auth-b"], cookie: [["fake-session-cookie"]] },
    apiKeys: ["fake-key-a", { publicStatus: "retry", apiKey: "fake-key-b" }],
    attempts: [1, 2], inputTokens: [12, 34],
  });
  const result = serializeError(error);
  const text = JSON.stringify(result);
  for (const secret of ["fake-auth-a", "fake-auth-b", "fake-session-cookie", "fake-key-a", "fake-key-b"]) {
    assert.equal(text.includes(secret), false);
  }
  assert.deepEqual((result.details as Record<string, unknown>).attempts, [1, 2]);
  assert.deepEqual((result.details as Record<string, unknown>).inputTokens, [12, 34]);
  assert.ok(text.includes("retry"));
});
