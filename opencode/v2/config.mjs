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
  for (const id of ["general", "explore"]) {
    agents[id].permissions = [...(agents[id].permissions ?? []),
      { action: "threadsite_browser", resource: "*", effect: "deny" },
      { action: "playwright_*", resource: "*", effect: "deny" },
      { action: "question", resource: "*", effect: "deny" }];
  }
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
    experimental: { todo: true },
    plugins: [{ package: pluginPath, options: { lsp: lspSettings(legacy.lsp) } }],
    mcp: { servers: { ...Object.fromEntries(Object.entries(legacy.mcp ?? {}).map(([id, server]) => [id, {
      type: server.type, url: server.url, oauth: server.oauth, disabled: server.enabled === false,
      codemode: false, timeout: { startup: server.timeout, catalog: server.timeout, execution: server.timeout },
    }])), context7: {
      type: "remote", url: "https://mcp.context7.com/mcp", oauth: false, codemode: false,
      disabled: env.CONTEXT7_ENABLED === "0",
      ...(env.CONTEXT7_API_KEY?.trim() ? { headers: { Authorization: `Bearer ${env.CONTEXT7_API_KEY.trim()}` } } : {}),
      timeout: { startup: 15000, catalog: 15000, execution: 30000 },
    } } },
    lsp: legacy.lsp, formatter: legacy.formatter,
    compaction: { auto: legacy.compaction?.auto ?? true,
      keep: { tokens: legacy.compaction?.preserve_recent_tokens ?? 15000 }, buffer: legacy.compaction?.reserved ?? 20000 },
  };
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
  // Replace both descriptions of the old strict allowlist, retaining the rest
  // of the builder contract (gameplay, docs, QA, scratch, durable notes).
  return original
    .replace(/You also have shell access for verification:.*?When you learn a durable project fact/s,
      "Shell access is for local verification, inspection and asset handling. The v2 policy additionally allows rg, scoped find and rm for obsolete files inside site/ or scratch/. Use edit/write/apply_patch for authored source and never shell redirection or scripts to bypass file restrictions. Git writes, package managers, curl/wget, servers and dependency changes remain harness-owned. When you learn a durable project fact")
    .replace(/Bash is an allowlist:.*?For screenshots, call/s,
      "Use the shell tool only for permitted commands. Search with rg or scoped find (no -exec, -delete or traversal); rm accepts explicit paths inside site/ or scratch/, with no shell operators or globbing. Never remove site/net/, generated site/js/, dotfiles or harness-owned inputs. Keep commands inside the current project. For screenshots, call")
    .replaceAll("use edit only for files", "use edit/write/apply_patch only for files");
}
