import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";

const templatePath = "/opt/threadsite/opencode.base.json";
const outputPath = "/root/.config/opencode/opencode.json";
const baseURL = (process.env.SURPLUS_BASE_URL || "https://api.surplusintelligence.ai/v1").replace(/\/$/, "");
const apiKey = (process.env.SURPLUS_API_KEY || "").trim();
const configuredModels = (process.env.SURPLUS_MODELS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

// Artificial context ceiling for Surplus models. OpenCode decides when a session is
// "full" (and therefore when auto-compaction fires) against limit.context, so capping
// it here keeps long Discord threads compacting early instead of growing into huge
// provider windows. Default 100k; set SURPLUS_CONTEXT_CAP=0 to disable.
function resolveContextCap() {
  const raw = (process.env.SURPLUS_CONTEXT_CAP || "").trim();
  if (!raw) return 100_000;
  if (/^0+(?:\.0+)?$/.test(raw)) return 0; // explicit zero disables the cap
  const parsed = positiveNumber(raw);
  if (parsed === undefined) {
    console.warn(`[threadsite] Ignoring unparseable SURPLUS_CONTEXT_CAP=${raw}; using 100000.`);
    return 100_000;
  }
  return parsed;
}
const contextCap = resolveContextCap();

const fallbackModels = [
  "claude-opus-4.8",
  "claude-sonnet-4.6",
  "gpt-5.5",
  "glm-4.7",
  "deepseek-v4-pro",
  "gemini-3.1-pro",
];

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

const config = JSON.parse(await readFile(templatePath, "utf8"));
const discovered = new Map();

for (const id of configuredModels.length ? configuredModels : fallbackModels) {
  // Fallback entries carry no catalog metadata; give them the cap so the ceiling
  // still applies when discovery could not run.
  discovered.set(id, contextCap ? { name: id, limit: { context: contextCap } } : { name: id });
}

if (apiKey) {
  try {
    const response = await fetch(`${baseURL}/models`, {
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
      discovered.set(model.id, entry);
      accepted += 1;
    }
    console.log(`[threadsite] Loaded ${accepted}/${models.length} tool-capable/unspecified Surplus model(s) from ${baseURL}/models.`);
  } catch (error) {
    console.warn(`[threadsite] Could not refresh Surplus model catalog; using configured/fallback list: ${error}`);
  }
}

config.provider ||= {};
config.provider.surplus = {
  npm: "@ai-sdk/openai-compatible",
  name: "Surplus Intelligence",
  options: {
    baseURL,
    ...(apiKey ? { apiKey: "{env:SURPLUS_API_KEY}" } : {}),
  },
  models: Object.fromEntries([...discovered.entries()].sort(([a], [b]) => a.localeCompare(b))),
};

await mkdir("/root/.config/opencode", { recursive: true });
await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

console.log(
  `[threadsite] Surplus provider configured with ${discovered.size} model id(s)` +
    (contextCap ? ` and a ${contextCap}-token context cap (auto-compaction ceiling).` : " without a context cap."),
);

const logLevel = (process.env.OPENCODE_LOG_LEVEL || "INFO").toUpperCase();
const child = spawn("opencode", ["--print-logs", "--log-level", logLevel, "serve", "--hostname", "0.0.0.0", "--port", "4096"], {
  stdio: "inherit",
  env: process.env,
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
