import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { buildV2Config } from "./config.mjs";
import { applyRuntimeConfig } from "../runtime-config.mjs";

const legacy = JSON.parse(await fs.readFile(new URL("../opencode.json", import.meta.url), "utf8")
  .catch((error) => error.code === "ENOENT" ? fs.readFile(new URL("../opencode.base.json", import.meta.url), "utf8") : Promise.reject(error)));
test("native v2 config preserves builder features and isolated subagent models without modifying v1", () => {
  const original = structuredClone(legacy);
  const config = buildV2Config(applyRuntimeConfig(structuredClone(legacy), { OPENCODE_MAX_STEPS: "350" }));
  assert.equal(config.agents.sitebuilder.steps, 350);
  assert.equal(config.agents.titler.steps, 1);
  assert.equal(config.experimental.todo, true);
  assert.equal(config.snapshots, false);
  for (const id of ["general", "explore"]) {
    assert.equal(config.agents[id].model, original.agent[id].model);
    assert.ok(config.agents[id].permissions.some((rule) => rule.action === "threadsite_browser" && rule.effect === "deny"));
  }
  assert.ok(config.agents.titler.permissions.some((rule) => rule.action === "*" && rule.effect === "deny"));
  const system = config.agents.sitebuilder.system;
  for (const name of ["DESCRIPTION.md", "CHANGELOG.md", "project_notes", "asset_download", "js_syntax_check", "scratch/<name>/", "THREADSITE_FORCE_FINISH"]) assert.ok(system.includes(name), name);
  assert.match(system, /rm accepts explicit paths/);
  assert.doesNotMatch(system, /rm, package managers|do not try unlisted commands/);
  assert.ok(config.permissions.some((rule) => rule.action === "shell" && rule.resource === "git *" && rule.effect === "deny"));
  assert.equal(config.mcp.servers.playwright.timeout.execution, 90000);
  assert.deepEqual(legacy, original);
});

test("Surplus catalog capabilities, context caps and reasoning variants use native v2 fields", () => {
  const config = buildV2Config({ ...legacy, provider: { surplus: {
    npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://provider/v1" }, models: {
      vision: { modalities: { input: ["text", "image"] }, limit: { context: 64000, output: 2048 }, variants: { high: { reasoningEffort: "high" } } },
      unknown: { attachment: true },
    },
  } } });
  assert.deepEqual(config.providers.surplus.models.vision.capabilities.input, ["text", "image"]);
  assert.equal(config.providers.surplus.models.vision.limit.context, 64000);
  assert.deepEqual(config.providers.surplus.models.vision.variants, [{ id: "high", body: { reasoning_effort: "high" } }]);
  assert.deepEqual(config.providers.surplus.models.unknown.capabilities.input, ["text"]);
});

test("v2 supplies trusted LSP settings and optional Context7 credentials without changing v1", () => {
  const original = structuredClone(legacy);
  const config = buildV2Config(legacy, { env: {} });
  assert.equal(config.plugins[0].options.lsp.typescript.initialization.disableAutomaticTypingAcquisition, true);
  assert.equal(config.plugins[0].options.lsp.typescript.initialization.implicitProjectConfiguration.strictNullChecks, false);
  for (const name of ["typescript", "html", "css", "json"]) {
    assert.deepEqual(config.plugins[0].options.lsp[name].command, legacy.lsp[name].command);
  }
  assert.equal(config.mcp.servers.context7.disabled, false);
  assert.equal(config.mcp.servers.context7.oauth, false);
  assert.equal(config.mcp.servers.context7.headers, undefined);
  assert.ok(config.permissions.some((rule) => rule.action === "threadsite_docs" && rule.effect === "allow"));
  const disabled = buildV2Config(legacy, { env: { CONTEXT7_ENABLED: "0", CONTEXT7_API_KEY: " test-key " } });
  assert.equal(disabled.mcp.servers.context7.disabled, true);
  assert.deepEqual(disabled.mcp.servers.context7.headers, { Authorization: "Bearer test-key" });
  assert.equal(buildV2Config({ ...legacy, lsp: false }).plugins[0].options.lsp, false);
  assert.deepEqual(legacy, original);
});
