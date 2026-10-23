import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "./plugin.mjs";

test("the native plugin hides unsafe builtins and browser access on each text-only or delegated request", async () => {
  const entries = new Map(["shell", "read", "lsp", "context7_resolve-library-id", "context7_query-docs", "context7_unexpected-write", "other_query-docs", "opencode_worktree_remove", "persistent_pty", "playwright_browser_take_screenshot"].map((id) => [id, { id, name: id }]));
  const hooks = {};
  let disposed = 0;
  const registration = () => ({ dispose: async () => { disposed++; } });
  const cleanup = await plugin.setup({ location: { directory: "/workspace/project" }, options: { browserQaModel: "test/vision" },
    tool: {
      transform: async (callback) => { callback({ list: () => [...entries.values()], remove: (id) => entries.delete(id),
        update: (id, callback) => callback(entries.get(id)), add: (entry) => entries.set(entry.name, entry) }); return registration(); },
      hook: async (name, callback) => { hooks[name] = callback; return registration(); },
    },
    session: { hook: async (name, callback) => { hooks[name] = callback; return registration(); } },
    model: { list: async () => ({ data: [{ id: "vision", providerID: "test", capabilities: { input: ["text", "image"] } }] }) },
  });
  assert.equal(entries.has("opencode_worktree_remove"), false);
  assert.equal(entries.has("persistent_pty"), false);
  assert.equal(entries.has("context7_unexpected-write"), false);
  assert.equal(entries.has("other_query-docs"), false);
  assert.ok(entries.has("lsp"));
  for (const name of ["context7_resolve-library-id", "context7_query-docs"]) {
    assert.equal(entries.get(name).options.permission, "threadsite_docs");
  }
  assert.equal(entries.get("playwright_browser_take_screenshot").options.permission, "threadsite_browser");
  for (const name of ["asset_download", "asset_import", "js_syntax_check", "project_notes", "todoread"]) assert.ok(entries.has(name));
  const delegation = { tool: "subagent", input: { background: true } };
  await hooks["execute.before"](delegation);
  assert.equal(delegation.input.background, false, "publication must wait for delegated work");
  for (const [agent, model, expected] of [["sitebuilder", "vision", true], ["sitebuilder", "unknown", false], ["general", "vision", false], ["explore", "vision", false]]) {
    const event = { agent, model: { providerID: "test", id: model }, tools: { playwright_browser_take_screenshot: {}, read: {}, lsp: {}, "context7_query-docs": {} } };
    await hooks.context(event);
    assert.equal("playwright_browser_take_screenshot" in event.tools, expected);
    assert.ok("read" in event.tools);
    assert.ok("lsp" in event.tools);
    assert.ok("context7_query-docs" in event.tools);
  }
  const qa = { tool: "subagent", input: { agent: "browser-qa", model: "test/text", background: true } };
  await hooks["execute.before"](qa);
  assert.equal(qa.input.model, "test/vision", "a parent override cannot replace the configured QA model");
  assert.equal(qa.input.background, true, "inspection-only QA can run while the builder continues");
  for (const model of ["vision", "text", "unknown"]) {
    const event = { agent: "browser-qa", model: { providerID: "test", id: model }, tools: {
      playwright_browser_take_screenshot: {}, "playwright.browser_navigate": {}, read: {}, write: {}, edit: {},
      apply_patch: {}, shell: {}, subagent: {}, question: {}, project_notes: {}, context7_query_docs: {},
    } };
    await hooks.context(event);
    assert.deepEqual(Object.keys(event.tools).sort(), model === "vision"
      ? ["playwright.browser_navigate", "playwright_browser_take_screenshot"] : []);
  }
  await cleanup();
  assert.equal(disposed, 4);
});

test("QA children replace inherited browser denials without changing the builder or trusting other models", async () => {
  const hooks = {};
  const updates = [];
  let session = { id: "child", parentID: "root", agent: "browser-qa", model: { providerID: "test", id: "vision" } };
  const registration = () => ({ dispose: async () => {} });
  const cleanup = await plugin.setup({ location: { directory: "/workspace/project" }, options: { browserQaModel: "test/vision" },
    tool: { transform: async () => registration(), hook: async () => registration() },
    session: { hook: async (name, callback) => { hooks[name] = callback; return registration(); },
      get: async () => session, update: async (input) => { updates.push(input); } },
    model: { list: async () => ({ data: [{ providerID: "test", id: "vision", capabilities: { input: ["text", "image"] } }] }) },
  });
  try {
    await hooks.prompt({ sessionID: "child" });
    assert.equal(updates[0].sessionID, "child");
    assert.equal(updates[0].permissions.find((rule) => rule.action === "threadsite_browser").effect, "allow");
    assert.equal(updates[0].permissions.find((rule) => rule.action === "*").effect, "deny");
    session = { ...session, model: { providerID: "test", id: "text" } };
    await hooks.prompt({ sessionID: "child" });
    assert.deepEqual(updates[1].permissions, [{ action: "*", resource: "*", effect: "deny" }]);
    session = { ...session, agent: "sitebuilder", parentID: undefined };
    await hooks.prompt({ sessionID: "root" });
    assert.equal(updates.length, 2);
    session = { ...session, agent: "general", parentID: "root" };
    await hooks.prompt({ sessionID: "general" });
    assert.equal(updates.length, 2);
  } finally { await cleanup(); }
});

test("browser QA delegation rejects unavailable, text-only and unconfigured model choices", async () => {
  for (const browserQaModel of [undefined, "test/missing", "test/text", "test/disabled"]) {
    const hooks = {};
    const registration = () => ({ dispose: async () => {} });
    const cleanup = await plugin.setup({ location: { directory: "/workspace/project" }, options: { browserQaModel },
      tool: { transform: async () => registration(), hook: async (name, callback) => { hooks[name] = callback; return registration(); } },
      session: { hook: async () => registration() },
      model: { list: async () => ({ data: [
        { id: "text", providerID: "test", enabled: true, capabilities: { input: ["text"] } },
        { id: "disabled", providerID: "test", enabled: false, capabilities: { input: ["text", "image"] } },
      ] }) },
    });
    try {
      await assert.rejects(hooks["execute.before"]({ tool: "subagent", input: { agent: "browser-qa", model: "test/other" } }),
        /OPENCODE_BROWSER_QA_MODEL/);
    } finally { await cleanup(); }
  }
});
