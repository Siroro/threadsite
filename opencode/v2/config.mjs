/** Native v2 configuration. Keep the checked-in v1 configuration usable as-is. */
export function buildV2Config(legacy, { pluginPath = "/opt/threadsite/v2", env = process.env } = {}) {
  const rules = (permission = {}) => Object.entries(permission).flatMap(([name, value]) => {
    const action = name === "bash" ? "shell" : name === "task" ? "subagent" : name;
    return typeof value === "string" ? [{ action, resource: "*", effect: value }]
      : Object.entries(value).map(([resource, effect]) => ({ action, resource, effect }));
  });
  const permissions = rules(legacy.permission);
  // New useful commands; writes remain constrained by the plugin and file gate.
  for (const resource of ["rg", "rg *", "find site *", "find scratch *", "rm *"]) {
    permissions.push({ action: "shell", resource, effect: "allow" });
  }
  permissions.push({ action: "threadsite_browser", resource: "*", effect: "deny" });
  permissions.push({ action: "threadsite_docs", resource: "*", effect: "allow" });
  // MCP performs its own permission check inside execute, in addition to the
  // registry's permission action. Permit only these two upstream operations.
  for (const action of ["context7_resolve-library-id", "context7_query-docs"]) {
    permissions.push({ action, resource: "*", effect: "allow" });
  }
  const agents = Object.fromEntries(Object.entries(legacy.agent).map(([id, agent]) => [id, {
    description: agent.description, mode: agent.mode, model: agent.model,
    steps: agent.maxSteps, system: id === "sitebuilder" ? builderSystem(agent.prompt) : agent.prompt,
    ...(agent.permission ? { permissions: rules(agent.permission) } : {}),
  }]));
  const subagentModel = env.OPENCODE_SUBAGENT_MODEL?.trim();
  if (subagentModel && !/^[^\s/]+\/\S+$/.test(subagentModel)) {
    throw new Error("OPENCODE_SUBAGENT_MODEL must use provider/model-id format.");
  }
  for (const id of ["general", "explore"]) {
    if (subagentModel) agents[id].model = subagentModel;
    agents[id].permissions = [...(agents[id].permissions ?? []),
      { action: "threadsite_browser", resource: "*", effect: "deny" },
      { action: "playwright_*", resource: "*", effect: "deny" },
      { action: "question", resource: "*", effect: "deny" }];
  }
  const browserQaModel = env.OPENCODE_BROWSER_QA_MODEL?.trim();
  if (browserQaModel && !/^[^\s/]+\/\S+$/.test(browserQaModel)) {
    throw new Error("OPENCODE_BROWSER_QA_MODEL must use provider/model-id format.");
  }
  if (browserQaModel) agents["browser-qa"] = {
    description: "Inspect the local preview with screenshots and browser interactions; report concrete findings without editing files.",
    mode: "subagent", model: browserQaModel, steps: 20,
    system: "You are the browser QA specialist. Follow the parent's inspection brief. "
      + "Use only browser tools on the supplied local preview or scratch URL. Inspect screenshots, requested interactions, console and local asset failures. "
      + "The preview cannot reach external origins or the multiplayer relay; those failures are environment limits, not application defects. "
      + "Do not edit files, ask the user questions or delegate. Keep inspection bounded, close the browser, and return a concise report: "
      + "checks performed, concrete defects with reproduction steps and expected/actual behavior, and untested cases. "
      + "Do not claim checks you did not perform. Your findings are advisory; the parent owns fixes and validation.",
    permissions: [{ action: "*", resource: "*", effect: "deny" },
      { action: "threadsite_browser", resource: "*", effect: "allow" },
      { action: "playwright_*", resource: "*", effect: "allow" },
      { action: "playwright.*", resource: "*", effect: "allow" }],
  };
  const providers = Object.fromEntries(Object.entries(legacy.provider ?? {}).map(([id, provider]) => [id, {
    name: provider.name, package: provider.npm, settings: provider.options,
    models: Object.fromEntries(Object.entries(provider.models ?? {}).map(([key, model]) => [key, {
      name: model.name, limit: model.limit,
      capabilities: { tools: true, input: model.modalities?.input ?? ["text"], output: ["text"] },
      ...(model.variants ? { variants: Object.entries(model.variants).map(([id, options]) => ({ id,
        body: { reasoning_effort: options.reasoningEffort ?? options.reasoning_effort ?? id } })) } : {}),
    }])),
  }]));
  return {
    update: "disable", share: "disabled", snapshots: false, default_agent: "sitebuilder",
    permissions, agents, providers,
    websearch: websearchSelection(env),
    experimental: { todo: true },
    plugins: [{ package: pluginPath, options: { lsp: lspSettings(legacy.lsp), browserQaModel } }],
    mcp: { servers: { ...Object.fromEntries(Object.entries(legacy.mcp ?? {}).map(([id, server]) => [id, {
      type: server.type, url: server.url, oauth: server.oauth, disabled: server.enabled === false,
      codemode: false, timeout: { startup: server.timeout, catalog: server.timeout, execution: server.timeout },
    }])), context7: {
      type: "remote", url: "https://mcp.context7.com/mcp", oauth: false, codemode: false,
      disabled: env.CONTEXT7_ENABLED === "0",
      ...(env.CONTEXT7_API_KEY?.trim() ? { headers: { Authorization: `Bearer ${env.CONTEXT7_API_KEY.trim()}` } } : {}),
      // Optional research must not exhaust the adapter's plugin-start deadline.
      timeout: { startup: 5000, catalog: 5000, execution: 30000 },
    } } },
    lsp: legacy.lsp, formatter: legacy.formatter,
    compaction: { auto: legacy.compaction?.auto ?? true,
      keep: { tokens: legacy.compaction?.preserve_recent_tokens ?? 15000 }, buffer: legacy.compaction?.reserved ?? 20000 },
  };
}

const websearchProviders = new Set(["exa", "firecrawl", "parallel", "tavily", "tinyfish"]);

// Without a pre-selected provider OpenCode asks a first-use consent form, which
// the question flow would surface to Discord users who cannot pick a provider
// or supply its credentials. Select it here instead.
function websearchSelection(env) {
  const provider = (env.OPENCODE_WEBSEARCH_PROVIDER ?? "").trim().toLowerCase() || "exa";
  if (["off", "disable", "disabled", "false", "none"].includes(provider)) return false;
  if (provider !== "random" && !websearchProviders.has(provider)) {
    throw new Error("OPENCODE_WEBSEARCH_PROVIDER must be exa, firecrawl, parallel, tavily, tinyfish, random or off (default: exa).");
  }
  return { provider };
}

function lspSettings(lsp) {
  if (!lsp) return false;
  const result = structuredClone(lsp);
  if (result.typescript && !result.typescript.disabled) {
    // Workspaces have no tsconfig; match the lenient ES2022 compiler gate.
    result.typescript.initialization = { ...result.typescript.initialization,
      disableAutomaticTypingAcquisition: true,
      implicitProjectConfiguration: { target: "ES2022", module: "ESNext", checkJs: false,
        strictNullChecks: false, strictFunctionTypes: false },
    };
  }
  return result;
}

function builderSystem(original) {
  // Extend the base prompt's tool discipline with the v2 shell policy (rg,
  // scoped find, rm) that the permission rules above allow. Anchored on the
  // base prompt's own sentences; if a base rewrite removes them, re-anchor
  // here so the expanded permissions keep their accompanying instruction.
  return original
    .replace(/Use read, glob, grep, and list to inspect files, and edit to author changes in permitted locations\./,
      "Use read, glob, grep, and list to inspect files, and edit, write or apply_patch to author changes in permitted locations.")
    .replace(/Use shell access only for explicitly permitted verification and asset-handling operations, never to bypass editing restrictions\./,
      "Use shell access only for explicitly permitted verification and asset-handling operations, never to bypass editing restrictions. The v2 shell policy permits rg, scoped find (no -exec, -delete or traversal outside the project) and rm: rm accepts explicit paths inside site/ or scratch/ only, with no shell operators or globbing, and never removes site/net/, generated site/js/, dotfiles or harness-owned inputs.");
}
