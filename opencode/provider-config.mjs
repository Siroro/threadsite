import { readFile } from "node:fs/promises";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : undefined;
const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"];

function merge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Invalid provider configuration key");
    result[key] = object(value) && object(result[key]) ? merge(result[key], value) : structuredClone(value);
  }
  return result;
}

// Resolve credentials only for discovery; leave native references in the config.
async function resolve(value, env) {
  if (typeof value !== "string") return value;
  const matches = [...value.matchAll(/\{(env|file):([^}]+)\}/g)];
  for (const [match, kind, key] of matches) {
    const replacement = kind === "env" ? env[key] || "" : (await readFile(key, "utf8")).trim();
    value = value.replace(match, () => replacement);
  }
  return value;
}

function catalogModel(model) {
  const inputs = model.architecture?.input_modalities ?? model.input_modalities ?? model.modalities?.input;
  const vision = (Array.isArray(inputs) && inputs.includes("image"))
    || (Array.isArray(model.supported_features) && model.supported_features.includes("vision"));
  const entry = { name: String(model.name || model.id),
    capabilities: { tools: true, input: vision ? ["text", "image"] : ["text"], output: ["text"] } };
  const context = positive(model.context_length ?? model.contextLength);
  const output = positive(model.max_completion_tokens ?? model.max_output_tokens ?? model.top_provider?.max_completion_tokens);
  if (context || output) entry.limit = { ...(context ? { context } : {}), ...(output ? { output } : {}) };
  if (Array.isArray(model.supported_parameters) && model.supported_parameters.includes("reasoning_effort")) {
    // GLM accepts low/high/max on compatible routes. These aliases preserve the
    // bot's effort selector without sending unsupported values to the model.
    const aliases = /^glm-5\.3(?:-flash(?:x)?)?$/i.test(model.id)
      ? { minimal: "low", medium: "high", xhigh: "max" } : {};
    entry.variants = efforts.map((id) => ({ id, body: { reasoning_effort: aliases[id] ?? id } }));
  }
  // OpenRouter-style catalogs quote USD/token; native OpenCode uses USD/1M.
  const price = (value) => value !== undefined && value !== null && value !== ""
    && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) * 1_000_000 : undefined;
  const input = price(model.pricing?.prompt);
  const out = price(model.pricing?.completion);
  if (input !== undefined && out !== undefined) {
    entry.cost = { input, output: out };
    const read = price(model.pricing?.input_cache_read);
    const write = price(model.pricing?.input_cache_write);
    if (read !== undefined || write !== undefined) entry.cost.cache = {
      ...(read !== undefined ? { read } : {}), ...(write !== undefined ? { write } : {}),
    };
  }
  return entry;
}

/** Native provider overrides plus optional OpenAI-compatible catalog discovery.
 * Only provider data is accepted: host settings cannot replace the agent policy.
 */
export async function applyProviderConfig(base, host = {}, {
  env = process.env, fetchImpl = globalThis.fetch, log = () => {}, warn = () => {}, defaultCatalogs = {}, defaultContextCaps = {},
} = {}) {
  if (!object(host) || Object.keys(host).some((key) => !["providers", "catalogs", "contextCaps", "$schema"].includes(key))
    || (host.providers !== undefined && !object(host.providers)) || (host.catalogs !== undefined && !object(host.catalogs))
    || (host.contextCaps !== undefined && !object(host.contextCaps))) {
    throw new Error("Provider config must contain only providers, catalogs and contextCaps objects");
  }
  const config = structuredClone(base);
  config.providers = merge(config.providers ?? {}, host.providers ?? {});
  config.contextCaps = merge(defaultContextCaps, host.contextCaps ?? {});
  for (const [ref, cap] of Object.entries(config.contextCaps)) {
    if (!/^[^\s/#]+(?:\/[^\s#]+)?$/.test(ref) || !Number.isSafeInteger(cap) || cap < 0) {
      throw new Error("contextCaps must map provider or provider/model-id references to non-negative integer token limits");
    }
  }
  const catalogs = merge(defaultCatalogs, host.catalogs ?? {});
  for (const [id, provider] of Object.entries(config.providers)) {
    if (!object(provider) || (provider.models !== undefined && !object(provider.models))) throw new Error(`Invalid provider config: ${id}`);
    const catalog = catalogs[id];
    if (catalog !== undefined && catalog !== false && (!object(catalog) || Object.keys(catalog).some((key) => key !== "contextCap")
      || (catalog.contextCap !== undefined && (!Number.isSafeInteger(catalog.contextCap) || catalog.contextCap < 0)))) {
      throw new Error(`Invalid catalog config: ${id}`);
    }
    let discovered = {};
    if (catalog) {
      const baseURL = await resolve(provider.settings?.baseURL, env);
      if (!baseURL) throw new Error(`Catalog provider ${id} needs settings.baseURL`);
      try {
        const headers = Object.fromEntries(await Promise.all(Object.entries(provider.headers ?? {})
          .map(async ([name, value]) => [name, await resolve(value, env)])));
        const apiKey = await resolve(provider.settings?.apiKey, env)
          || provider.env?.map((key) => env[key]?.trim()).find(Boolean);
        if (apiKey && !Object.keys(headers).some((name) => name.toLowerCase() === "authorization")) headers.Authorization = `Bearer ${apiKey}`;
        const response = await fetchImpl(`${baseURL.replace(/\/$/, "")}/models`, { headers, signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error("Catalog request failed");
        const payload = await response.json();
        if (!Array.isArray(payload?.data)) throw new Error("Invalid catalog response");
        for (const model of payload.data) {
          if (typeof model?.id !== "string" || !model.id || ["__proto__", "constructor", "prototype"].includes(model.id)) continue;
          const featureTools = Array.isArray(model.supported_features) && model.supported_features.includes("tools");
          if (Array.isArray(model.supported_parameters) && !model.supported_parameters.includes("tools") && !featureTools) continue;
          discovered[model.id] = catalogModel(model);
        }
        log(`[threadsite] Loaded ${Object.keys(discovered).length} model(s) for ${id}.`);
      } catch {
        // Provider bodies, URLs and exception messages may contain secrets.
        warn(`[threadsite] Could not refresh catalog for ${id}; keeping configured models.`);
      }
    }
    provider.models = merge(discovered, provider.models ?? {});
    for (const [modelID, model] of Object.entries(provider.models)) {
      if (!object(model)) throw new Error(`Invalid model config: ${id}`);
      // Unknown configured models must not gain browser access through
      // OpenCode's optimistic default image capabilities.
      model.capabilities = { input: ["text"], ...model.capabilities };
      if (catalog?.contextCap) model.limit = { ...model.limit, context: Math.min(model.limit?.context ?? catalog.contextCap, catalog.contextCap) };
      const cap = config.contextCaps[`${id}/${modelID}`] ?? config.contextCaps[id];
      // Native config overrides run after plugin transforms. Clamp explicit
      // limits here too, so they cannot restore a larger window afterwards.
      if (cap && model.limit) {
        model.limit.context = model.limit.context > 0 ? Math.min(model.limit.context, cap) : cap;
        if (model.limit.input !== undefined) model.limit.input = Math.min(model.limit.input, model.limit.context);
      }
      // Bundled models can carry endpoints/auth that outrank provider settings.
      // Apply host routing to every configured/discovered model, allowing an
      // explicit per-model route to take precedence.
      if (provider.settings) model.settings = merge(provider.settings, model.settings ?? {});
    }
  }
  for (const id of Object.keys(catalogs)) {
    if (!Object.hasOwn(config.providers, id)) throw new Error(`Catalog has no provider config: ${id}`);
  }
  return config;
}

export async function readProviderConfig(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    // JSON parser diagnostics may quote credentials from malformed input.
    throw new Error("Could not read provider config; expected valid JSON");
  }
}

const SECRET_FIELD = /(?:api[-_]?key|token|secret|password|authorization|bearer)/i;
const NATIVE_REF = /^\{(?:env|file):[^}]+\}$/;

/** Replace literal provider credentials in the config with {env:} references
 * and return the variables holding the originals. OpenCode resolves the
 * references natively at request time, so the config written to disk for the
 * server user never stores a secret, while the values stay available to the
 * server process — whose environment tool shells do not inherit. */
export function scrubProviderCredentials(config) {
  const env = {};
  const byValue = new Map();
  const replace = (value) => {
    if (typeof value !== "string" || !value || NATIVE_REF.test(value)) return value;
    let name = byValue.get(value);
    if (!name) {
      name = `THREADSITE_PROVIDER_KEY_${byValue.size}`;
      byValue.set(value, name);
      env[name] = value;
    }
    return `{env:${name}}`;
  };
  const walk = (node) => {
    for (const [key, value] of Object.entries(node ?? {})) {
      if (value && typeof value === "object") walk(value);
      else if (SECRET_FIELD.test(key)) node[key] = replace(value);
    }
  };
  for (const provider of Object.values(config.providers ?? {})) {
    // Settings and headers are merged into every model too; model IDs and other
    // provider keys must keep their exact values, so only these are walked.
    walk(provider.settings);
    walk(provider.headers);
    walk(provider.options);
    for (const model of Object.values(provider.models ?? {})) walk(model.settings);
  }
  return env;
}
