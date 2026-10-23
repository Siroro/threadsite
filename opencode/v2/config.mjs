/** Apply deployment-specific models and runtime integrations to the native policy. */
export function buildV2Config(base, { pluginPath = "/opt/threadsite/v2", env = process.env } = {}) {
  const config = structuredClone(base);
  const subagentModel = env.OPENCODE_SUBAGENT_MODEL?.trim();
  if (subagentModel && !/^[^\s/]+\/\S+$/.test(subagentModel)) {
    throw new Error("OPENCODE_SUBAGENT_MODEL must use provider/model-id format.");
  }
  for (const id of ["general", "explore"]) if (subagentModel) config.agents[id].model = subagentModel;
  const browserQaModel = env.OPENCODE_BROWSER_QA_MODEL?.trim();
  if (browserQaModel && !/^[^\s/]+\/\S+$/.test(browserQaModel)) {
    throw new Error("OPENCODE_BROWSER_QA_MODEL must use provider/model-id format.");
  }
  if (browserQaModel) config.agents["browser-qa"] = {
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

  config.websearch = websearchSelection(env);
  config.plugins = [{ package: pluginPath, options: { lsp: lspSettings(config.lsp), browserQaModel, contextCaps: config.contextCaps ?? {} } }];
  delete config.contextCaps;
  config.mcp.servers.context7 = {
    type: "remote", url: "https://mcp.context7.com/mcp", oauth: false, codemode: false,
    disabled: env.CONTEXT7_ENABLED === "0",
    ...(env.CONTEXT7_API_KEY?.trim() ? { headers: { Authorization: "Bearer " + env.CONTEXT7_API_KEY.trim() } } : {}),
    timeout: { startup: 5000, catalog: 5000, execution: 30000 },
  };
  return config;
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
