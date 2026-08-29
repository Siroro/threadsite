import http from "node:http";
import { Readable } from "node:stream";

/**
 * Every reasoning-effort level the Discord /effort command can select. All are
 * declared as model variants for Surplus models whose catalog entry advertises
 * `reasoning_effort`; the gateway accepts each value (verified against
 * glm-5.3-flash), so no combination can fail a turn with a 400.
 */
const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

const DEFAULT_PROXY_PORT = 18098;

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

/**
 * OpenCode serializes a selected variant's options into the request body as a
 * top-level `options: { reasoningEffort }` wrapper — not a parameter any
 * OpenAI-compatible gateway understands, so Surplus silently ignores it and
 * every request runs at the model's default effort. The proxy below rewrites
 * that wrapper into the `reasoning_effort` field the catalog advertises;
 * translation is a no-op once OpenCode sends the parameter natively.
 */
function translateEffort(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const wrapped = body.options;
  if (!wrapped || typeof wrapped !== "object") return null;
  const effort = wrapped.reasoningEffort ?? wrapped.reasoning_effort;
  if (typeof effort !== "string") return null;
  body.reasoning_effort ??= effort;
  delete wrapped.reasoningEffort;
  delete wrapped.reasoning_effort;
  if (Object.keys(wrapped).length === 0) delete body.options;
  return effort;
}

const HOP_BY_HOP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "accept-encoding",
  "upgrade",
]);

export async function startEffortProxy({ port = DEFAULT_PROXY_PORT, host = "127.0.0.1", upstreamBase, log = () => {} }) {
  const origin = new URL(upstreamBase).origin;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let outBody = Buffer.concat(chunks);
      if (req.method === "POST" && typeof req.url === "string" && req.url.includes("chat/completions")) {
        try {
          const parsed = JSON.parse(outBody.toString("utf8"));
          const effort = translateEffort(parsed);
          if (effort) {
            outBody = Buffer.from(JSON.stringify(parsed));
            log(`translated reasoning effort '${effort}' for ${parsed.model ?? "unknown model"}`);
          }
        } catch {
          // Not JSON (multipart, empty) — forward untouched.
        }
      }
      const headers = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (!HOP_BY_HOP_HEADERS.has(name) && value !== undefined) headers[name] = value;
      }
      // No abort signal: agent turns legitimately stream for many minutes.
      const upstreamRes = await fetch(origin + req.url, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : outBody,
        redirect: "manual",
      });
      const responseHeaders = {};
      const contentType = upstreamRes.headers.get("content-type");
      if (contentType) responseHeaders["content-type"] = contentType;
      res.writeHead(upstreamRes.status, responseHeaders);
      if (upstreamRes.body) Readable.fromWeb(upstreamRes.body).pipe(res);
      else res.end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`surplus-adapter proxy error: ${error}`);
    }
  });
  server.on("error", (error) => log(`proxy server error: ${error}`));
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  return server;
}

function effortVariantsFor(supportedParameters) {
  if (!Array.isArray(supportedParameters) || !supportedParameters.includes("reasoning_effort")) return undefined;
  const variants = {};
  for (const level of EFFORT_LEVELS) variants[level] = { options: { reasoningEffort: level } };
  return variants;
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

function resolveProxyPort(env, warn) {
  const raw = (env.SURPLUS_PROXY_PORT || "").trim();
  if (!raw) return DEFAULT_PROXY_PORT;
  if (/^0+(?:\.0+)?$/.test(raw)) return 0; // explicit zero disables the proxy
  const parsed = positiveNumber(raw);
  if (parsed === undefined) {
    warn(`[threadsite] Ignoring unparseable SURPLUS_PROXY_PORT=${raw}; using ${DEFAULT_PROXY_PORT}.`);
    return DEFAULT_PROXY_PORT;
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
 * and the translating effort proxy in front of the real endpoint. Returns the
 * provider entry for the generated opencode.json plus the applied context cap.
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
    discovered.set(id, contextCap ? { name: id, limit: { context: contextCap } } : { name: id });
  }

  if (apiKey) {
    try {
      const response = await fetchImpl(`${baseURL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
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
        const entry = { name: String(model.name || model.id) };
        if (context || output) {
          entry.limit = {};
          if (context) entry.limit.context = context;
          if (output) entry.limit.output = output;
        }
        const variants = effortVariantsFor(supported);
        if (variants) entry.variants = variants;
        discovered.set(model.id, entry);
        accepted += 1;
      }
      log(`[threadsite] Loaded ${accepted}/${models.length} tool-capable/unspecified Surplus model(s) from ${baseURL}/models.`);
    } catch (error) {
      warn(`[threadsite] Could not refresh Surplus model catalog; using configured/fallback list: ${error}`);
    }
  }

  // Route requests through the effort-translating proxy. If it fails to start,
  // fall back to the direct endpoint — /effort is inert in that case, but turns
  // still work at the model's default effort.
  let providerBase = baseURL;
  const proxyPort = resolveProxyPort(env, warn);
  if (proxyPort > 0) {
    try {
      await startEffortProxy({ port: proxyPort, upstreamBase: baseURL, log: (message) => log(`[surplus-proxy] ${message}`) });
      const prefix = new URL(baseURL).pathname.replace(/\/+$/, "");
      providerBase = `http://127.0.0.1:${proxyPort}${prefix}`;
      log(`[threadsite] Surplus effort proxy listening on 127.0.0.1:${proxyPort} -> ${baseURL}`);
    } catch (error) {
      warn(`[threadsite] Surplus effort proxy failed to start (${error}); connecting directly. /effort will request but not apply.`);
    }
  }

  return {
    provider: {
      npm: "@ai-sdk/openai-compatible",
      name: "Surplus Intelligence",
      options: {
        baseURL: providerBase,
        // Mirrors OpenCode's bundled Surplus definition: agent turns legitimately
        // run for many minutes, so the default client timeout is too short.
        timeout: 3_000_000,
        ...(apiKey ? { apiKey: "{env:SURPLUS_API_KEY}" } : {}),
      },
      models: Object.fromEntries([...discovered.entries()].sort(([a], [b]) => a.localeCompare(b))),
    },
    contextCap,
  };
}
