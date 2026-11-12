import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { testRootSetup } from "./fixtures/root.js";

testRootSetup("webhook-errors");
const { startWebhookServer } = await import("../src/webhook.js");

test("a health callback failure answers 500 and the next request still succeeds", async (t) => {
  let fail = true;
  const server = startWebhookServer({
    port: 0, secret: "test-secret", onPush: async () => undefined,
    health: () => {
      if (fail) throw new Error("private storage diagnostics");
      return { projects: 2 };
    },
  });
  t.after(() => server.close());
  const port = await server.listening;
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private storage/);
  fail = false;
  const recovered = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).projects, 2);
});

test("validly signed non-object and malformed push payloads never dispatch", async (t) => {
  const events: unknown[] = [];
  const secret = "test-secret";
  const server = startWebhookServer({ port: 0, secret, onPush: async (event) => { events.push(event); }, health: () => ({}) });
  t.after(() => server.close());
  const port = await server.listening;
  for (const payload of [null, [], 42, { after: 123 }, { repository: "repo" }, { repository: { name: [] } }, { ref: {} }]) {
    const body = JSON.stringify(payload);
    const response = await fetch(`http://127.0.0.1:${port}/hooks/forgejo`, {
      method: "POST", body,
      headers: { "x-forgejo-signature": createHmac("sha256", secret).update(body).digest("hex") },
    });
    assert.equal(response.status, 400);
    await response.text();
  }
  assert.deepEqual(events, []);
});
