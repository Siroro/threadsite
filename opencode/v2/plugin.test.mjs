import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "./plugin.mjs";

test("the native plugin hides unsafe builtins and browser access on each text-only or delegated request", async () => {
  const entries = new Map(["shell", "read", "lsp", "context7_resolve-library-id", "context7_query-docs", "context7_unexpected-write", "other_query-docs", "opencode_worktree_remove", "persistent_pty", "playwright_browser_take_screenshot"].map((id) => [id, { id, name: id }]));
  const hooks = {};
  let disposed = 0;
  const registration = () => ({ dispose: async () => { disposed++; } });
  const cleanup = await plugin.setup({ location: { directory: "/workspace/project" },
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
  for (const name of ["asset_download", "js_syntax_check", "project_notes", "todoread"]) assert.ok(entries.has(name));
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
  await cleanup();
  assert.equal(disposed, 3);
});
