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
  assert.equal(config.experimental.todo, true);
  assert.equal(config.snapshots, false);
  for (const id of ["general", "explore"]) {
    assert.equal(config.agents[id].model, original.agents[id].model);
    assert.ok(config.agents[id].permissions.some((rule) => rule.action === "threadsite_browser" && rule.effect === "deny"));
  }
  assert.ok(config.permissions.some((rule) => rule.action === "shell" && rule.resource === "git *" && rule.effect === "deny"));
  assert.ok(config.permissions.some((rule) => rule.action === "edit" && rule.resource === "README.agent.md" && rule.effect === "allow"));
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

test("asset-forge exists by default, inherits the selected model and pins an optional override", () => {
  const original = structuredClone(base);
  const defaults = buildV2Config(base, { env: {} });
  const agent = defaults.agents["asset-forge"];
  assert.equal(agent.mode, "subagent");
  assert.equal(agent.model, undefined, "unset model lets the child inherit the parent session model");
  assert.equal(defaults.plugins[0].options.assetModel, undefined);
  assert.deepEqual(defaults.plugins[0].options.assetFallbacks, []);
  const allows = (action, resource) => agent.permissions.filter((rule) => rule.action === action && rule.effect === "allow"
    && (resource === undefined || rule.resource === resource));
  for (const action of ["asset_save", "asset_preview", "asset_download", "asset_import", "websearch", "webfetch",
    "threadsite_browser", "playwright_*"]) assert.ok(allows(action).length, `${action} allowed`);
  // Creation edits assets and scratch, never game source; rm is scoped by the
  // command-policy hook to explicit site/scratch paths.
  assert.deepEqual(allows("edit").map((rule) => rule.resource).sort(), ["*/scratch/**", "*/site/assets/**", "scratch/**", "site/assets/**"]);
  assert.ok(allows("shell", "rm").length && allows("shell", "rm *").length);
  assert.equal(allows("shell", "git *").length + allows("shell", "npm *").length + allows("shell", "curl *").length, 0);
  assert.ok(agent.permissions[0].action === "*" && agent.permissions[0].effect === "deny");
  assert.deepEqual(defaults.plugins[0].options.assetPermissions, agent.permissions,
    "the prompt hook re-applies exactly the configured profile");

  const pinned = buildV2Config(base, { env: { OPENCODE_ASSET_MODEL: " test/vision#high " } });
  assert.equal(pinned.agents["asset-forge"].model, "test/vision#high");
  assert.equal(pinned.plugins[0].options.assetModel, "test/vision#high");

  const fallbacks = buildV2Config(base, { env: { OPENCODE_ASSET_FALLBACK_MODELS: " a/b , surplus/vendor/m , c/d#low " } });
  assert.deepEqual(fallbacks.plugins[0].options.assetFallbacks, ["a/b", "surplus/vendor/m", "c/d#low"]);
  assert.deepEqual(buildV2Config(base, { env: {} }).agents["asset-forge"].permissions, defaults.agents["asset-forge"].permissions);
  assert.deepEqual(base, original);
});

test("asset-forge can be disabled and rejects malformed model references at startup", () => {
  for (const off of ["off", " disable ", "DISABLED", "false", "None"]) {
    const config = buildV2Config(base, { env: { OPENCODE_ASSET_MODEL: off } });
    assert.equal(config.agents["asset-forge"], undefined, off);
    assert.equal(config.plugins[0].options.assetModel, false, off);
  }
  for (const model of ["model-only", "/model", "provider/", "provider/model with spaces"]) {
    assert.throws(() => buildV2Config(base, { env: { OPENCODE_ASSET_MODEL: model } }), /OPENCODE_ASSET_MODEL/);
  }
  assert.throws(() => buildV2Config(base, { env: { OPENCODE_ASSET_FALLBACK_MODELS: "a/b, nope" } }), /OPENCODE_ASSET_FALLBACK_MODELS/);
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
