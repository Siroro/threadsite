import { test } from "node:test";
import assert from "node:assert/strict";
import { applyContextCaps } from "./context-caps.mjs";
import { applyProviderConfig } from "../provider-config.mjs";
import { buildV2Config } from "./config.mjs";

test("context caps cover native catalogs, model overrides and smaller input windows without altering billing or capabilities", () => {
  const model = (providerID, id, context, input) => ({ providerID, id,
    limit: { context, output: 16000, ...(input === undefined ? {} : { input }) },
    cost: [{ input: 2, output: 6 }], capabilities: { input: ["text", "image"] } });
  const catalog = [model("paid", "large", 200000, 180000), model("paid", "small", 32000, 24000),
    model("paid", "vendor/special", 200000), model("paid", "uncapped", 200000), model("free", "untouched", 200000),
    model("paid", "unknown-window", 0)];
  const overrides = new Map();
  const editor = { list: () => catalog, update: (provider, id, update) => {
    const raw = overrides.get(`${provider}/${id}`) ?? { limit: { output: 16000 } };
    update(raw);
    overrides.set(`${provider}/${id}`, raw);
  } };
  const before = structuredClone(catalog);
  applyContextCaps(editor, { paid: 100000, "paid/vendor/special": 64000, "paid/uncapped": 0 });
  assert.deepEqual(overrides.get("paid/large").limit, { context: 100000, input: 100000, output: 16000 });
  assert.deepEqual(overrides.get("paid/small").limit, { context: 32000, input: 24000, output: 16000 });
  assert.equal(overrides.get("paid/vendor/special").limit.context, 64000);
  assert.equal(overrides.has("paid/uncapped"), false);
  assert.equal(overrides.has("free/untouched"), false);
  assert.equal(overrides.get("paid/unknown-window").limit.context, 100000);
  assert.deepEqual(catalog, before);
});

test("explicit model windows cannot undo provider caps when native config overrides the plugin", async () => {
  const config = await applyProviderConfig({}, { contextCaps: { paid: 100000, "paid/tighter": 64000 }, providers: { paid: { models: {
    large: { limit: { context: 200000, input: 180000, output: 16000 } },
    tighter: { limit: { context: 200000 } }, small: { limit: { context: 32000, input: 24000 } },
  } } } });
  assert.deepEqual(config.providers.paid.models.large.limit, { context: 100000, input: 100000, output: 16000 });
  assert.equal(config.providers.paid.models.tighter.limit.context, 64000);
  assert.deepEqual(config.providers.paid.models.small.limit, { context: 32000, input: 24000 });
});

test("context caps work without provider definitions or discovery and reach the plugin without leaking into native config", async () => {
  let fetches = 0;
  const base = { agents: {}, mcp: { servers: {} }, permissions: [{ effect: "deny" }] };
  const config = await applyProviderConfig(base, { contextCaps: { openai: 100000, "openai/gpt-custom": 64000, surplus: 0 } }, {
    defaultContextCaps: { surplus: 100000 }, fetchImpl: () => { fetches++; throw new Error("unexpected discovery"); },
  });
  const native = buildV2Config(config, { env: {} });
  assert.equal(fetches, 0);
  assert.equal(native.contextCaps, undefined);
  assert.deepEqual(native.plugins[0].options.contextCaps, { openai: 100000, "openai/gpt-custom": 64000, surplus: 0 });
  assert.deepEqual(native.permissions, base.permissions);
  for (const contextCaps of [null, [], { openai: -1 }, { openai: 1.5 }, { openai: "100000" },
    { "openai/": 10 }, { "openai/model#variant": 100 }, { "bad ref": 1 }]) {
    await assert.rejects(applyProviderConfig(base, { contextCaps }));
  }
});
