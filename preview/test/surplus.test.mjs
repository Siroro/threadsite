import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSurplusProvider } from "../../opencode/surplus-adapter.mjs";

test("discovers image input publicly, including the marketplace's vision feature signal", async () => {
  let request;
  const { provider } = await buildSurplusProvider({
    config: { providers: { surplus: { models: { "offline-extra": {} } } }, catalogs: { surplus: { contextCap: 100000 } } },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ data: [
        { id: "image-input", architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["tools"], context_length: 200_000 },
        { id: "feature-only", architecture: { input_modalities: ["text"] }, supported_features: ["vision"], supported_parameters: ["tools", "reasoning_effort"] },
        { id: "deepseek-text", architecture: { input_modalities: ["text"] }, supported_parameters: ["tools"] },
        { id: "unspecified", supported_parameters: ["tools"] },
        { id: "image-generator", supported_parameters: [] },
      ] }) };
    },
  });
  assert.ok(request.url.endsWith("/models"));
  assert.equal(request.options.headers.Authorization, undefined);
  for (const id of ["image-input", "feature-only"]) {
    assert.deepEqual(provider.models[id].capabilities.input, ["text", "image"]);
  }
  assert.equal(provider.models["image-input"].limit.context, 100_000);
  assert.equal(provider.models["feature-only"].variants.find((variant) => variant.id === "high").body.reasoning_effort, "high");
  assert.deepEqual(provider.models["deepseek-text"].capabilities.input, ["text"]);
  assert.deepEqual(provider.models.unspecified.capabilities.input, ["text"]);
  assert.deepEqual(provider.models["offline-extra"].capabilities.input, ["text"]);
  assert.equal(provider.models["image-generator"], undefined);
});

test("catalog failure preserves fallback models and never guesses vision", async () => {
  let authorization;
  const { provider } = await buildSurplusProvider({
    config: { providers: { surplus: { settings: { apiKey: "test-key" }, models: { "deepseek-new-vision": {} } } } },
    fetchImpl: async (_url, options) => {
      authorization = options.headers.Authorization;
      throw new Error("offline");
    },
  });
  assert.equal(authorization, "Bearer test-key");
  assert.ok(provider.models["deepseek-new-vision"]);
  assert.deepEqual(provider.models["deepseek-new-vision"].capabilities.input, ["text"]);
});
