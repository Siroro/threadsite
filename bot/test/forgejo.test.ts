import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DISCORD_BOT_TOKEN = "test";
process.env.DISCORD_APPLICATION_ID = "test";
const { ForgejoClient } = await import("../src/forgejo.js");

function client(api: (url: string, init?: RequestInit) => Promise<Response>) {
  const forgejo = new ForgejoClient();
  (forgejo as unknown as { api: typeof api }).api = api;
  return forgejo;
}

test("webhook setup resolves renamed repositories before creating hooks", async () => {
  const calls: string[] = [];
  const forgejo = client(async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/old")) return Response.json({ id: 1, name: "renamed" });
    assert.match(url, /\/renamed\/hooks$/);
    return init?.method === "POST" ? Response.json({ id: 3 }, { status: 201 }) : Response.json([]);
  });
  await forgejo.ensurePushWebhook("old", "http://bot:8901/hooks/forgejo", "test");
  assert.equal(calls.length, 3);
  assert.match(calls[2], /^POST .*\/renamed\/hooks$/);
});

test("a missing repository is reported before any hook creation is attempted", async () => {
  let calls = 0;
  const forgejo = client(async (_url, init) => {
    calls += 1;
    assert.equal(init?.method, undefined);
    return new Response("missing", { status: 404 });
  });
  await assert.rejects(forgejo.ensurePushWebhook("missing", "http://bot/hook", "test"), /repository.*missing.*not found or.*accessible/i);
  assert.equal(calls, 1);
});

for (const status of [403, 404, 500]) {
  test(`a failed hook lookup (${status}) never falls through to creation`, async () => {
    const forgejo = client(async (url, init) => {
      assert.equal(init?.method, undefined);
      return url.endsWith("/hooks") ? new Response("lookup failed", { status }) : Response.json({ id: 1, name: "project" });
    });
    await assert.rejects(forgejo.ensurePushWebhook("project", "http://bot/hook", "test"), new RegExp(`webhook lookup failed \\(${status}\\)`));
  });
}

test("a matching existing hook is reused", async () => {
  let calls = 0;
  const forgejo = client(async (url, init) => {
    calls += 1;
    assert.equal(init?.method, undefined);
    return url.endsWith("/hooks") ? Response.json([{ config: { url: "http://bot/hook" } }]) : Response.json({ id: 1, name: "project" });
  });
  await forgejo.ensurePushWebhook("project", "http://bot/hook", "test");
  assert.equal(calls, 2);
});
