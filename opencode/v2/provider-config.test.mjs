import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyProviderConfig, readProviderConfig, scrubProviderCredentials } from "../provider-config.mjs";
const bundled = JSON.parse(await fs.readFile(new URL("../providers.json", import.meta.url), "utf8"));

test("host provider overrides retain policy and models, route requests, and isolate credentials", async () => {
  const base = { permissions: [{ action: "*", effect: "deny" }], providers: { proxy: {
    settings: { baseURL: "https://old.example/v1" },
    models: { existing: { limit: { context: 200000 }, settings: { temperature: 0.1 } } },
  } } };
  const host = { providers: { proxy: { package: "@ai-sdk/openai-compatible", env: ["CUSTOM_KEY"],
    settings: { baseURL: "https://new.example/v1", apiKey: "{env:CUSTOM_KEY}" }, models: {
      manual: { cost: { input: 2, output: 6, cache: { read: 0.5 } },
        settings: { baseURL: "https://other.example/v1" }, capabilities: { input: ["text", "image"] } },
    } }, anthropic: { settings: { apiKey: "{file:/run/keys/anthropic}" } } } };
  const original = structuredClone({ base, host });
  let fetches = 0;
  const config = await applyProviderConfig(base, host, { env: { CUSTOM_KEY: "secret" },
    fetchImpl: () => { fetches++; throw new Error("unexpected discovery"); } });
  assert.equal(fetches, 0, "discovery must be opt-in");
  assert.deepEqual(config.permissions, base.permissions);
  assert.equal(config.providers.proxy.models.existing.settings.baseURL, "https://new.example/v1");
  assert.equal(config.providers.proxy.models.existing.settings.temperature, 0.1);
  assert.equal(config.providers.proxy.models.manual.settings.baseURL, "https://other.example/v1");
  assert.deepEqual(config.providers.proxy.models.existing.capabilities.input, ["text"]);
  assert.deepEqual(config.providers.proxy.models.manual.capabilities.input, ["text", "image"]);
  assert.ok(!JSON.stringify(config).includes('"secret"'));
  assert.deepEqual({ base, host }, original);
});

test("compatible catalog fetch uses auth, translates pricing, caps context and preserves explicit overrides", async (t) => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/v1/models");
    assert.equal(req.headers.authorization, "Bearer secret");
    assert.equal(req.headers["x-tenant"], "private-tenant");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [
      { id: "vision", context_length: 200000, max_output_tokens: 8000, supported_parameters: ["tools", "reasoning_effort"],
        architecture: { input_modalities: ["text", "image"] },
        pricing: { prompt: "0.000002", completion: "0.000006", input_cache_read: "0.0000005", input_cache_write: "0.000003" } },
      { id: "free", context_length: 16000, pricing: { prompt: "0", completion: "0" } },
      { id: "unknown-price", pricing: { prompt: "-1", completion: "NaN" } },
      { id: "feature-tools", supported_parameters: [], supported_features: ["tools"], input_modalities: "image" },
      { id: "no-tools", supported_parameters: [] },
    ] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = await applyProviderConfig({}, { providers: { custom: {
    package: "@ai-sdk/openai-compatible", env: ["MISSING_KEY", "CUSTOM_KEY"],
    settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1` }, headers: { "X-Tenant": "{env:TENANT}" },
    models: { vision: { cost: { input: 1 }, variants: [{ id: "high", body: { reasoning_effort: "max" } }] }, offline: {} },
  } }, catalogs: { custom: { contextCap: 100000 } } }, { env: { CUSTOM_KEY: "secret", TENANT: "private-tenant" } });
  const models = config.providers.custom.models;
  assert.deepEqual(models.vision.cost, { input: 1, output: 6, cache: { read: 0.5, write: 3 } });
  assert.deepEqual(models.vision.limit, { context: 100000, output: 8000 });
  assert.deepEqual(models.vision.capabilities.input, ["text", "image"]);
  assert.deepEqual(models.vision.variants, [{ id: "high", body: { reasoning_effort: "max" } }]);
  assert.equal(models.free.limit.context, 16000);
  assert.equal(models.free.cost.input, 0);
  assert.equal(models["unknown-price"].cost, undefined);
  assert.deepEqual(models["feature-tools"].capabilities.input, ["text"]);
  assert.equal(models["no-tools"], undefined);
  assert.deepEqual(models.offline.capabilities.input, ["text"]);
  assert.equal(models.offline.limit.context, 100000);
});

test("Surplus remains publicly discoverable with saved auth and offline fallback is conservative", async () => {
  const host = { providers: { surplus: { models: { "glm-5.3": {}, "effort-plain": {}, "offline-vision": {} } } }, catalogs: { surplus: { contextCap: 0 } } };
  let calls = 0;
  const config = await applyProviderConfig({ providers: bundled.providers }, host, {
    defaultCatalogs: bundled.catalogs, env: {}, fetchImpl: async (_url, options) => {
      calls++;
      assert.equal(options.headers.Authorization, undefined);
      return { ok: true, json: async () => ({ data: [{ id: "glm-5.3", supported_parameters: ["tools", "reasoning_effort"],
        supported_features: ["vision"], context_length: 250000 },
      { id: "effort-plain", supported_parameters: ["tools", "reasoning_effort"], architecture: { input_modalities: ["text"] } }] }) };
    },
  });
  assert.equal(calls, 1);
  assert.equal(config.providers.surplus.models["glm-5.3"].limit.context, 250000);
  assert.equal(config.providers.surplus.models["glm-5.3"].variants.find((item) => item.id === "medium").body.reasoning_effort, "high");
  // Non-GLM catalogs accept every effort verbatim; only the GLM routes alias.
  const plain = config.providers.surplus.models["effort-plain"].variants;
  assert.deepEqual(plain.find((item) => item.id === "medium").body, { reasoning_effort: "medium" });
  assert.deepEqual(plain.find((item) => item.id === "high").body, { reasoning_effort: "high" });
  assert.deepEqual(config.providers.surplus.models["glm-5.3"].capabilities.input, ["text", "image"]);
  assert.deepEqual(config.providers.surplus.models["offline-vision"].capabilities.input, ["text"]);
  const warnings = [];
  const fallback = await applyProviderConfig({ providers: bundled.providers }, host, {
    defaultCatalogs: bundled.catalogs,
    fetchImpl: async () => { throw new Error("secret-token in upstream error"); }, warn: (message) => warnings.push(message),
  });
  assert.ok(fallback.providers.surplus.models["glm-5.3"]);
  assert.deepEqual(fallback.providers.surplus.models["offline-vision"].capabilities.input, ["text"]);
  assert.equal(fallback.providers.surplus.models["glm-5.3"].limit, undefined);
  assert.ok(!warnings.join().includes("secret-token"));
  let disabledFetches = 0;
  await applyProviderConfig({ providers: bundled.providers }, { catalogs: { surplus: false } }, {
    defaultCatalogs: bundled.catalogs, fetchImpl: () => { disabledFetches++; throw new Error("unexpected discovery"); },
  });
  assert.equal(disabledFetches, 0, "disabled catalog must not fetch");
});

test("host config rejects policy overrides and malformed configuration without leaking JSON secrets", async (t) => {
  for (const host of [null, [], { permissions: [] }, { provider: {} }, { providers: [] }, { providers: { broken: null } },
    { providers: { broken: { models: { model: null } } } }, { catalogs: { missing: {} } },
    { providers: { custom: {} }, catalogs: { custom: { contextCap: -1 } } },
    JSON.parse('{"providers":{"__proto__":{"apiKey":"secret"}}}')]) {
    await assert.rejects(applyProviderConfig({}, host));
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-provider-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "providers.json");
  assert.deepEqual(await readProviderConfig(file), {});
  await fs.writeFile(file, '{"providers": "secret-token", invalid}');
  await assert.rejects(readProviderConfig(file), (error) => !error.message.includes("secret-token"));
  await fs.writeFile(file, '{"providers":{"openai":{"settings":{"apiKey":"{env:HOST_KEY}"}}}}');
  assert.equal((await readProviderConfig(file)).providers.openai.settings.apiKey, "{env:HOST_KEY}");
});

test("catalog credentials support mounted key files and preserve explicit authorization headers", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-provider-key-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const key = path.join(root, "provider-key");
  await fs.writeFile(key, "file-$&-key\n");
  for (const authorization of [undefined, "Basic {env:CUSTOM_AUTH}"]) {
    let requestHeaders;
    await applyProviderConfig({}, { providers: { custom: {
      settings: { baseURL: "https://example.com/v1", apiKey: `{file:${key}}` },
      env: ["FALLBACK_KEY"], headers: { "X-Trace": "{env:TRACE}", ...(authorization ? { authorization } : {}) },
    } }, catalogs: { custom: {} } }, { env: { FALLBACK_KEY: "unused", CUSTOM_AUTH: "host-auth", TRACE: "$&" },
      fetchImpl: async (_url, { headers }) => {
        requestHeaders = headers;
        return { ok: true, json: async () => ({ data: [] }) };
      },
    });
    assert.equal(requestHeaders[authorization ? "authorization" : "Authorization"], authorization ? "Basic host-auth" : "Bearer file-$&-key");
    assert.equal(requestHeaders["X-Trace"], "$&");
  }
});

test("literal provider credentials are scrubbed into environment references, references stay untouched", async () => {
  const base = { providers: {} };
  const host = { providers: { paid: {
    package: "@ai-sdk/openai-compatible",
    settings: { apiKey: "sk-live-literal", baseURL: "https://api.paid.example/v1" },
    headers: { Authorization: "Bearer sk-live-literal", "X-Tenant": "private-tenant" },
    models: { m1: {} },
  }, keyed: { settings: { apiKey: "{env:HOST_KEY}" }, models: { m2: {} } } } };
  const config = await applyProviderConfig(base, host, { env: { HOST_KEY: "from-env" } });
  const env = scrubProviderCredentials(config);

  const serialized = JSON.stringify(config);
  assert.ok(!serialized.includes("sk-live-literal"), "no literal credential may remain in the written config");
  assert.equal(config.providers.paid.settings.baseURL, "https://api.paid.example/v1");
  assert.equal(config.providers.paid.headers["X-Tenant"], "private-tenant");
  assert.equal(config.providers.paid.settings.apiKey, "{env:THREADSITE_PROVIDER_KEY_0}");
  // Provider settings are merged into every model, so the merged copy must share the reference.
  assert.equal(config.providers.paid.models.m1.settings.apiKey, "{env:THREADSITE_PROVIDER_KEY_0}");
  assert.equal(config.providers.paid.headers.Authorization, "{env:THREADSITE_PROVIDER_KEY_1}");
  assert.deepEqual(env, { THREADSITE_PROVIDER_KEY_0: "sk-live-literal", THREADSITE_PROVIDER_KEY_1: "Bearer sk-live-literal" });
  // Existing native references pass through unchanged and produce no variables.
  assert.equal(config.providers.keyed.settings.apiKey, "{env:HOST_KEY}");
  assert.equal(config.providers.keyed.models.m2.settings.apiKey, "{env:HOST_KEY}");
});
