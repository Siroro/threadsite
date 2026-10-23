const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function effortVariantsFor(modelID, supportedParameters) {
  if (!Array.isArray(supportedParameters) || !supportedParameters.includes("reasoning_effort")) return undefined;
  // GLM's native tiers are low/high/max. Send those exact values across all
  // serving routes so unsupported aliases cannot fall back to default effort.
  const glm53 = /^glm-5\.3(?:-flash(?:x)?)?$/i.test(modelID);
  const effective = { minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" };
  return EFFORT_LEVELS.map((id) => ({ id, body: { reasoning_effort: glm53 ? effective[id] : id } }));
}

// The marketplace treats either catalog signal as image support. Do not infer
// vision from model names: a text model with a similar name still cannot see.
function imageCapabilities(model) {
  const inputs = model.architecture?.input_modalities ?? model.input_modalities ?? model.modalities?.input;
  const features = model.supported_features;
  if (!Array.isArray(inputs) && !Array.isArray(features)) return { capabilities: { tools: true, input: ["text"], output: ["text"] } };
  const vision = (Array.isArray(inputs) && inputs.includes("image"))
    || (Array.isArray(features) && features.includes("vision"));
  return {
    capabilities: { tools: true, input: vision ? ["text", "image"] : ["text"], output: ["text"] },
  };
}

/**
 * Artificial context ceiling for Surplus models. OpenCode decides when a session is
 * "full" (and therefore when auto-compaction fires) against limit.context, so capping
 * it here keeps long Discord threads compacting early instead of growing into huge
 * provider windows. Default 100k; set SURPLUS_CONTEXT_CAP=0 to disable.
 */
function resolveContextCap(env) {
  const raw = (env.SURPLUS_CONTEXT_CAP || "").trim();
  if (!raw) return 100_000;
  if (/^0+(?:\.0+)?$/.test(raw)) return 0; // explicit zero disables the cap
  const parsed = positiveNumber(raw);
  if (parsed === undefined) {
    return 100_000;
  }
  return parsed;
}

const FALLBACK_MODELS = [
  "claude-opus-4.8",
  "claude-sonnet-4.6",
  "gpt-5.5",
  "glm-4.7",
  "deepseek-v4-pro",
  "gemini-3.1-pro",
];

/**
 * Builds the OpenCode provider config for Surplus: catalog discovery (with the
 * context cap), reasoning-effort variants for models that support the parameter,
 * using native request bodies. Returns the provider entry for the generated
 * opencode.json plus the applied context cap.
 */
export async function buildSurplusProvider({ env = process.env, fetchImpl = globalThis.fetch, log = () => {}, warn = () => {} }) {
  const baseURL = (env.SURPLUS_BASE_URL || "https://api.surplusintelligence.ai/v1").replace(/\/$/, "");
  const apiKey = (env.SURPLUS_API_KEY || "").trim();
  const configuredModels = (env.SURPLUS_MODELS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const contextCap = resolveContextCap(env);
  const discovered = new Map();

  for (const id of configuredModels.length ? configuredModels : FALLBACK_MODELS) {
    // Fallback entries carry no catalog metadata; give them the cap so the ceiling
    // still applies when discovery could not run. No variants either — without
    // catalog metadata we cannot know which models accept reasoning_effort.
    discovered.set(id, { name: id, capabilities: { tools: true, input: ["text"], output: ["text"] }, ...(contextCap ? { limit: { context: contextCap } } : {}) });
  }

  // Discovery is public. Refresh capabilities even when the key is stored in
  // OpenCode auth rather than supplied through this service's environment.
  {
    try {
      const response = await fetchImpl(`${baseURL}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      const payload = await response.json();
      const models = Array.isArray(payload?.data) ? payload.data : [];
      let accepted = 0;
      for (const model of models) {
        if (!model?.id || typeof model.id !== "string") continue;
        const supported = Array.isArray(model.supported_parameters) ? model.supported_parameters.map(String) : undefined;
        // Surplus exposes non-chat media/embedding models in the same catalog. If the
        // catalog tells us a model has no tool calling, do not advertise it as a coding agent.
        if (supported && !supported.includes("tools")) continue;

        const reportedContext = positiveNumber(model.context_length ?? model.contextLength);
        const context = contextCap ? Math.min(reportedContext ?? contextCap, contextCap) : reportedContext;
        const output = positiveNumber(
          model.max_completion_tokens ?? model.max_output_tokens ?? model.top_provider?.max_completion_tokens,
        );
        const entry = { name: String(model.name || model.id), ...imageCapabilities(model) };
        if (context || output) {
          entry.limit = {};
          if (context) entry.limit.context = context;
          if (output) entry.limit.output = output;
        }
        const variants = effortVariantsFor(model.id, supported);
        if (variants) entry.variants = variants;
        discovered.set(model.id, entry);
        accepted += 1;
      }
      log(`[threadsite] Loaded ${accepted}/${models.length} tool-capable/unspecified Surplus model(s) from ${baseURL}/models.`);
    } catch (error) {
      warn(`[threadsite] Could not refresh Surplus model catalog; using configured/fallback list: ${error}`);
    }
  }

  // Bundled catalog models carry their own endpoint settings, which take
  // precedence over provider settings. Keep custom endpoints and auth aligned
  // for both discovered and newly configured models.
  const settings = {
    baseURL,
    timeout: 3_000_000,
    ...(apiKey ? { apiKey: "{env:SURPLUS_API_KEY}" } : {}),
  };
  for (const model of discovered.values()) model.settings = { ...settings };

  return {
    provider: {
      package: "@ai-sdk/openai-compatible",
      name: "Surplus Intelligence",
      settings,
      models: Object.fromEntries([...discovered.entries()].sort(([a], [b]) => a.localeCompare(b))),
    },
    contextCap,
  };
}
