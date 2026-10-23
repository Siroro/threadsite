import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { buildV2Config } from "./config.mjs";
import { applyRuntimeConfig } from "../runtime-config.mjs";

const base = JSON.parse(await fs.readFile(new URL("../opencode.json", import.meta.url), "utf8")
  .catch((error) => error.code === "ENOENT" ? fs.readFile(new URL("../opencode.base.json", import.meta.url), "utf8") : Promise.reject(error)));
test("native v2 config preserves builder features and isolated subagent models without mutating its input", () => {
  const original = structuredClone(base);
  const config = buildV2Config(applyRuntimeConfig(structuredClone(base), { OPENCODE_MAX_STEPS: "350" }));
  assert.equal(config.agents.sitebuilder.steps, 350);
  assert.equal(config.agents.titler.steps, 1);
  assert.equal(config.experimental.todo, true);
  assert.equal(config.snapshots, false);
  for (const id of ["general", "explore"]) {
    assert.equal(config.agents[id].model, original.agents[id].model);
    assert.ok(config.agents[id].permissions.some((rule) => rule.action === "threadsite_browser" && rule.effect === "deny"));
  }
  assert.ok(config.agents.titler.permissions.some((rule) => rule.action === "*" && rule.effect === "deny"));
  assert.ok(config.permissions.some((rule) => rule.action === "shell" && rule.resource === "git *" && rule.effect === "deny"));
  assert.equal(config.mcp.servers.playwright.timeout.execution, 90000);
  assert.deepEqual(base, original);
});

test("v2 subagent model override applies to general and explore while preserving restrictions and primary agents", () => {
  const original = structuredClone(base);
  const defaults = buildV2Config(base, { env: {} });
  for (const model of [" opencode/replacement-model ", "surplus/vendor/model-id"]) {
    const config = buildV2Config(base, { env: { OPENCODE_SUBAGENT_MODEL: model } });
    for (const id of ["general", "explore"]) {
      assert.deepEqual(config.agents[id], { ...defaults.agents[id], model: model.trim() });
      for (const action of ["threadsite_browser", "playwright_*", "question"]) {
        assert.ok(config.agents[id].permissions.some((rule) => rule.action === action && rule.effect === "deny"));
      }
    }
    assert.deepEqual(config.agents.sitebuilder, defaults.agents.sitebuilder);
    assert.deepEqual(config.agents.titler, defaults.agents.titler);
  }
  for (const value of [undefined, "", "  "]) {
    const config = buildV2Config(base, { env: { OPENCODE_SUBAGENT_MODEL: value } });
    for (const id of ["general", "explore"]) assert.equal(config.agents[id].model, original.agents[id].model);
  }
  assert.deepEqual(base, original);
});

test("v2 rejects malformed subagent model overrides at startup", () => {
  for (const model of ["model-only", "/model", "provider/", "provider/model with spaces"]) {
    assert.throws(() => buildV2Config(base, { env: { OPENCODE_SUBAGENT_MODEL: model } }), /OPENCODE_SUBAGENT_MODEL.*provider\/model-id/);
  }
});

test("browser QA has an independent opt-in model and never inherits a text builder/subagent choice", () => {
  for (const value of [undefined, "", "  "]) {
    assert.equal(buildV2Config(base, { env: { OPENCODE_BROWSER_QA_MODEL: value } }).agents["browser-qa"], undefined);
  }
  for (const model of ["test/vision", "surplus/vendor/vision-model"]) {
    const config = buildV2Config(base, { env: { OPENCODE_SUBAGENT_MODEL: "test/text", OPENCODE_BROWSER_QA_MODEL: ` ${model} ` } });
    assert.equal(config.agents["browser-qa"].model, model);
    assert.equal(config.plugins[0].options.browserQaModel, model, "runtime model pinning uses the same deployment selection");
    assert.equal(config.agents.general.model, "test/text");
    assert.equal(config.agents.explore.model, "test/text");
  }
  for (const model of ["model-only", "/model", "provider/", "provider/model with spaces"]) {
    assert.throws(() => buildV2Config(base, { env: { OPENCODE_BROWSER_QA_MODEL: model } }), /OPENCODE_BROWSER_QA_MODEL/);
  }
});

test("v2 supplies trusted LSP settings and optional Context7 credentials without mutating its input", () => {
  const original = structuredClone(base);
  const config = buildV2Config(base, { env: {} });
  assert.equal(config.plugins[0].options.lsp.typescript.initialization.disableAutomaticTypingAcquisition, true);
  assert.equal(config.plugins[0].options.lsp.typescript.initialization.implicitProjectConfiguration.strictNullChecks, false);
  for (const name of ["typescript", "html", "css", "json"]) {
    assert.deepEqual(config.plugins[0].options.lsp[name].command, base.lsp[name].command);
  }
  assert.equal(config.mcp.servers.context7.disabled, false);
  assert.equal(config.mcp.servers.context7.oauth, false);
  assert.equal(config.mcp.servers.context7.headers, undefined);
  assert.ok(config.permissions.some((rule) => rule.action === "threadsite_docs" && rule.effect === "allow"));
  const disabled = buildV2Config(base, { env: { CONTEXT7_ENABLED: "0", CONTEXT7_API_KEY: " test-key " } });
  assert.equal(disabled.mcp.servers.context7.disabled, true);
  assert.deepEqual(disabled.mcp.servers.context7.headers, { Authorization: "Bearer test-key" });
  assert.equal(buildV2Config({ ...base, lsp: false }).plugins[0].options.lsp, false);
  assert.deepEqual(base, original);
});

test("v2 pre-selects the websearch provider so the consent form never reaches users", () => {
  const original = structuredClone(base);
  assert.deepEqual(buildV2Config(base, { env: {} }).websearch, { provider: "exa" });
  assert.deepEqual(buildV2Config(base, { env: { OPENCODE_WEBSEARCH_PROVIDER: " Tavily " } }).websearch, { provider: "tavily" });
  assert.deepEqual(buildV2Config(base, { env: { OPENCODE_WEBSEARCH_PROVIDER: "random" } }).websearch, { provider: "random" });
  assert.equal(buildV2Config(base, { env: { OPENCODE_WEBSEARCH_PROVIDER: "off" } }).websearch, false);
  assert.throws(() => buildV2Config(base, { env: { OPENCODE_WEBSEARCH_PROVIDER: "googl" } }), /OPENCODE_WEBSEARCH_PROVIDER/);
  assert.deepEqual(base, original);
});
