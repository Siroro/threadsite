import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "./plugin.mjs";

test("spawned shell commands receive only an allowlisted environment", async () => {
  const hooks = {};
  const registration = () => ({ dispose: async () => {} });
  const cleanup = await plugin.setup({ location: { directory: "/workspace/project" },
    tool: { transform: async () => registration(), hook: async () => registration() },
    session: { hook: async () => registration() },
    shell: { hook: async (name, callback) => { hooks[name] = callback; return registration(); } },
  });
  try {
    const event = { command: "node scratch/gen.js", cwd: "/workspace/project", timeout: 0, shell: "bash",
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/root", TERM: "xterm-256color", LANG: "C.UTF-8",
        OPENCODE_TERMINAL: "1", OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-ant-test",
        OPENCODE_SERVER_PASSWORD: "internal-password", THREADSITE_PROVIDER_KEY_0: "sk-live",
        ASSET_MAX_BYTES: "8388608", EXA_API_KEY: "exa-test", OPENCODE_SESSION_ID: "ses_1",
      } };
    await hooks["create.before"](event);
    assert.deepEqual(Object.keys(event.env).sort(), ["HOME", "LANG", "OPENCODE_TERMINAL", "PATH", "TERM"]);
    // A second shell with an already-minimal environment stays intact.
    const minimal = { command: "ls", cwd: "/workspace/project", timeout: 0, shell: "bash",
      env: { PATH: "/usr/bin:/bin", TERM: "dumb" } };
    await hooks["create.before"](minimal);
    assert.deepEqual(minimal.env, { PATH: "/usr/bin:/bin", TERM: "dumb" });
  } finally {
    await cleanup();
  }
});

test("concurrent first prompts cap inherited models after native config without accumulating transforms", async () => {
  const hooks = {};
  let transforms = 0;
  let disposed = 0;
  const model = { providerID: "paid", id: "alias", limit: { context: 200000, input: 180000, output: 16000 } };
  const registration = () => ({ dispose: async () => {} });
  const cleanup = await plugin.setup({ location: { directory: "/project" }, options: { contextCaps: { paid: 100000 } },
    model: { transform: async (callback) => {
      transforms++;
      callback({ list: () => [model], update: (_provider, _id, update) => update(model) });
      return { dispose: async () => { disposed++; } };
    } },
    mcp: { list: async () => ({ data: [] }) },
    tool: { transform: async () => registration(), hook: async () => registration(), reload: async () => {} },
    shell: { hook: async () => registration() },
    session: { hook: async (name, callback) => { hooks[name] = callback; return registration(); }, get: async () => ({ agent: "sitebuilder" }) },
  });
  try {
    model.limit.context = 250000;
    model.limit.input = 200000;
    await Promise.all([hooks.prompt({ sessionID: "first" }), hooks.prompt({ sessionID: "second" })]);
    await hooks.prompt({ sessionID: "third" });
    assert.deepEqual(model.limit, { context: 100000, input: 100000, output: 16000 });
    assert.equal(transforms, 2, "one initial transform plus one shared final transform covers every prompt");
  } finally { await cleanup(); }
  assert.equal(disposed, transforms, "plugin cleanup must dispose every cap transform");
});

test("first prompts wait for MCP discovery and refresh tools before selecting the registry", async () => {
  const hooks = {};
  const calls = [];
  const registration = () => ({ dispose: async () => {} });
  let pending = true;
  const cleanup = await plugin.setup({ location: { directory: "/second" },
    mcp: { list: async ({ location }) => {
      assert.equal(location.directory, "/second");
      calls.push("discovery");
      const status = pending ? "pending" : "connected";
      pending = false;
      return { data: [{ name: "playwright", status: { status } }, { name: "context7", status: { status: "failed", error: "offline" } }] };
    } },
    tool: { transform: async () => registration(), hook: async () => registration(), reload: async () => { calls.push("tools"); } },
    shell: { hook: async () => registration() },
    session: { hook: async (name, callback) => { hooks[name] = callback; return registration(); },
      get: async () => { calls.push("session"); return { agent: "sitebuilder" }; } },
  });
  try {
    await hooks.prompt({ sessionID: "first" });
    assert.deepEqual(calls, ["discovery", "discovery", "tools", "session"]);
  } finally { await cleanup(); }
});

test("browser capability filtering queries the plugin workspace rather than the server's default location", async () => {
  const hooks = {};
  const registration = () => ({ dispose: async () => {} });
  const cleanup = await plugin.setup({ location: { directory: "/second" },
    tool: { transform: async () => registration(), hook: async () => registration() },
    shell: { hook: async () => registration() },
    session: { hook: async (name, callback) => { hooks[name] = callback; return registration(); } },
    model: { list: async (input) => ({ data: [{ id: "vision", providerID: "test", enabled: true,
      capabilities: { input: input?.location?.directory === "/second" ? ["text", "image"] : ["text"] } }] }) },
  });
  try {
    const event = (agent, id = "vision") => ({ agent, model: { providerID: "test", id }, tools: { playwright_browser_navigate: {}, read: {} } });
    const builder = event("sitebuilder");
    await hooks.context(builder);
    assert.ok(builder.tools.playwright_browser_navigate);
    for (const item of [event("general"), event("explore"), event("sitebuilder", "missing")]) {
      await hooks.context(item);
      assert.equal(item.tools.playwright_browser_navigate, undefined);
      assert.ok(item.tools.read);
    }
  } finally { await cleanup(); }
});

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
    shell: { hook: async () => registration() },
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
  assert.equal(disposed, 5);
});

test("screenshot calls drop workspace-bound save targets instead of failing on the read-only mount", async () => {
  const hooks = {};
  const registration = () => ({ dispose: async () => {} });
  const cleanup = await plugin.setup({ location: { directory: "/workspace/project" },
    tool: { transform: async () => registration(), hook: async (name, callback) => { hooks[name] = callback; return registration(); } },
    shell: { hook: async () => registration() },
    session: { hook: async () => registration() },
  });
  try {
    const shoot = async (input) => {
      const event = { tool: "playwright_browser_take_screenshot", input: { ...input } };
      await hooks["execute.before"](event);
      return event.input;
    };
    // The observed failures: scratch/tmp/qa targets that EROFS/ENOENT in the
    // preview container. The image still returns as content without them.
    assert.equal((await shoot({ filename: "scratch/qa/ww-start.png" })).filename, undefined);
    assert.equal((await shoot({ filename: "tmp/start.png" })).filename, undefined);
    assert.equal((await shoot({ rawPath: "/workspace/project/tmp/shot.png" })).rawPath, undefined);
    assert.equal((await shoot({ filename: "./x.png" })).filename, undefined);
    assert.equal((await shoot({ filename: "shot.png" })).filename, "shot.png",
      "a bare name saves into the MCP's own output dir and harms nothing");
  } finally { await cleanup(); }
});

test("QA children replace inherited browser denials without changing the builder or trusting other models", async () => {
  const hooks = {};
  const updates = [];
  let session = { id: "child", parentID: "root", agent: "browser-qa", model: { providerID: "test", id: "vision" } };
  const registration = () => ({ dispose: async () => {} });
  const cleanup = await plugin.setup({ location: { directory: "/workspace/project" }, options: { browserQaModel: "test/vision" },
    mcp: { list: async () => ({ data: [] }) },
    tool: { transform: async () => registration(), hook: async () => registration(), reload: async () => {} },
    shell: { hook: async () => registration() },
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
      shell: { hook: async () => registration() },
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

function assetDelegationFixture(options, sessionModel, catalog) {
  const hooks = {};
  const registration = () => ({ dispose: async () => {} });
  return plugin.setup({ location: { directory: "/workspace/project" }, options,
    tool: { transform: async () => registration(), hook: async (name, callback) => { hooks[name] = callback; return registration(); } },
    shell: { hook: async () => registration() },
    session: { hook: async () => registration(), get: async () => ({ agent: "sitebuilder", ...(sessionModel ? { model: sessionModel } : {}) }) },
    model: { list: async () => ({ data: catalog ?? [
      { id: "text", providerID: "test", enabled: true, capabilities: { input: ["text"] } },
      { id: "vision", providerID: "test", enabled: true, capabilities: { input: ["text", "image"] },
        variants: [{ id: "high" }, { id: "low" }] },
      { id: "surplus", providerID: "paid", enabled: true, capabilities: { input: ["text", "image"] } },
      { id: "disabled", providerID: "test", enabled: false, capabilities: { input: ["text", "image"] } },
    ] }) },
  }).then((cleanup) => ({ hooks, cleanup }));
}

test("asset-forge delegation defaults to the selected model, then falls back; the parent cannot choose", async () => {
  // Selected model is image-capable: it is pinned with its variant.
  {
    const { hooks, cleanup } = await assetDelegationFixture({}, { providerID: "test", id: "vision", variant: "high" });
    try {
      const input = { agent: "asset-forge", model: "test/text", background: true };
      await hooks["execute.before"]({ tool: "subagent", sessionID: "ses_root", input });
      assert.equal(input.model, "test/vision#high");
      assert.equal(input.background, true, "asset creation may run while the builder continues");
    } finally { await cleanup(); }
  }
  // Text-only selection: the first healthy fallback takes over.
  {
    const { hooks, cleanup } = await assetDelegationFixture({ assetFallbacks: ["test/disabled", "paid/surplus"] },
      { providerID: "test", id: "text" });
    try {
      const input = { agent: "asset-forge" };
      await hooks["execute.before"]({ tool: "subagent", sessionID: "ses_root", input });
      assert.equal(input.model, "paid/surplus");
    } finally { await cleanup(); }
  }
  // A configured pin wins over the selected model, even when both are usable.
  {
    const { hooks, cleanup } = await assetDelegationFixture({ assetModel: "paid/surplus" }, { providerID: "test", id: "vision" });
    try {
      const input = { agent: "asset-forge", model: "test/text" };
      await hooks["execute.before"]({ tool: "subagent", sessionID: "ses_root", input });
      assert.equal(input.model, "paid/surplus");
    } finally { await cleanup(); }
  }
  // No image-capable candidate anywhere: delegation fails with guidance.
  {
    const { hooks, cleanup } = await assetDelegationFixture({}, { providerID: "test", id: "text" });
    try {
      await assert.rejects(hooks["execute.before"]({ tool: "subagent", sessionID: "ses_root", input: { agent: "asset-forge" } }),
        /asset-forge unavailable/);
    } finally { await cleanup(); }
  }
  // Explicitly disabled.
  {
    const { hooks, cleanup } = await assetDelegationFixture({ assetModel: false }, { providerID: "test", id: "vision" });
    try {
      await assert.rejects(hooks["execute.before"]({ tool: "subagent", sessionID: "ses_root", input: { agent: "asset-forge" } }),
        /asset-forge is disabled/);
    } finally { await cleanup(); }
  }
});

test("asset-forge keeps sourcing and creation tools while research agents and text models get none", async () => {
  const hooks = {};
  const registration = () => ({ dispose: async () => {} });
  const cleanup = await plugin.setup({ location: { directory: "/workspace/project" },
    tool: { transform: async () => registration(), hook: async () => registration() },
    shell: { hook: async () => registration() },
    session: { hook: async (name, callback) => { hooks[name] = callback; return registration(); } },
    model: { list: async () => ({ data: [
      { id: "text", providerID: "test", enabled: true, capabilities: { input: ["text"] } },
      { id: "vision", providerID: "test", enabled: true, capabilities: { input: ["text", "image"] } },
    ] }) },
  });
  try {
    const event = (agent, id, extra = {}) => ({ agent, model: { providerID: "test", id }, tools: {
      read: {}, write: {}, edit: {}, apply_patch: {}, glob: {}, grep: {}, list: {}, shell: {},
      asset_save: {}, asset_preview: {}, asset_download: {}, asset_import: {}, websearch: {},
      webfetch: {}, subagent: {}, question: {}, project_notes: {}, todowrite: {}, lsp: {},
      playwright_browser_navigate: {},
    }, ...extra });
    const creator = event("asset-forge", "vision");
    await hooks.context(creator);
    assert.deepEqual(Object.keys(creator.tools).sort(), ["apply_patch", "asset_download", "asset_import",
      "asset_preview", "asset_save", "edit", "glob", "grep", "list", "playwright_browser_navigate",
      "read", "shell", "webfetch", "websearch", "write"]);
    const blindCreator = event("asset-forge", "text");
    await hooks.context(blindCreator);
    assert.equal(blindCreator.tools.asset_preview, undefined, "a text-only creator cannot review visuals");
    assert.equal(blindCreator.tools.playwright_browser_navigate, undefined, "a text-only creator gets no browser");
    assert.ok(blindCreator.tools.asset_save);
    assert.ok(blindCreator.tools.webfetch);
    for (const [agent, id] of [["sitebuilder", "vision"], ["sitebuilder", "text"], ["general", "vision"], ["explore", "vision"]]) {
      const item = event(agent, id);
      await hooks.context(item);
      assert.equal(item.tools.asset_save, undefined, `${agent} never installs generated assets directly`);
      assert.equal("asset_preview" in item.tools, agent === "sitebuilder" && id === "vision", `${agent}/${id} preview gating`);
    }
  } finally { await cleanup(); }
});

test("asset-forge children re-apply their creator profile and earn browser rules on vision models", async () => {
  const hooks = {};
  const updates = [];
  const profile = [{ action: "*", resource: "*", effect: "deny" },
    { action: "asset_save", resource: "*", effect: "allow" },
    { action: "edit", resource: "site/assets/**", effect: "allow" }];
  let session = { id: "child", parentID: "root", agent: "asset-forge", model: { providerID: "test", id: "vision" } };
  const registration = () => ({ dispose: async () => {} });
  const cleanup = await plugin.setup({ location: { directory: "/workspace/project" },
    options: { assetPermissions: profile },
    mcp: { list: async () => ({ data: [] }) },
    tool: { transform: async () => registration(), hook: async () => registration(), reload: async () => {} },
    shell: { hook: async () => registration() },
    session: { hook: async (name, callback) => { hooks[name] = callback; return registration(); },
      get: async () => session, update: async (input) => { updates.push(input); } },
    model: { list: async () => ({ data: [
      { providerID: "test", id: "vision", enabled: true, capabilities: { input: ["text", "image"] } },
      { providerID: "test", id: "text", enabled: true, capabilities: { input: ["text"] } },
    ] }) },
  });
  try {
    await hooks.prompt({ sessionID: "child" });
    const visionRules = updates[0].permissions;
    assert.deepEqual(visionRules.slice(0, profile.length), structuredClone(profile), "the configured creator profile is re-applied verbatim");
    assert.ok(visionRules.slice(profile.length).every((rule) => ["threadsite_browser", "playwright_*", "playwright.*"].includes(rule.action) && rule.effect === "allow"),
      "a vision creator also earns browser rules");
    session = { ...session, model: { providerID: "test", id: "text" } };
    await hooks.prompt({ sessionID: "child" });
    assert.deepEqual(updates[1].permissions, structuredClone(profile), "a text creator gets the profile without browser rules");
    session = { ...session, agent: "asset-forge", parentID: undefined };
    await hooks.prompt({ sessionID: "root" });
    assert.equal(updates.length, 2, "parent sessions are never rewritten");
    session = { ...session, parentID: "root", agent: "general" };
    await hooks.prompt({ sessionID: "general" });
    assert.equal(updates.length, 2, "research children keep inherited rules");
  } finally { await cleanup(); }
});
