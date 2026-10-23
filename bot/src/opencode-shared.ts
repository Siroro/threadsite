import path from "node:path";
import { formatTokens, formatTokensPerSecond, truncate } from "./util.js";

export interface SessionMessage {
  info?: {
    id?: string;
    sessionID?: string;
    role?: string;
    agent?: string;
    parentID?: string;
    finish?: string;
    providerID?: string;
    modelID?: string;
    model?: { providerID: string; modelID: string; variant?: string };
    variant?: string;
    error?: unknown;
    tokens?: Record<string, any>;
    cost?: number;
    time?: { created?: number; completed?: number };
  };
  parts?: Array<Record<string, any>>;
}

/** Token/context/cost accounting attributed to one model within a turn. */
export interface ModelUsage {
  /** "providerID/modelID", or "unknown" when the model was never observed. */
  model: string;
  /** Input+cache tokens billed. */
  inputTokens: number;
  /** Output+reasoning tokens produced. */
  outputTokens: number;
  /** Portion of inputTokens served from the provider's prompt cache. */
  cacheTokens: number;
  /** Provider-reported USD cost, when pricing is known. */
  cost: number;
}

/** Token/context accounting for one agent turn, accumulated from OpenCode events. */
export interface TurnUsage {
  /** Input+cache tokens billed across every model step of the turn. */
  inputTokens: number;
  /** Output+reasoning tokens produced during the turn. */
  outputTokens: number;
  /** Portion of inputTokens served from the provider's prompt cache. */
  cacheTokens: number;
  /** Context size the model was given on its most recent step (input + cache). */
  contextTokens: number;
  /** Effective context window of the active model, when the provider list resolved it. */
  contextLimit?: number;
  /** Compactions that fired during this turn. */
  compactions: number;
  /** Model steps completed during the turn (root and subagent sessions). */
  steps: number;
  /** Provider-reported USD cost across the turn; 0 when pricing is unknown. */
  cost: number;
  /** Wall-clock generation time across timed model steps; tok/s denominator. */
  generationMs?: number;
  /** Output tokens produced within those timed windows; tok/s numerator. */
  timedOutputTokens?: number;
  /** Output-token throughput across timed steps (tokens/second); undefined when no step was timed. */
  outputTokensPerSecond?: number;
  /** Per-model token/cost breakdown across every step of the turn. */
  models: ModelUsage[];
}

/** An image attachment forwarded into a prompt as a data-URI file part. */
export interface PromptImage {
  mime: string;
  filename?: string;
  dataUrl: string;
}

/** Result of one completed prompt: the assistant text plus its turn usage. */
export interface PromptResult {
  text: string;
  usage: TurnUsage;
}

/**
 * A provider quota exhausted until a known reset time — typically OpenCode's
 * free-tier daily limit, whose retry action schedules the next attempt at the
 * UTC-midnight reset. While a block is live, prompts to that provider fail
 * fast instead of every turn re-discovering the outage the slow way.
 */
export interface QuotaBlock {
  /** Provider the quota belongs to ("opencode" for the hosted free tier). */
  provider: string;
  /** Machine-readable action reason, e.g. "free_tier_limit". */
  reason: string;
  /** Short human title from the action, e.g. "Free limit reached". */
  title?: string;
  /** Action guidance, e.g. the subscribe pitch. */
  message?: string;
  /** Action link (subscribe/upgrade page), when offered. */
  link?: string;
  linkLabel?: string;
  /** Epoch ms when the provider retries — effectively the quota reset. */
  until: number;
}

/**
 * Usage a failed prompt had already observed before it threw, attached to the
 * error by OpenCodeHarness.prompt so callers can ledger failed turns. Undefined
 * for errors from calls that never entered prompt (or accumulated nothing).
 */
export function errorUsage(error: unknown): TurnUsage | undefined {
  return (error as { turnUsage?: TurnUsage } | undefined)?.turnUsage;
}

/**
 * Terminal sitebuilder assistant message: finished (or errored) after the
 * given instant. An aborted finish is not a completion — the turn was killed
 * partway (service crash, abort), so callers must continue the work rather
 * than accept the partial output as the turn's result.
 */
export function isTerminalAssistant(info: SessionMessage["info"], options: { since: number; agent: string }): boolean {
  if (!info?.id || info.role !== "assistant") return false;
  if ((info.time?.created ?? 0) < options.since - 2_000) return false;
  if (info.agent && info.agent !== options.agent) return false;
  if (info.error) return true;
  if (!info.finish || info.finish === "tool-calls" || info.finish === "aborted") return false;
  return Boolean(info.time?.completed || info.finish);
}

/** History and live events overlap: select the fuller snapshot, never add them. */
export function reconcileUsage(observed: TurnUsage | undefined, saved: TurnUsage | undefined): TurnUsage | undefined {
  if (!observed) return saved;
  if (!saved) return observed;
  const billing = saved.inputTokens + saved.outputTokens >= (observed.inputTokens ?? 0) + (observed.outputTokens ?? 0)
    ? saved : observed;
  return { ...observed, ...billing, contextLimit: observed.contextLimit ?? saved.contextLimit,
    compactions: Math.max(observed.compactions ?? 0, saved.compactions ?? 0),
    ...(observed.generationMs ? { generationMs: observed.generationMs, timedOutputTokens: observed.timedOutputTokens,
      outputTokensPerSecond: observed.outputTokensPerSecond } : {}) };
}

/** Public turn-usage line: context size, cumulative billed tokens, cache share, model steps. */
export function formatTurnUsage(usage: TurnUsage): string {
  const parts: string[] = [];
  if (usage.contextTokens > 0) {
    const limit = usage.contextLimit ? ` / ${formatTokens(usage.contextLimit)}` : "";
    parts.push(`context ${formatTokens(usage.contextTokens)}${limit}`);
  }
  // Cumulative billed usage: every model step re-reads the context, so input
  // dwarfs output on tool-heavy turns. The cached share shows whether the
  // provider is actually returning cached prefixes — near-zero means caching is
  // not engaging for this model/session.
  if (usage.inputTokens > 0 || usage.outputTokens > 0) {
    const cached = usage.cacheTokens > 0 ? ` (${formatTokens(usage.cacheTokens)} cached)` : "";
    parts.push(`in ${formatTokens(usage.inputTokens)}${cached} · out ${formatTokens(usage.outputTokens)} tok`);
  }
  // Turn-average throughput: exact provider token counts over the wall-clock
  // generation windows timed across the turn's model steps.
  if (usage.outputTokensPerSecond !== undefined && usage.outputTokensPerSecond > 0) {
    parts.push(`~${formatTokensPerSecond(usage.outputTokensPerSecond)} tok/s`);
  }
  if (usage.steps > 0) parts.push(`${usage.steps} step${usage.steps === 1 ? "" : "s"}`);
  // Cost is deliberately absent: token counts are fine to show publicly, but
  // spend data is admin-only (/site-admin usage).
  if (usage.compactions > 0) parts.push(`compacted ${usage.compactions}×`);
  return parts.join(" · ");
}

/** Combine the usage of multiple prompts that belong to one turn (e.g. a repair pass). */
export function addUsage(a: TurnUsage | undefined, b: TurnUsage | undefined): TurnUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const generationMs = (a.generationMs ?? 0) + (b.generationMs ?? 0);
  const timedOutputTokens = (a.timedOutputTokens ?? 0) + (b.timedOutputTokens ?? 0);
  // Context size/limit describe the model's latest window, not amounts to sum.
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheTokens: a.cacheTokens + b.cacheTokens,
    contextTokens: b.contextTokens || a.contextTokens,
    contextLimit: b.contextLimit ?? a.contextLimit,
    compactions: a.compactions + b.compactions,
    steps: a.steps + b.steps,
    cost: a.cost + b.cost,
    // Throughput combines as summed numerator over summed denominator, not an
    // average of rates, so a fast title pass cannot skew a slow build turn.
    ...(generationMs > 0 && timedOutputTokens > 0
      ? { generationMs, timedOutputTokens, outputTokensPerSecond: (timedOutputTokens * 1000) / generationMs }
      : {}),
    models: mergeModelUsage([...(a.models ?? []), ...(b.models ?? [])]),
  };
}

/** Sum per-model usage lists, keeping a stable cost-descending order. */
export function mergeModelUsage(entries: ModelUsage[]): ModelUsage[] {
  const merged = new Map<string, ModelUsage>();
  for (const entry of entries) {
    const current = merged.get(entry.model)
      ?? { model: entry.model, inputTokens: 0, outputTokens: 0, cacheTokens: 0, cost: 0 };
    current.inputTokens += entry.inputTokens;
    current.outputTokens += entry.outputTokens;
    current.cacheTokens += entry.cacheTokens;
    current.cost += entry.cost;
    merged.set(entry.model, current);
  }
  return [...merged.values()].sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
}

export function describeTool(tool: string, input: any, status: string, title?: string, directory?: string): { text: string; detail?: string; command?: boolean } | undefined {
  const normalized = tool.toLowerCase().replace(/-/g, "_");
  if (normalized === "subagent") {
    const agent = typeof input?.agent === "string" && input.agent ? input.agent : "subagent";
    const description = typeof input?.description === "string" ? input.description
      : typeof input?.prompt === "string" ? input.prompt : undefined;
    return {
      text: status === "running" ? `🤖 Delegating to ${agent}` : `🤖 ${agent} finished`,
      detail: description ? truncate(description, 90) : undefined,
    };
  }
  if (normalized === "websearch") return { text: status === "running" ? "🔎 Searching the web" : "🔎 Web research gathered" };
  if (normalized === "webfetch") return { text: status === "running" ? "🌐 Reading a web reference" : "🌐 Web reference read" };
  if (normalized.startsWith("playwright_")) {
    const screenshot = normalized.includes("screenshot");
    return { text: status === "running"
      ? screenshot ? "📸 Inspecting the rendered preview" : "🌐 Testing the browser preview"
      : screenshot ? "📸 Preview screenshot captured" : "🌐 Browser check complete" };
  }
  if (normalized === "asset_download") {
    const destination = typeof input?.destination === "string" ? path.basename(input.destination) : undefined;
    return { text: status === "running" ? "📥 Downloading a media asset" : "📦 Asset saved locally", detail: destination };
  }
  if (normalized === "asset_import") {
    const destination = typeof input?.destination === "string" ? path.basename(input.destination) : undefined;
    return { text: status === "running" ? "📤 Installing an uploaded file" : "📦 Upload installed into the site", detail: destination };
  }
  if (["edit", "write", "apply_patch"].includes(normalized)) {
    const target = input?.filePath ?? input?.file_path ?? input?.path ?? input?.file;
    const detail = typeof target === "string" ? projectFileLabel(target, directory) : undefined;
    return { text: status === "running" ? "✏️ Editing" : "✅ Edited", detail };
  }
  if (["read", "glob", "grep", "list"].includes(normalized)) {
    const target = input?.filePath ?? input?.file_path ?? input?.path;
    return { text: status === "running" ? "📚 Reading" : "📚 Read",
      detail: typeof target === "string" ? projectFileLabel(target, directory) : undefined };
  }
  if (normalized === "shell") {
    // The command is its own label; `command` keeps the service-wait
    // heuristics from ever matching command text.
    const command = typeof input?.command === "string" ? input.command : undefined;
    return { text: command ? truncate(command, 90) : status === "running" ? "⚙️ Command" : "✓ Command", command: true };
  }
  if (["todowrite", "todoread"].includes(normalized)) return { text: status === "running" ? "🗺️ Organising the build" : "🗺️ Plan updated" };
  if (title) return { text: status === "running" ? `⚙️ ${toolLabel(tool)}` : `✅ ${truncate(String(title), 90)}` };
  return { text: status === "running" ? `⚙️ ${toolLabel(tool)}` : `✓ ${toolLabel(tool)} finished` };
}

function projectFileLabel(file: string, directory?: string): string {
  const relative = directory && path.isAbsolute(file) ? path.relative(directory, file) : file;
  return truncate(!relative || relative.startsWith("..") || path.isAbsolute(relative) ? path.basename(file) : relative.replaceAll(path.sep, "/"), 140);
}

export function toolLabel(tool: string): string {
  return tool.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Recover billing from normalized assistant messages, counting each message once. */
export function usageFromMessages(
  messages: SessionMessage[], since = 0, until = Infinity, excludeIds = new Set<string>(),
): TurnUsage | undefined {
  const seen = new Set<string>();
  const models: ModelUsage[] = [];
  let contextTokens = 0;
  for (const message of [...messages].sort((a, b) => (a.info?.time?.created ?? 0) - (b.info?.time?.created ?? 0))) {
    const info = message.info;
    if (info?.role !== "assistant" || !info.id || seen.has(info.id) || excludeIds.has(info.id)) continue;
    const created = info.time?.created;
    if (created === undefined || created < since || created > until) continue;
    seen.add(info.id);
    if (!info.tokens) continue;
    const tokens = info.tokens;
    const cacheTokens = Number(tokens.cache?.read ?? 0) + Number(tokens.cache?.write ?? 0);
    const inputTokens = Number(tokens.input ?? 0) + cacheTokens;
    contextTokens = inputTokens;
    models.push({ model: info.providerID && info.modelID ? info.providerID + "/" + info.modelID : "unknown",
      inputTokens, outputTokens: Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0),
      cacheTokens, cost: Number(info.cost ?? 0) });
  }
  if (!models.length) return undefined;
  return { inputTokens: models.reduce((sum, model) => sum + model.inputTokens, 0),
    outputTokens: models.reduce((sum, model) => sum + model.outputTokens, 0),
    cacheTokens: models.reduce((sum, model) => sum + model.cacheTokens, 0),
    cost: models.reduce((sum, model) => sum + model.cost, 0),
    contextTokens, compactions: 0, steps: models.length, models: mergeModelUsage(models) };
}
