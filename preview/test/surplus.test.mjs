import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSurplusProvider } from "../../opencode/surplus-adapter.mjs";

test("discovers image input publicly, including the marketplace's vision feature signal", async () => {
  let request;
  const { provider } = await buildSurplusProvider({
    env: { SURPLUS_MODELS: "offline-extra" },
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
  const { provider } = await buildSurplusProvider({
    env: { SURPLUS_MODELS: "deepseek-new-vision", SURPLUS_API_KEY: "test-key" },
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, "Bearer test-key");
      throw new Error("offline");
    },
  });
  assert.ok(provider.models["deepseek-new-vision"]);
  assert.deepEqual(provider.models["deepseek-new-vision"].capabilities.input, ["text"]);
});
