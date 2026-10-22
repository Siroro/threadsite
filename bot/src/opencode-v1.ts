import path from "node:path";
import { Agent } from "undici";
// The v2 entrypoint of the same pinned SDK package: same wire routes as v1 for
// everything the harness uses, plus a typed question namespace (absent in v1).
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { config } from "./config.js";
import { log, logError, serializeError } from "./logger.js";
import type { ProgressCallback, ProgressPlanItem, ProgressUpdate } from "./progress.js";
import { steeringInstruction } from "./templates.js";
import { TurnStepBudget, finishUpInstruction } from "./step-budget.js";
import { cleanThreadTitle, errorText, formatShortDuration, formatTokens, formatTokensPerSecond, formatUtcClock, parseModel, truncate, sleep } from "./util.js";

// Sent to a session whose turn was killed by an agent-service restart. The
// workspace keeps the turn's partial edits, so this must continue, not restart.
const CONTINUE_AFTER_RESTART =
  "Your previous turn was interrupted by a service restart. Inspect the workspace for partial edits from that turn, "
  + "continue exactly where it left off, finish the requested change (do not start over), and summarize what you did.";

// Live throughput meter (⚡ tok/s): streaming part updates carry no token
// counts, so live samples estimate tokens from text growth at ~5 bytes/token
// (the heuristic opencode-tps uses); exact figures still arrive per step in
// step-finish parts and drive the turn-average rate.
const LIVE_TPS_WINDOW_MS = 5_000;
const LIVE_TPS_STALE_MS = 1_500;
const LIVE_TPS_MIN_WINDOW_MS = 250;
const LIVE_STATS_EMIT_MS = 3_000;
// A generation window longer than this means the anchors were lost (stream
// drop, parked turn); counting it would sink the turn average, so the step's
// tokens stay in the totals but drop out of the rate.
const MAX_TIMED_STEP_MS = 10 * 60_000;

// Undici's default 5-minute headers/body timeouts kill requests for long agent
// turns while the turn keeps running server-side; 0 disables them and the
// reconcile pipeline (OPENCODE_RECONCILE_TIMEOUT_MS) supervises instead.
const opencodeAgent = new Agent({
  headersTimeout: config.opencodeRequestHeadersTimeoutMs,
  bodyTimeout: config.opencodeRequestBodyTimeoutMs,
});

function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
  if (config.opencodePassword) {
    headers.set(
      "Authorization",
      `Basic ${Buffer.from(`${config.opencodeUsername}:${config.opencodePassword}`).toString("base64")}`,
    );
  }
  return fetch(input, { ...init, headers, dispatcher: opencodeAgent } as RequestInit);
}

function unwrap<T>(result: any, operation: string): T {
  if (result?.error) {
    const error = result.error;
    // Error instances (network failures from the SDK's in-band error path)
    // stringify to "{}", so describe them from their name/message/cause chain
    // and keep the original as cause — transport detection and error
    // classification downstream both read that chain.
    const text = typeof error === "string"
      ? error
      : error instanceof Error
        ? diagnosticText(error)
        : JSON.stringify(error);
    throw new OpenCodeRequestError(`${operation} failed: ${text}`, { operation, response: error }, { cause: error });
  }
  return (result?.data ?? result) as T;
}

class OpenCodeRequestError extends Error {
  constructor(message: string, readonly details: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "OpenCodeRequestError";
  }
}

class OpenCodeReconciliationError extends Error {
  readonly mayStillBeRunning: boolean;
  constructor(message: string, readonly details: Record<string, unknown>, options?: { cause?: unknown; mayStillBeRunning?: boolean }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "OpenCodeReconciliationError";
    this.mayStillBeRunning = options?.mayStillBeRunning ?? false;
  }
}

interface EventStreamHandle {
  stop(): void;
  done: Promise<void>;
}

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

interface PromptSnapshot {
  ids: Set<string>;
  startedAt: number;
  agent: string;
  /** Session-lifetime compaction count when the turn started, from persisted CompactionParts. */
  compactions: number;
}

// Per-turn state accumulated from the OpenCode event stream so the Discord
// progress message can show real model output, not only harness stages.
interface TurnState {
  assistantMessageIds: Set<string>;
  finishedParts: Set<string>;
  /** Output+reasoning tokens produced during this turn. */
  outputTokens: number;
  /** Input+cache tokens billed across every model step of this turn. */
  inputTokens: number;
  /** Portion of inputTokens served from the provider's prompt cache. */
  cacheTokens: number;
  /** Context size the model was given on its most recent step (input + cache). */
  contextTokens: number;
  /** Effective context window of the active model, when the provider list resolved it. */
  contextLimit?: number;
  cost: number;
  /** Model steps (step-finish parts) completed this turn, root and subagents. */
  steps: number;
  /** Session-lifetime compaction count; starts at the pre-turn baseline. */
  compactions: number;
  /** Value `compactions` started at, so per-turn deltas are distinguishable. */
  baselineCompactions: number;
  model?: { providerID: string; modelID: string };
  /** Subagent sessions (task-tool children of the root session) seen this turn. */
  childSessions: Set<string>;
  /** messageID -> "providerID/modelID" for assistant messages seen this turn (root and subagent children). */
  messageModels: Map<string, string>;
  /** Per-model token/cost totals; steps whose model was never observed land in "unknown". */
  modelUsage: Map<string, { inputTokens: number; outputTokens: number; cacheTokens: number; cost: number }>;
  /** Turn start (prompt snapshot time): fallback timing anchor. */
  startedAt: number;
  /** Wall-clock generation time (ms) summed over timed steps; tok/s denominator. */
  generationMs: number;
  /** Output tokens produced within those timed windows; tok/s numerator. */
  timedOutputTokens: number;
  /** When each in-flight assistant message was first sighted; per-step timing anchor. */
  stepStartAtByMessage: Map<string, number>;
  /** Time of the most recent step-finish; fallback anchor for messages first seen late. */
  lastStepFinishAt: number;
  /** Whether the inter-step fallback anchor measures generation. True only for live
   * streams, where steps run sequentially between finishes; history rebuilds lack
   * message sightings, so their fallback windows would measure event-processing
   * gaps (millisecond bursts when parallel steps finish together), not generation. */
  liveAnchors: boolean;
  /** Rolling live-meter samples: estimated tokens with timestamps. */
  liveTokenSamples: Array<{ tokens: number; at: number }>;
  /** Last accumulated byte length per streaming part key, for growth sampling. */
  livePartBytes: Map<string, number>;
  /** Parts already sampled via delta events; growth sampling skips them so the two never double-count. */
  deltaFedParts: Set<string>;
  /** When the ⚡ live stats line was last emitted (throttle). */
  lastLiveStatsAt: number;
  /** Quota-exhaustion action observed mid-turn (free_tier_limit etc.), so the failure names the reset. */
  quotaBlock?: QuotaBlock;
}

function createTurnState(startedAt: number, compactions: number, liveAnchors = true): TurnState {
  return {
    assistantMessageIds: new Set<string>(),
    finishedParts: new Set<string>(),
    outputTokens: 0,
    inputTokens: 0,
    cacheTokens: 0,
    contextTokens: 0,
    cost: 0,
    steps: 0,
    compactions,
    baselineCompactions: compactions,
    childSessions: new Set<string>(),
    messageModels: new Map(),
    modelUsage: new Map(),
    startedAt,
    generationMs: 0,
    timedOutputTokens: 0,
    stepStartAtByMessage: new Map(),
    lastStepFinishAt: startedAt,
    liveAnchors,
    liveTokenSamples: [],
    livePartBytes: new Map(),
    deltaFedParts: new Set(),
    lastLiveStatsAt: 0,
  };
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

const quotaUntil = (block: { until: number }): string =>
  `~${formatUtcClock(block.until)} (in ${formatShortDuration(block.until - Date.now())})`;

export class OpenCodeHarness {
  private readonly client = createOpencodeClient({
    baseUrl: config.opencodeUrl,
    fetch: authFetch,
  });

  // OpenCode's provider list (which already reflects the generated
  // SURPLUS_CONTEXT_CAP values), cached briefly. Serves context-limit lookups
  // and the /site-admin model autocomplete, so autocomplete keystrokes never
  // stampede the agent service.
  private providerCatalog?: { expires: number; promise: Promise<any[]> };

  // Sessions this harness deliberately aborted (reset sweeps, recovery
  // timeouts). An abort rejects the in-flight prompt with transport-shaped
  // error text; prompt() consumes the mark so that rejection is failed
  // outright instead of reconciling, and reconcilePrompt treats a mark that
  // appears mid-reconcile the same way — both paths can re-send the prompt
  // (continueAfterRestart), resurrecting exactly the turn the abort stopped.
  // prompt() clears a stale mark from an earlier turn before sending; a mark
  // is also dropped when a prompt on the session completes normally or the
  // session is swept away.
  private readonly deliberateAborts = new Set<string>();

  // Sessions whose prompt request is currently in flight — the only window in
  // which steering can land: during reconcile the original request is already
  // gone, and after it returns there is nothing running to steer.
  private readonly livePromptRequests = new Set<string>();
  private readonly promptControllers = new Map<string, AbortController>();
  private readonly stepBudgets = new Map<string, TurnStepBudget>();

  // Live quota blocks by provider (free-tier exhaustion until the scheduled
  // retry/reset). Pruned lazily; a completed turn clears its provider's entry.
  private readonly quotaBlocked = new Map<string, QuotaBlock>();

  private providerList(): Promise<any[]> {
    if (this.providerCatalog && this.providerCatalog.expires > Date.now()) return this.providerCatalog.promise;
    const promise = this.fetchProviderList().catch((error: unknown) => {
      log("debug", "opencode.provider_list_failed", { error: String(error) });
      return [] as any[];
    });
    // Cache only a real catalog. A transient failure (service restart, brief
    // unreachability) resolves [] and must not be pinned for the TTL — an
    // empty catalog blanks context-limit lookups, the compaction threshold,
    // and the model autocomplete for the next 10 minutes.
    void promise.then((providers) => {
      if (providers.length === 0) this.providerCatalog = undefined;
    });
    this.providerCatalog = { expires: Date.now() + 10 * 60_000, promise };
    return promise;
  }

  private async fetchProviderList(): Promise<any[]> {
    const result = await this.client.provider.list({} as any, { signal: AbortSignal.timeout(10_000) });
    const payload = unwrap<any>(result, "OpenCode provider list");
    const providers = payload?.all;
    if (!Array.isArray(providers)) throw new Error("OpenCode provider list returned an unexpected payload");
    return providers;
  }

  /** "providerID/modelID" -> advertised context limit, derived from the cached provider list. */
  /** Walk every (providerID, modelID, model) entry in the cached catalog. */
  private async forEachCatalogModel(visit: (providerID: string, modelID: string, model: any) => void): Promise<void> {
    for (const provider of await this.providerList()) {
      const providerID = typeof provider?.id === "string" ? provider.id : undefined;
      const models = provider?.models;
      if (!providerID || !models || typeof models !== "object") continue;
      for (const [modelID, model] of Object.entries(models as Record<string, unknown>)) visit(providerID, modelID, model);
    }
  }

  private async providerContextLimits(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    await this.forEachCatalogModel((providerID, modelID, model) => {
      const context = Number(model?.limit?.context ?? 0);
      if (context > 0) map.set(`${providerID}/${modelID}`, context);
    });
    return map;
  }

  /**
   * Model ids selectable from Discord for the /site-admin model autocomplete:
   * OpenCode's current zero-cost (free-tier) models plus every configured
   * Surplus model, as "providerID/modelID" strings sorted alphabetically.
   * Paid OpenCode models are omitted — this deployment rides the free tier
   * plus Surplus.
   */
  async listSelectableModels(): Promise<string[]> {
    const ids: string[] = [];
    await this.forEachCatalogModel((providerID, modelID, model) => {
      if (providerID !== "opencode" && providerID !== "surplus") return;
      const cost = model?.cost;
      const free = (cost && typeof cost === "object"
        && Number(cost.input ?? 0) === 0 && Number(cost.output ?? 0) === 0)
        || /-free$/.test(modelID);
      if (providerID === "opencode" && !free) return;
      ids.push(`${providerID}/${modelID}`);
    });
    return ids.sort((a, b) => a.localeCompare(b));
  }

  /**
   * Whether a provider/model accepts image attachments, from the cached
   * provider catalog's per-model metadata. Undefined when the model is not in
   * the catalog (or the catalog is unreachable) — callers treat that as "do
   * not forward images" rather than guessing.
   */
  async modelAcceptsAttachments(providerID: string, modelID: string): Promise<boolean | undefined> {
    let found: boolean | undefined;
    await this.forEachCatalogModel((pid, mid, model) => {
      if (pid !== providerID || mid !== modelID || found !== undefined) return;
      if (!model) return;
      if (typeof model.capabilities?.input?.image === "boolean") found = model.capabilities.input.image;
      else if (Array.isArray(model.modalities?.input)) found = model.modalities.input.includes("image");
      else found = model.attachment === true;
    });
    return found;
  }

  private async applyContextLimit(turn: TurnState, onProgress: ProgressCallback | undefined): Promise<void> {
    const model = turn.model;
    if (!model || turn.contextLimit) return;
    const limit = (await this.providerContextLimits()).get(`${model.providerID}/${model.modelID}`);
    if (!limit || !turn.model || turn.model.providerID !== model.providerID) return;
    turn.contextLimit = limit;
    emitPublicMetrics(turn, onProgress);
  }

  /**
   * Live quota block for a provider, pruning expired entries first. A prompt
   * without an explicit model follows the server's default provider, so any
   * live block applies — failing fast with the named provider beats parking
   * every queued turn on the same outage.
   */
  private quotaBlockedFor(providerID?: string): QuotaBlock | undefined {
    for (const [provider, block] of this.quotaBlocked) {
      if (block.until <= Date.now()) this.quotaBlocked.delete(provider);
    }
    if (!this.quotaBlocked.size) return undefined;
    if (providerID) return this.quotaBlocked.get(providerID);
    return [...this.quotaBlocked.values()].sort((a, b) => b.until - a.until)[0];
  }

  private clearQuotaBlock(providerID?: string): void {
    if (providerID) this.quotaBlocked.delete(providerID);
  }

  /**
   * Runtime failover-list override (set from the admin command); null or
   * absent follows the configured OPENCODE_FAILOVER_MODELS. An empty array
   * explicitly disables failover.
   */
  failoverModelSource: (() => string[] | null) | undefined;

  private failoverModelList(): string[] {
    return this.failoverModelSource?.() ?? config.opencodeFailoverModels;
  }

  /**
   * First configured failover model that is not the current one and whose
   * provider is not itself quota-blocked; undefined when none is usable.
   */
  private failoverCandidate(current?: { providerID: string; modelID: string }): string | undefined {
    const currentId = current ? `${current.providerID}/${current.modelID}` : undefined;
    for (const candidate of this.failoverModelList()) {
      if (candidate === currentId) continue;
      let parsed: { providerID: string; modelID: string } | undefined;
      try {
        parsed = parseModel(candidate);
      } catch {
        continue; // malformed entry in OPENCODE_FAILOVER_MODELS
      }
      if (!parsed) continue;
      if (this.quotaBlockedFor(parsed.providerID)) continue;
      return candidate;
    }
    return undefined;
  }

  /**
   * Failover model for a turn that failed mid-flight on a provider quota
   * block, or on a persistent upstream blip whose quick nudges were
   * exhausted: the first healthy candidate that is not the model just
   * attempted. Callers retry the same prompt with it once.
   */
  failoverModelForError(error: unknown, attemptedModel?: string): string | undefined {
    const block = (error as { quotaBlock?: QuotaBlock } | undefined)?.quotaBlock;
    if (!block || block.until <= Date.now()) {
      if (!(error as { providerBlip?: unknown }).providerBlip) return undefined;
    }
    let current: { providerID: string; modelID: string } | undefined;
    try {
      current = attemptedModel ? parseModel(attemptedModel) : undefined;
    } catch {
      current = undefined;
    }
    return this.failoverCandidate(current);
  }

  /** Quota context for error enrichment: what the turn observed, else any live block for the model's provider. */
  private quotaContext(turn: TurnState, parsed?: { providerID: string; modelID: string }): QuotaBlock | undefined {
    return turn.quotaBlock ?? this.quotaBlockedFor(parsed?.providerID);
  }

  /** Human-readable quota-breaker state (with cause) for the admin-only /site-admin status. */
  quotaStatus(): string {
    const blocks = [...this.quotaBlocked.entries()]
      .filter(([, block]) => block.until > Date.now())
      .map(([provider, block]) => `${provider} blocked until ${quotaUntil(block)} · ${block.title ?? block.reason}${block.link ? ` · ${block.link}` : ""}`);
    return blocks.length ? blocks.join("; ") : "no active quota blocks";
  }

  /**
   * Process a "retry" session status. Transient backoff gets a wait-eta
   * progress line. A quota action (free_tier_limit etc.) whose next attempt is
   * scheduled past the block threshold — the daily reset, hours out — engages
   * the fail-fast breaker, tells the user what happened and when it resets,
   * and aborts the stalled session so the turn fails in seconds instead of
   * waiting out the provider's retry schedule. Returns the block that engaged,
   * so callers that are still waiting (reconcile) can stop.
   */
  private handleRetryStatus(
    status: any,
    context: { sessionId: string; directory?: string; onProgress?: ProgressCallback; turn?: TurnState; actor?: string },
  ): QuotaBlock | undefined {
    const attempt = status?.attempt;
    const next = typeof status?.next === "number" ? status.next : undefined;
    const retryIn = next !== undefined ? next - Date.now() : undefined;
    const quota = classifyQuotaAction(status?.action);
    if (!quota || (retryIn !== undefined && retryIn <= config.opencodeQuotaBlockMinRetryMs)) {
      log("warn", "opencode.provider_retry", {
        sessionId: context.sessionId,
        attempt,
        next,
        message: status?.message,
        action: status?.action,
      });
      emit(context.onProgress, {
        text: `⏳ ${context.actor ?? "Provider"} retry #${attempt ?? "?"}`,
        // A quota action's message ("Free usage exceeded…") is admin-only, so
        // it is never echoed to the thread even when the retry looks transient.
        detail: retryIn !== undefined && retryIn > 0
          ? `next try in ~${formatShortDuration(retryIn)}`
          : quota ? undefined
          : truncate(String(status?.message ?? ""), 100) || undefined,
      });
      return undefined;
    }

    // No usable next (or one already past): a made-up short block still stops
    // turn-after-turn from re-discovering the outage; it self-expires.
    const block: QuotaBlock = { ...quota, until: retryIn !== undefined && retryIn > 0 ? next! : Date.now() + 30 * 60_000 };
    this.quotaBlocked.set(block.provider, block);
    if (context.turn) context.turn.quotaBlock = block;
    log("error", "opencode.quota_blocked", {
      sessionId: context.sessionId,
      provider: block.provider,
      reason: block.reason,
      until: new Date(block.until).toISOString(),
      message: block.message,
      link: block.link,
      attempt,
      action: status?.action,
    });
    // Thread-facing wording stays generic ("provider unavailable"); the reason,
    // subscribe pitch, and link are admin-only (log event + incident DM).
    emit(context.onProgress, {
      text: "🚫 AI provider unavailable",
      detail: `retries resume ${quotaUntil(block)}`,
    });
    // The provider will not answer until the reset; waiting inside this turn
    // only parks the Discord thread and the project queue for hours. Abort the
    // session — prompt() treats the resulting rejection as a deliberate stop
    // and fails the turn with this quota context instead of reconciling.
    if (context.directory && !this.deliberateAborts.has(context.sessionId)) {
      void this.abortTurn(context.directory, context.sessionId).catch((error: unknown) => {
        log("warn", "opencode.quota_abort_failed", { sessionId: context.sessionId, error: serializeError(error) });
      });
    }
    return block;
  }

  async createSession(directory: string, title: string, signal?: AbortSignal): Promise<string> {
    const result = await this.client.session.create({
      directory,
      title,
    } as any, { signal: signal ?? AbortSignal.timeout(10_000) });
    const session = unwrap<{ id: string }>(result, "OpenCode session creation");
    if (!session?.id) throw new Error("OpenCode did not return a session id");
    log("info", "opencode.session_created", { sessionId: session.id, directory, title });
    return session.id;
  }

  async prompt(
    directory: string,
    sessionId: string,
    text: string,
    model?: string,
    onProgress?: ProgressCallback,
    agent = "sitebuilder",
    variant?: string,
    images?: readonly PromptImage[],
  ): Promise<PromptResult> {
    let parsed = parseModel(model);
    // Fail fast while the provider's quota is known-exhausted: sending anyway
    // parks the turn (and the project queue) on a retry scheduled hours out —
    // unless a healthy failover model is configured, in which case the turn
    // switches to it instead of waiting out the outage.
    const block = this.quotaBlockedFor(parsed?.providerID);
    if (block) {
      const fallback = this.failoverCandidate(parsed);
      if (!fallback) {
        log("warn", "opencode.prompt_blocked_by_quota", {
          sessionId,
          provider: block.provider,
          model: model || "default",
          until: new Date(block.until).toISOString(),
        });
        throw quotaBlockedError(block, model);
      }
      log("warn", "opencode.quota_failover", { sessionId, from: model || "default", to: fallback, provider: block.provider });
      emit(onProgress, { text: `⚠️ \`${model || "the default model"}\` is quota-blocked — switching to \`${fallback}\`` });
      model = fallback;
      parsed = parseModel(fallback);
    }
    // Image attachments ride as data-URI file parts after the text — the same
    // shape opencode's own paste-image path produces. Data URIs keep the bytes
    // with the request, so nothing depends on the (expiring) Discord CDN URL.
    const body: any = {
      agent,
      tools: agent === "titler" ? { "*": false } : await this.browserTools(parsed),
      parts: [
        { type: "text", text },
        ...(images?.length
          ? images.map((image) => ({
            type: "file",
            mime: image.mime,
            url: image.dataUrl,
            ...(image.filename ? { filename: image.filename } : {}),
          }))
          : []),
      ],
    };
    if (parsed) body.model = parsed;
    // Model variant, i.e. reasoning effort (opencode "variant"). Omitted for "auto"
    // so the model's built-in default variant applies.
    if (variant && variant !== "auto") body.variant = variant;

    const snapshot = await this.capturePromptSnapshot(directory, sessionId, agent);
    // One TurnState per prompt, shared by the initial event stream and any reconnect
    // so token/context totals survive a transport recovery.
    const turn = createTurnState(snapshot.startedAt, snapshot.compactions);
    const finalUsage = async (): Promise<TurnUsage> => {
      const observed = usageOf(turn);
      try {
        const saved = usageFromMessages(await this.usageMessages(directory, sessionId), snapshot.startedAt, Infinity, snapshot.ids);
        return reconcileUsage(observed, saved) ?? observed;
      } catch (error) {
        log("warn", "opencode.usage_history_failed", { sessionId, error: serializeError(error) });
        return observed;
      }
    };
    turn.model = parsed ? { providerID: parsed.providerID, modelID: parsed.modelID } : undefined;
    if (turn.model) void this.applyContextLimit(turn, onProgress);
    let stream = await this.startEventStream(directory, sessionId, onProgress, turn).catch((error) => {
      log("warn", "opencode.event_stream_unavailable", { sessionId, error: serializeError(error) });
      return undefined;
    });
    // Seed the card from the session's stored todos before the first event: a
    // model that plans once and only edits afterwards would otherwise leave the
    // plan invisible until (and unless) it re-sends the list.
    await this.rehydratePlan(directory, sessionId, onProgress, { onlyUnfinished: true });

    emit(onProgress, { text: "🧠 Model is working", phase: "working" });
    log("info", "opencode.prompt_started", {
      sessionId,
      model: model || "default",
      variant: variant || "auto",
      promptChars: text.length,
      images: images?.length ?? 0,
      baselineMessages: snapshot.ids.size,
    });

    // A mark left by an abort that targeted an earlier turn on this session
    // (a reconcile- or recovery-timeout abort has no in-flight request left to
    // consume it) is stale — no request of ours is in flight yet. Clearing it
    // here means a mark appearing during the reconcile below unambiguously
    // means "this turn was deliberately stopped".
    this.deliberateAborts.delete(sessionId);
    const budget = agent === "sitebuilder"
      ? this.watchStepBudget(directory, sessionId, snapshot.startedAt, onProgress, snapshot.ids, () => this.livePromptRequests.has(sessionId))
      : undefined;
    // Quick same-model nudges for transient upstream errors: a provider 503 or
    // a rate-limit blip usually clears in seconds, and bailing out immediately
    // throws away an otherwise healthy turn.
    let blipNudgesLeft = config.opencodeBlipNudges;
    try {
      for (;;) {
        try {
          this.livePromptRequests.add(sessionId);
          const summary = await this.sendPromptRaw(directory, sessionId, body);
          // A mark added while this request was in flight must not survive into
          // the next turn on the session.
          this.deliberateAborts.delete(sessionId);
          // A completed turn proves the provider is answering again; drop a stale
          // quota block (the reset landed early or the outage was misread).
          this.clearQuotaBlock(turn.model?.providerID ?? parsed?.providerID);
          log("info", "opencode.prompt_completed", { sessionId, model: model || "default" });
          return { text: summary, usage: await finalUsage() };
        } catch (error) {
          if (this.deliberateAborts.delete(sessionId)) {
            const enriched = enrichProviderError(error, model, await finalUsage(), this.quotaContext(turn, parsed));
            logError("opencode.prompt_aborted", enriched, {
              sessionId,
              model: model || "default",
            });
            throw enriched;
          }
          if (isTransportLikeError(error)) {
            log("warn", "opencode.prompt_transport_lost", {
              sessionId,
              model: model || "default",
              error: serializeError(error),
            });
            emit(onProgress, { text: "🔄 Lost the live agent connection — reconciling" });

            if (stream) await stopStream(stream);
            stream = await this.startEventStream(directory, sessionId, onProgress, turn).catch((reconnectError) => {
              log("warn", "opencode.event_stream_reconnect_failed", {
                sessionId,
                error: serializeError(reconnectError),
              });
              return undefined;
            });
            if (stream) emit(onProgress, { text: "🟢 Reconnected — checking the running turn" });
            // Children created while no stream was attached never announced
            // themselves; adopt them so their events attribute to this turn
            // (the watch loop does the same on every reconnect).
            if (stream) await this.adoptChildSessions(sessionId, turn);
            // Buttons for a question asked before the transport dropped are gone from
            // the event stream; ask the server what is still pending and re-emit it.
            if (stream) {
              await this.resurfacePendingQuestion(directory, sessionId, onProgress).catch((error) => {
                log("debug", "opencode.question_resurface_failed", { sessionId, error: String(error) });
              });
              // The plan may have advanced while the stream was down.
              await this.rehydratePlan(directory, sessionId, onProgress);
            }

            try {
              const recovered = await this.reconcilePrompt(directory, sessionId, snapshot, model, onProgress, error, body);
              log("info", "opencode.prompt_recovered", {
                sessionId,
                model: model || "default",
                originalTransportError: serializeError(error),
              });
              emit(onProgress, { text: "✅ Recovered the completed agent turn" });
              return { text: recovered, usage: await finalUsage() };
            } catch (recoveryError) {
              const enriched = enrichProviderError(recoveryError, model, await finalUsage(), this.quotaContext(turn, parsed));
              logError("opencode.prompt_recovery_failed", enriched, {
                sessionId,
                model: model || "default",
                provider: parsed?.providerID,
                modelId: parsed?.modelID,
                originalTransportError: serializeError(error),
              });
              throw enriched;
            }
          }

          const blip = isProviderBlip(error);
          if (blip && blipNudgesLeft > 0) {
            blipNudgesLeft -= 1;
            const attempt = config.opencodeBlipNudges - blipNudgesLeft;
            const delayMs = attempt * 2000;
            log("warn", "opencode.prompt_provider_blip", {
              sessionId,
              model: model || "default",
              reason: blip,
              attempt,
              nudgesLeft: blipNudgesLeft,
              delayMs,
              error: serializeError(error),
            });
            emit(onProgress, { text: `⚠️ ${model || "The model"} hit a ${blip} — nudging it again in ${Math.round(delayMs / 1000)}s` });
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            // A stop landing during the nudge aborts the turn; it must not be
            // misread as a blip worth failing over.
            if (this.deliberateAborts.delete(sessionId)) {
              logError("opencode.prompt_aborted", error, { sessionId, model: model || "default" });
              throw enrichProviderError(error, model, await finalUsage(), this.quotaContext(turn, parsed));
            }
            continue; // resend the same prompt: a rejected request started no agent work
          }

          const enriched = enrichProviderError(error, model, await finalUsage(), this.quotaContext(turn, parsed));
          // Persistent blips keep their classification so the caller can hand
          // the same prompt to a configured backup model.
          if (blip) (enriched as unknown as { providerBlip: unknown }).providerBlip = { reason: blip, attempts: config.opencodeBlipNudges + 1 };
          logError("opencode.prompt_failed", enriched, {
            sessionId,
            model: model || "default",
            provider: parsed?.providerID,
            modelId: parsed?.modelID,
          });
          throw enriched;
        } finally {
          this.livePromptRequests.delete(sessionId);
        }
      }
    } finally {
      await budget?.stop();
      if (this.stepBudgets.get(sessionId) === budget) this.stepBudgets.delete(sessionId);
      if (stream) await stopStream(stream);
    }
  }

  /**
   * Steer the session's running turn with a mid-flight user message: submit it
   * to the busy session through the server's async prompt (the same path the
   * TUI uses when you type while it works), which the agent reads as part of
   * the running turn — or, at worst, as the immediate follow-up on the same
   * session. Never aborts anything. False when nothing is steerable right now
   * (no prompt request of ours in flight), so the caller can queue instead.
   * Images cannot ride a steering send; callers queue those.
   */
  async steer(directory: string, sessionId: string, text: string): Promise<boolean> {
    if (!this.livePromptRequests.has(sessionId)) return false;
    try {
      const result = await this.client.session.promptAsync({
        sessionID: sessionId,
        directory,
        agent: "sitebuilder",
        parts: [{ type: "text", text: steeringInstruction([text]) }],
      } as any);
      unwrap(result, "OpenCode steering prompt");
      log("warn", "opencode.prompt_steered", { sessionId, chars: text.length });
      return true;
    } catch (error) {
      log("warn", "opencode.steer_failed", { sessionId, error: serializeError(error) });
      return false;
    }
  }

  /** Unknown capabilities are treated as text-only. Permission rules hide all MCP tools, not just screenshots. */
  private async browserTools(model?: { providerID: string; modelID: string }): Promise<Record<string, boolean>> {
    return { "playwright_*": Boolean(model && await this.modelAcceptsAttachments(model.providerID, model.modelID)) };
  }

  private watchStepBudget(
    directory: string, sessionId: string, since: number, onProgress?: ProgressCallback,
    baseline?: ReadonlySet<string>, isActive: () => boolean = () => true,
  ): TurnStepBudget {
    const budget = new TurnStepBudget({
      limit: config.opencodeMaxSteps, since, baseline,
      read: () => this.listSessionMessages(directory, sessionId, Math.max(200, config.opencodeMaxSteps + 50)),
      onError: (error) => log("warn", "opencode.step_budget_watch_failed", { sessionId, error: serializeError(error) }),
      send: async (steps, signal) => {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
        if (!isActive() || signal.aborted || this.deliberateAborts.has(sessionId) || !await this.isBusy(directory, sessionId, deadline)) return false;
        // Keep the actual running model (including failover) and its reasoning setting.
        const messages = await this.listSessionMessages(directory, sessionId, 20, deadline);
        const user = [...messages].reverse().find((message) => message.info?.role === "user")?.info;
        const latest = [...messages].reverse().find((message) => message.info?.role === "assistant");
        const assistant = latest?.info;
        if (assistant?.finish && !["tool-calls", "unknown"].includes(assistant.finish)
          && !latest?.parts?.some((part) => part.type === "tool")) return false;
        const model = assistant?.providerID && assistant.modelID
          ? { providerID: assistant.providerID, modelID: assistant.modelID } : user?.model;
        const tools = await this.browserTools(model);
        if (signal.aborted || !isActive() || this.deliberateAborts.has(sessionId)) return false;
        if (!await this.isBusy(directory, sessionId, deadline) || signal.aborted) return false;
        const result = await this.client.session.promptAsync({
          sessionID: sessionId, directory, agent: "sitebuilder", model,
          variant: assistant?.variant ?? user?.model?.variant ?? user?.variant,
          tools,
          parts: [{ type: "text", text: finishUpInstruction(steps, config.opencodeMaxSteps) }],
        } as any, { signal: deadline });
        unwrap(result, "OpenCode force finish steering");
        log("warn", "opencode.step_budget_steered", { sessionId, steps, limit: config.opencodeMaxSteps });
        emit(onProgress, { text: `🏁 Near the step limit (${steps}/${config.opencodeMaxSteps}) — told the agent to finish up` });
        return true;
      },
    });
    this.stepBudgets.set(sessionId, budget);
    return budget;
  }

  async listMessages(directory: string, sessionId: string, limit = 100): Promise<SessionMessage[]> {
    return this.listSessionMessages(directory, sessionId, limit);
  }

  /** Saved billing data survives missed SSE events and bot/service restarts. */
  async usageMessages(directory: string, sessionId: string): Promise<SessionMessage[]> {
    const messages: SessionMessage[] = [];
    const visited = new Set<string>();
    const visit = async (id: string): Promise<void> => {
      if (visited.has(id)) return;
      visited.add(id);
      let before: string | undefined;
      const seen = new Set<string>();
      for (;;) {
        const result = await this.client.session.messages({ sessionID: id, directory, limit: 200, ...(before ? { before } : {}) } as any, { signal: AbortSignal.timeout(10_000) });
        const page = unwrap<SessionMessage[]>(result, "OpenCode usage history");
        if (!Array.isArray(page)) throw new Error("OpenCode usage history returned an unexpected payload");
        const fresh = page.filter((message) => message.info?.id && !seen.has(message.info.id));
        for (const message of fresh) {
          seen.add(message.info!.id!);
          messages.push(message);
        }
        if (page.length < 200) break;
        if (!fresh.length) throw new Error("OpenCode usage history pagination did not advance");
        before = fresh.sort((a, b) => (a.info?.time?.created ?? 0) - (b.info?.time?.created ?? 0)
          || a.info!.id!.localeCompare(b.info!.id!))[0].info!.id;
      }
      // Child lookup failures must not discard root history.
      try {
        const result = await this.client.session.children({ sessionID: id, directory } as any, { signal: AbortSignal.timeout(10_000) });
        const children = unwrap<Array<{ id: string }>>(result, "OpenCode usage children");
        for (const child of children) await visit(child.id);
      } catch (error) {
        log("warn", "opencode.child_usage_failed", { sessionId: id, error: serializeError(error) });
      }
    };
    await visit(sessionId);
    return messages;
  }

  async lastUserMessageId(directory: string, sessionId: string): Promise<string | undefined> {
    const messages = await this.listSessionMessages(directory, sessionId, 100);
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i].info;
      if (info?.role === "user" && info.id) return info.id;
    }
    return undefined;
  }

  async lastAssistantModel(directory: string, sessionId: string): Promise<{ providerID: string; modelID: string } | undefined> {
    const messages = await this.listSessionMessages(directory, sessionId, 100);
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i].info;
      if (info?.role === "assistant" && info.providerID && info.modelID) {
        return { providerID: info.providerID, modelID: info.modelID };
      }
    }
    return undefined;
  }

  async isBusy(directory: string, sessionId: string, signal?: AbortSignal): Promise<boolean> {
    const statuses = await this.sessionStatus(directory, signal);
    const type = (statuses[sessionId] as any)?.type;
    return type === "busy" || type === "retry";
  }

  /** Reattach to an existing session's event feed after the bot process restarted. */
  async watchExistingTurn(directory: string, sessionId: string, onProgress?: ProgressCallback, startedAt = Date.now()): Promise<() => Promise<void>> {
    let stopped = false;
    const budget = this.watchStepBudget(directory, sessionId, startedAt, onProgress, undefined, () => !stopped);
    void budget.refresh();
    let stream: EventStreamHandle | undefined;
    // One TurnState for the whole watch, so child sessions learned before a
    // drop stay known after reconnecting (each event only announces itself
    // once, over the stream that was live at the time).
    const turn = createTurnState(Date.now(), 0);
    const watcher = (async () => {
      while (!stopped) {
        try {
          stream = await this.startEventStream(directory, sessionId, onProgress, turn);
          if (!stream) throw new Error("OpenCode returned no recovery event stream");
          if (stopped) stream.stop();
          else {
            // Children created while no stream was attached never announced
            // themselves; adopt them so their events attribute to this turn.
            await this.adoptChildSessions(sessionId, turn);
            // A question asked before the watcher attached (while the bot was
            // down) never re-fires as an event; re-emit it so its answer
            // buttons render and the parked turn can actually be answered.
            await this.resurfacePendingQuestion(directory, sessionId, onProgress).catch(() => undefined);
            // Every reconnect replays the persisted plan and running tools:
            // whatever started during the gap produced no live events.
            await this.rehydratePlan(directory, sessionId, onProgress);
            await this.rehydrateRunningTools(directory, sessionId, onProgress);
          }
          await stream.done;
        } catch (error) {
          if (!stopped) log("warn", "opencode.recovery_event_stream_unavailable", { sessionId, error: serializeError(error) });
          // A throw between connect and `await stream.done` must not leak the
          // still-live stream while the loop opens a replacement.
          stream?.stop();
        }
        stream = undefined;
        if (!stopped) await sleep(2_000);
      }
    })();
    return async () => {
      stopped = true;
      await budget.stop();
      if (this.stepBudgets.get(sessionId) === budget) this.stepBudgets.delete(sessionId);
      stream?.stop();
      await watcher;
    };
  }

  /** Learn subagent child sessions that already exist, so their live events are not filtered out. */
  private async adoptChildSessions(sessionId: string, turn: TurnState): Promise<void> {
    try {
      for (const session of await this.listAllSessions()) {
        if (session.parentID === sessionId) turn.childSessions.add(session.id);
      }
    } catch (error) {
      log("debug", "opencode.child_sessions_adopt_failed", { sessionId, error: serializeError(error) });
    }
  }

  /** The session's persisted todo list, mapped for the progress card. */
  private async fetchPlan(directory: string, sessionId: string): Promise<ProgressPlanItem[]> {
    const result = await this.client.session.todo({ sessionID: sessionId, directory } as any);
    const data = unwrap<unknown>(result, "OpenCode session todo");
    return Array.isArray(data) ? planFromTodos(data) : [];
  }

  /**
   * Seed the card with the plan the session already holds. Todos live on the
   * server, so without this the card stays empty for a turn that resumed after
   * a bot restart, and for any model that writes its list once and never
   * re-sends it. Best-effort: a missing or empty list is not an error.
   */
  private async rehydratePlan(
    directory: string,
    sessionId: string,
    onProgress: ProgressCallback | undefined,
    options: { onlyUnfinished?: boolean } = {},
  ): Promise<void> {
    if (!onProgress) return;
    try {
      const plan = await this.fetchPlan(directory, sessionId);
      if (!plan.length) return;
      // A turn starting fresh inherits the previous turn's list; replaying it
      // only matters while it still has work left, otherwise the card would
      // claim the new request is already done.
      if (options.onlyUnfinished && !plan.some(isUnfinished)) return;
      emit(onProgress, { kind: "plan", text: "Restored the existing plan", plan });
      log("info", "opencode.plan_restored", { sessionId, items: plan.length });
    } catch (error) {
      log("debug", "opencode.plan_restore_failed", { sessionId, error: serializeError(error) });
    }
  }

  /** Restore the currently running tool from persisted message parts after the event gap. */
  private async rehydrateRunningTools(directory: string, sessionId: string, onProgress?: ProgressCallback): Promise<void> {
    try {
      const messages = await this.listSessionMessages(directory, sessionId, 100);
      const turn = createTurnState(Date.now(), 0);
      for (const message of messages) {
        const info = message.info;
        if (info?.role !== "assistant" || (info.agent && info.agent !== "sitebuilder")) continue;
        const running = (message.parts ?? []).filter((part) => part.type === "tool" && part.state?.status === "running");
        if (!running.length) continue;
        this.handleEvent({ type: "message.updated", properties: { info: { ...info, sessionID: sessionId } } }, directory, sessionId, onProgress, turn);
        for (const part of running) {
          this.handleEvent({ type: "message.part.updated", properties: { part: { ...part, sessionID: sessionId } } }, directory, sessionId, onProgress, turn);
        }
      }
    } catch (error) {
      log("warn", "opencode.recovery_activity_restore_failed", { sessionId, error: serializeError(error) });
    }
  }

  async revertSession(directory: string, sessionId: string, messageID: string): Promise<void> {
    const result = await this.client.session.revert({
      sessionID: sessionId,
      directory,
      messageID,
    } as any);
    unwrap(result, "OpenCode session revert");
    log("info", "opencode.session_reverted", { sessionId, messageID });
  }

  async compactSession(directory: string, sessionId: string, providerID: string, modelID: string): Promise<void> {
    const result = await this.client.session.summarize({
      sessionID: sessionId,
      directory,
      providerID,
      modelID,
      auto: false,
    } as any);
    unwrap(result, "OpenCode session compaction");
    log("info", "opencode.session_compact_requested", { sessionId, model: `${providerID}/${modelID}` });
  }

  async generateTitle(directory: string, requestText: string, model?: string): Promise<{ title?: string; usage: TurnUsage }> {
    const deadline = AbortSignal.timeout(20_000);
    const sessionId = await this.createSession(directory, "ThreadSite thread title", deadline);
    let usage: TurnUsage | undefined;
    let completed = false;
    try {
      const instruction =
        "Write a concise project title (3-6 words, Title Case, no quotes, no emoji, no trailing punctuation) " +
        "naming the website or game described by this request. Reply with only the title.\n\nREQUEST:\n" +
        truncate(requestText, 1200);
      // A title is a bounded, tools-free request. Do not enter the builder's
      // long transport reconciliation or quota retry loop for a name.
      const raw = unwrap<SessionMessage>(await this.client.session.prompt({
        sessionID: sessionId, directory, agent: "titler", model: parseModel(model), tools: { "*": false },
        parts: [{ type: "text", text: instruction }],
      } as any, { signal: deadline }), "OpenCode project title");
      usage = usageFromMessages([raw]);
      if (raw.info?.error) throw new Error(`Title model failed: ${safeJson(raw.info.error)}`);
      completed = true;
      return { title: cleanThreadTitle(extractText(raw.parts)), usage: usage ?? usageOf(createTurnState(Date.now(), 0)) };
    } catch (error) {
      if (!usage) {
        try {
          const saved = unwrap<SessionMessage[]>(await this.client.session.messages({ sessionID: sessionId, directory, limit: 20 } as any,
            { signal: AbortSignal.timeout(5_000) }), "OpenCode title usage");
          usage = usageFromMessages(saved);
        } catch { /* A failed provider may still have saved billable steps; unavailable history must not block fallback. */ }
      }
      throw enrichProviderError(error, model, usage);
    } finally {
      const cleanup = { signal: AbortSignal.timeout(5_000) };
      if (!completed) await this.client.session.abort({ sessionID: sessionId, directory } as any, cleanup).catch(() => undefined);
      await this.client.session.delete({ sessionID: sessionId, directory } as any, { signal: AbortSignal.timeout(5_000) })
        .catch((error: unknown) => log("debug", "opencode.title_session_delete_failed", { sessionId, error: String(error) }));
    }
  }

  async setProviderToken(providerID: string, token: string): Promise<void> {
    const result = await this.client.auth.set({
      providerID,
      auth: { type: "api", key: token },
    } as any);
    unwrap(result, "OpenCode auth update");
    log("info", "opencode.provider_token_updated", { providerID });
  }

  async clearProviderToken(providerID: string): Promise<void> {
    try {
      const result = await this.client.auth.remove({ providerID } as any);
      unwrap(result, "OpenCode auth removal");
    } catch (error) {
      // Removing a token that was never set is fine — matches the old raw-HTTP
      // behavior of tolerating 404.
      if (!/\b404\b|not.?found/i.test(errorText(error))) throw error;
    }
    log("info", "opencode.provider_token_removed", { providerID });
  }

  /**
   * Pending question requests across sessions, with their questions and
   * options — used to re-surface a question whose Discord buttons were lost
   * (bot restart, event-stream drop) while the agent is still blocked on it.
   */
  async listPendingQuestions(directory: string): Promise<Array<{
    id: string;
    sessionID: string;
    questions: Array<{
      header: string;
      question: string;
      multiple?: boolean;
      options: Array<{ label: string; description?: string }>;
    }>;
  }>> {
    const result = await this.client.question.list({ directory } as any);
    const data = unwrap<Array<any>>(result, "OpenCode question list");
    if (!Array.isArray(data)) return [];
    return data.map((request) => ({
      id: String(request?.id ?? ""),
      sessionID: String(request?.sessionID ?? ""),
      questions: (Array.isArray(request?.questions) ? request.questions : []).map(normalizeQuestion),
    })).filter((request) => request.id && request.questions.length);
  }

  async health(): Promise<string> {
    const candidates = ["/global/health", "/path"];
    let last = "unknown";
    for (const candidate of candidates) {
      try {
        const response = await authFetch(`${config.opencodeUrl}${candidate}`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (response.ok) return `ok (${response.status})`;
        last = `${response.status} ${await response.text()}`;
      } catch (error) {
        last = diagnosticText(error);
      }
    }
    return `unavailable: ${last}`;
  }

  private async capturePromptSnapshot(directory: string, sessionId: string, agent: string): Promise<PromptSnapshot> {
    const startedAt = Date.now();
    try {
      const messages = await this.listSessionMessages(directory, sessionId, 100);
      let compactions = 0;
      for (const message of messages) {
        for (const part of message.parts ?? []) if (part.type === "compaction") compactions += 1;
      }
      return {
        startedAt,
        agent,
        compactions,
        ids: new Set(messages.map((message) => message.info?.id).filter((id): id is string => Boolean(id))),
      };
    } catch (error) {
      // Reconciliation can still safely use created timestamps if the pre-flight snapshot fails.
      log("warn", "opencode.prompt_snapshot_failed", { sessionId, error: serializeError(error) });
      return { startedAt, agent, compactions: 0, ids: new Set() };
    }
  }

  private async reconcilePrompt(
    directory: string,
    sessionId: string,
    snapshot: PromptSnapshot,
    model: string | undefined,
    onProgress: ProgressCallback | undefined,
    originalError: unknown,
    originalBody: Record<string, unknown>,
  ): Promise<string> {
    const deadline = Date.now() + config.opencodeReconcileTimeoutMs;
    let lastStatus: unknown;
    let consecutivePollFailures = 0;
    let idleWithoutTurnSince: number | undefined;
    let lastProgressAt = 0;

    while (Date.now() < deadline) {
      // An abort that landed since this prompt began (user stop, reset sweep)
      // deliberately stopped the session. The idle branch below would re-send
      // the prompt via continueAfterRestart — resurrecting exactly the turn
      // the abort killed, the multi-stop symptom this guards against — so a
      // mark present here fails the turn instead.
      if (this.deliberateAborts.has(sessionId)) {
        throw new OpenCodeReconciliationError(
          "The session was deliberately stopped while reconciling a dropped connection.",
          { phase: "aborted-while-reconciling", model },
          { cause: originalError },
        );
      }
      let messages: SessionMessage[] | undefined;
      try {
        messages = await this.listSessionMessages(directory, sessionId, 100);
        consecutivePollFailures = 0;
      } catch (error) {
        // A vanished session is permanent, not transient — fail at once (the
        // 404-shaped text routes the caller into its recreate-and-reprompt
        // path) instead of polling a dead session for the whole window.
        if (/404|not found|unknown session/i.test(errorText(error))) {
          throw new OpenCodeReconciliationError(
            `The saved OpenCode session is gone (unknown session): ${errorText(error)}`,
            { phase: "session-vanished", model },
            { cause: originalError },
          );
        }
        consecutivePollFailures += 1;
        if (consecutivePollFailures === 1 || consecutivePollFailures % 10 === 0) {
          log("warn", "opencode.reconcile_messages_failed", {
            sessionId,
            attempt: consecutivePollFailures,
            error: serializeError(error),
          });
        }
      }

      if (messages) {
        const assistant = findTerminalAssistant(messages, snapshot);
        if (assistant) {
          if (assistant.info?.error) {
            throw new OpenCodeReconciliationError(
              `OpenCode persisted an assistant error: ${safeJson(assistant.info.error)}`,
              {
                phase: "persisted-assistant-error",
                assistantMessageId: assistant.info.id,
                providerError: assistant.info.error,
                model,
              },
              { cause: originalError },
            );
          }

          log("info", "opencode.reconcile_found_completion", {
            sessionId,
            assistantMessageId: assistant.info?.id,
            finish: assistant.info?.finish,
            completed: assistant.info?.time?.completed,
          });
          return extractText(assistant.parts);
        }
      }

      try {
        const statusMap = await this.sessionStatus(directory);
        lastStatus = statusMap[sessionId];
        const type = (lastStatus as any)?.type;

        if (type === "retry") {
          const block = this.handleRetryStatus(lastStatus, { sessionId, directory, onProgress });
          if (block) {
            const error = new OpenCodeReconciliationError(
              `Provider quota exhausted while reconciling: ${block.reason} on ${block.provider}, retries resume ~${formatUtcClock(block.until)}.`,
              { phase: "quota-blocked", quotaBlock: block, model },
            );
            (error as any).quotaBlock = block;
            throw error;
          }
        } else if (type === "busy") {
          idleWithoutTurnSince = undefined;
        } else {
          // An absent status entry means idle. Give persistence a grace window before deciding
          // the original request never made it to OpenCode. When the service itself
          // restarted mid-turn, the session goes idle without a finished assistant
          // message — continue the turn instead of failing it.
          idleWithoutTurnSince ??= Date.now();
          if (Date.now() - idleWithoutTurnSince > 8_000) {
            return await this.continueAfterRestart(directory, sessionId, originalBody, snapshot, messages, model, onProgress, originalError);
          }
        }
      } catch (error) {
        if (error instanceof OpenCodeReconciliationError) throw error;
        lastStatus = { type: "unreachable", error: serializeError(error) };
        if (Date.now() - lastProgressAt > 12_000) {
          emit(onProgress, { text: "🔌 Waiting for the agent service to become reachable again" });
          lastProgressAt = Date.now();
        }
      }

      await sleep(config.opencodeReconcilePollMs);
    }

    const wasBusy = (lastStatus as any)?.type === "busy" || (lastStatus as any)?.type === "retry";
    let aborted = false;
    if (wasBusy) {
      emit(onProgress, { text: "🛑 Recovery window exhausted — stopping the orphaned agent turn" });
      aborted = await this.abortTurn(directory, sessionId).catch((error) => {
        log("error", "opencode.reconcile_abort_failed", { sessionId, error: serializeError(error) });
        return false;
      });
      if (aborted) await sleep(500);
    }

    throw new OpenCodeReconciliationError(
      "Timed out while reconciling a dropped OpenCode transport connection.",
      {
        phase: "reconcile-timeout",
        timeoutMs: config.opencodeReconcileTimeoutMs,
        lastSessionStatus: lastStatus,
        abortAttempted: wasBusy,
        abortSucceeded: aborted,
        model,
      },
      { cause: originalError, mayStillBeRunning: wasBusy && !aborted },
    );
  }

  private async sendPromptRaw(directory: string, sessionId: string, body: Record<string, unknown>): Promise<string> {
    const controller = new AbortController();
    this.promptControllers.set(sessionId, controller);
    let result;
    try { result = await this.client.session.prompt({
      sessionID: sessionId,
      directory,
      agent: body.agent as string | undefined,
      model: body.model as { providerID: string; modelID: string } | undefined,
      tools: body.tools as Record<string, boolean> | undefined,
      variant: body.variant as string | undefined,
      parts: body.parts as Array<{ type: "text"; text: string } | { type: "file"; mime: string; url: string; filename?: string }>,
    } as any, { signal: controller.signal }); }
    finally { if (this.promptControllers.get(sessionId) === controller) this.promptControllers.delete(sessionId); }
    const response = unwrap<{ info?: { error?: unknown }; parts?: Array<{ type: string; text?: string }> }>(result, "OpenCode prompt");
    // The session endpoint can return HTTP 200 with a terminal assistant error
    // and no text. Treating that as success would build/publish an unfinished
    // turn, including when a browser tool or its provider request failed.
    if (response.info?.error) {
      throw new OpenCodeRequestError(`OpenCode assistant failed: ${safeJson(response.info.error)}`, {
        operation: "OpenCode prompt", assistantError: response.info.error,
      });
    }
    return extractText(response.parts);
  }

  /**
   * The agent service restarted mid-turn (or the request never reached it): the
   * session sits idle with no completed assistant message. Ask the session to
   * continue the interrupted work — or, when the original request never
   * arrived, send it now — instead of failing the whole Discord turn.
   */
  private async continueAfterRestart(
    directory: string,
    sessionId: string,
    originalBody: Record<string, unknown>,
    snapshot: PromptSnapshot,
    messages: SessionMessage[] | undefined,
    model: string | undefined,
    onProgress: ProgressCallback | undefined,
    originalError: unknown,
  ): Promise<string> {
    const arrived = (messages ?? []).some((message) => {
      const info = message.info;
      return Boolean(
        info?.id && info.role === "user" && !snapshot.ids.has(info.id)
        && (info.time?.created ?? 0) >= snapshot.startedAt - 2_000,
      );
    });
    log("warn", "opencode.reconcile_continuing_after_restart", { sessionId, requestArrived: arrived });
    emit(onProgress, { text: "🔁 The agent service restarted mid-turn — asking it to continue" });
    const body = arrived
      ? { ...originalBody, parts: [{ type: "text", text: CONTINUE_AFTER_RESTART }] }
      : originalBody;
    try {
      return await this.sendPromptRaw(directory, sessionId, body);
    } catch (error) {
      throw new OpenCodeReconciliationError(
        `Continuing the interrupted turn after an agent-service restart failed: ${errorText(error)}`,
        { phase: "continue-failed", requestArrived: arrived, model },
        { cause: originalError },
      );
    }
  }

  /** Re-emit the session's pending question, if any, after a transport recovery. */
  private async resurfacePendingQuestion(
    directory: string,
    sessionId: string,
    onProgress: ProgressCallback | undefined,
  ): Promise<void> {
    const pending = (await this.listPendingQuestions(directory)).find((request) => request.sessionID === sessionId);
    if (!pending) return;
    log("info", "opencode.question_resurfaced", { sessionId, requestID: pending.id });
    emit(onProgress, {
      kind: "question",
      text: "❓ Still waiting on the agent's question",
      question: { requestID: pending.id, questions: pending.questions },
    });
  }

  private async listSessionMessages(directory: string, sessionId: string, limit: number, signal?: AbortSignal): Promise<SessionMessage[]> {
    const result = await this.client.session.messages({
      sessionID: sessionId,
      directory,
      limit,
    } as any, { signal: signal ?? AbortSignal.timeout(10_000) });
    const data = unwrap<SessionMessage[]>(result, "OpenCode message history");
    if (!Array.isArray(data)) throw new Error("OpenCode message history returned an unexpected payload");
    return data;
  }

  private async sessionStatus(directory: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const result = await this.client.session.status({ directory } as any, { signal: signal ?? AbortSignal.timeout(10_000) });
    const data = unwrap<Record<string, unknown>>(result, "OpenCode session status");
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("OpenCode session status returned an unexpected payload");
    return data;
  }

  /** Best-effort HTTP abort of a still-running turn; used when recovery or a reset stops waiting. */
  async abortTurn(directory: string, sessionId: string): Promise<boolean> {
    // Mark BEFORE the request: the service rejects the in-flight prompt as soon
    // as it processes the abort, so the prompt's catch can run before this
    // await resumes. Marking afterwards let that rejection race past and the
    // reconcile path then resurrected the very turn being stopped.
    this.deliberateAborts.add(sessionId);
    await this.stepBudgets.get(sessionId)?.stop();
    try {
      const result = await this.client.session.abort({
        sessionID: sessionId,
        directory,
      } as any);
      unwrap(result, "OpenCode abort");
    } catch (error) {
      // The abort never landed, so nothing will consume the mark.
      this.deliberateAborts.delete(sessionId);
      throw error;
    }
    log("warn", "opencode.session_aborted", { sessionId });
    return true;
  }

  /** Every session known to the agent service, across all projects. */
  async workspaceSessions(): Promise<Array<{ id: string; directory: string; parentID?: string }>> {
    return this.listAllSessions();
  }

  private async listAllSessions(): Promise<Array<{ id: string; directory: string; parentID?: string }>> {
    const result = await this.client.session.list({ limit: 100_000 } as any, { signal: AbortSignal.timeout(10_000) });
    const data = unwrap<any[]>(result, "OpenCode session list");
    if (!Array.isArray(data)) throw new Error("OpenCode session inventory returned an unexpected payload.");
    return data
      .map((session) => ({
        id: String(session?.id ?? ""),
        directory: String(session?.directory ?? ""),
        parentID: session?.parentID ? String(session.parentID) : undefined,
      }))
      .filter((session) => session.id);
  }

  /** IDs of sessions currently running or retrying a turn, across all projects. */
  private async listBusySessionIds(): Promise<Set<string>> {
    const result = await this.client.session.status({} as any);
    const data = unwrap<Record<string, unknown>>(result, "OpenCode session status");
    const busy = new Set<string>();
    for (const [sessionId, status] of Object.entries(data ?? {})) {
      const type = (status as any)?.type;
      if (type === "busy" || type === "retry") busy.add(sessionId);
    }
    return busy;
  }

  /**
   * Stop a set of agent sessions: reject their pending questions (a parked
   * question holds its turn open), abort their busy turns, wait briefly for
   * the aborts to land, then delete the sessions. Best-effort per step — a
   * failed reject/abort/delete is logged and the sweep moves on.
   */
  private async sweepSessions(targets: Array<{ id: string; directory: string }>): Promise<{ sessions: number; aborted: number }> {
    const directoryOf = new Map(targets.map((session) => [session.id, session.directory]));
    const busyAll = await this.listBusySessionIds().catch(() => new Set<string>());
    const busy = new Set(targets.filter((session) => busyAll.has(session.id)).map((session) => session.id));

    // A turn parked on a question must be released before an abort can land;
    // question listing is directory-scoped, so walk the known ones.
    for (const directory of new Set([...directoryOf.values()].filter(Boolean))) {
      const pending = await this.listPendingQuestions(directory).catch(() => []);
      for (const request of pending) {
        await this.rejectQuestion(directory, request.id).catch((error) => {
          log("warn", "opencode.reset_question_reject_failed", { requestID: request.id, directory, error: serializeError(error) });
        });
      }
    }

    let aborted = 0;
    for (const sessionId of busy) {
      const directory = directoryOf.get(sessionId);
      if (!directory) continue;
      const ok = await this.abortTurn(directory, sessionId).catch((error) => {
        log("warn", "opencode.reset_abort_failed", { sessionId, directory, error: serializeError(error) });
        return false;
      });
      if (ok) aborted += 1;
    }

    // Give the aborts a moment to land so the deletes do not race dying turns.
    for (let i = 0; i < 20 && busy.size > 0; i += 1) {
      const stillBusy = await this.listBusySessionIds().catch(() => undefined);
      if (stillBusy && ![...busy].some((id) => stillBusy.has(id))) break;
      await sleep(500);
    }

    for (const session of targets) {
      await this.client.session.delete({ sessionID: session.id, directory: session.directory || undefined } as any)
        .catch((error: unknown) => log("warn", "opencode.reset_delete_failed", { sessionId: session.id, directory: session.directory, error: serializeError(error) }));
      this.deliberateAborts.delete(session.id);
    }
    return { sessions: targets.length, aborted };
  }

  /**
   * Server-wide hard stop (/site-admin reset): delete every session except
   * the `keep` set (freshly created replacements). Covers sessions the
   * Discord store no longer tracks — orphans, subagent children, abandoned
   * titler runs — so nothing on the service can keep working or be resumed.
   */
  async stopAllSessions(keep: ReadonlySet<string>): Promise<{ sessions: number; aborted: number }> {
    const all = await this.listAllSessions();
    const targets = all.filter((session) => !keep.has(session.id));
    const sweep = await this.sweepSessions(targets);
    log("warn", "opencode.admin_reset_sweep", { sessions: sweep.sessions, aborted: sweep.aborted, kept: keep.size });
    return sweep;
  }

  /**
   * Directory-scoped hard stop (/site reset): stop every session living in
   * this project's workspace — the tracked session (targeted by id even when
   * the service no longer lists it) plus same-directory strays like subagent
   * children and abandoned titler runs — except the `keep` set (the freshly
   * created replacement).
   */
  async stopSessionsInDirectory(directory: string, knownSessionId: string, keep: ReadonlySet<string>): Promise<{ sessions: number; aborted: number }> {
    const all = await this.listAllSessions();
    const targets = new Map<string, { id: string; directory: string }>();
    if (knownSessionId && !keep.has(knownSessionId)) targets.set(knownSessionId, { id: knownSessionId, directory });
    for (const session of all) {
      if (keep.has(session.id) || session.directory !== directory) continue;
      targets.set(session.id, session);
    }
    return this.sweepSessions([...targets.values()]);
  }

  /** Strict project teardown: an API failure must leave deletion retryable. */
  async deleteSessionsInDirectory(directory: string, knownSessionId: string): Promise<void> {
    if (knownSessionId) {
      this.deliberateAborts.add(knownSessionId);
      await this.stepBudgets.get(knownSessionId)?.stop();
      this.promptControllers.get(knownSessionId)?.abort(new Error("Project deleted"));
    }
    const all = await this.listAllSessions();
    const ids = new Set(all.filter((session) => session.directory === directory).map((session) => session.id));
    if (knownSessionId) ids.add(knownSessionId);
    for (;;) {
      const size = ids.size;
      for (const session of all) if (session.parentID && ids.has(session.parentID)) ids.add(session.id);
      if (ids.size === size) break;
    }
    const targets = new Map(all.filter((session) => ids.has(session.id)).map((session) => [session.id, session]));
    if (knownSessionId && !targets.has(knownSessionId)) targets.set(knownSessionId, { id: knownSessionId, directory });
    const request = { signal: AbortSignal.timeout(30_000) };
    for (const targetDirectory of new Set([...targets.values()].map((session) => session.directory))) {
      const questions = unwrap<Array<{ id: string; sessionID: string }>>(
        await this.client.question.list({ directory: targetDirectory } as any, request), "OpenCode deletion questions");
      for (const question of questions) {
        if (!ids.has(question.sessionID)) continue;
        const result = await this.client.question.reject({ requestID: question.id, directory: targetDirectory } as any, request);
        if ((result as any).response?.status !== 404) unwrap(result, "OpenCode deletion question reject");
      }
    }
    for (const session of targets.values()) {
      this.deliberateAborts.add(session.id);
      await this.stepBudgets.get(session.id)?.stop();
      this.promptControllers.get(session.id)?.abort(new Error("Project deleted"));
      // Session abort also releases pending tools/questions. Delete cascades
      // persisted messages and child sessions on the agent service.
      for (const operation of ["abort", "delete"] as const) {
        const result = await this.client.session[operation]({ sessionID: session.id, directory: session.directory } as any, request);
        if ((result as any).response?.status === 404) continue;
        unwrap(result, `OpenCode project session ${operation}`);
      }
    }
    const statuses = unwrap<Record<string, { type?: string }>>(
      await this.client.session.status({ directory } as any, request), "OpenCode deletion status");
    if ([...ids].some((id) => ["busy", "retry"].includes(statuses[id]?.type ?? ""))) {
      throw new Error("An agent session is still stopping; project cleanup will retry.");
    }
  }

  /** Answer a pending question request (one label list per asked question, in order). */
  async replyToQuestion(directory: string, requestID: string, answers: string[][]): Promise<void> {
    const result = await this.client.question.reply({
      requestID,
      directory,
      answers,
    } as any);
    unwrap(result, "OpenCode question reply");
    log("info", "opencode.question_replied", { requestID, answers });
  }

  /** Dismiss a pending question request; the agent sees the question was rejected. */
  async rejectQuestion(directory: string, requestID: string): Promise<void> {
    const result = await this.client.question.reject({
      requestID,
      directory,
    } as any);
    unwrap(result, "OpenCode question reject");
    log("info", "opencode.question_rejected", { requestID });
  }

  private async startEventStream(
    directory: string,
    sessionId: string,
    onProgress: ProgressCallback | undefined,
    turn: TurnState,
  ): Promise<EventStreamHandle> {
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(new Error("event stream connect timeout")), 4_000);
    const url = new URL(`${config.opencodeUrl}/event`);
    url.searchParams.set("directory", directory);

    let response: Response;
    try {
      response = await authFetch(url, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(connectTimer);
    }
    if (!response.ok) {
      controller.abort();
      throw new Error(`OpenCode event stream returned HTTP ${response.status}`);
    }
    if (!response.body) {
      controller.abort();
      throw new Error("OpenCode event stream returned no body");
    }

    const done = this.consumeEventStream(response.body, directory, sessionId, onProgress, controller.signal, turn)
      .catch((error) => {
        if (!controller.signal.aborted) log("warn", "opencode.event_stream_failed", { sessionId, error: serializeError(error) });
      });

    return {
      stop: () => controller.abort(),
      done,
    };
  }

  private async consumeEventStream(
    body: ReadableStream<Uint8Array>,
    directory: string,
    sessionId: string,
    onProgress: ProgressCallback | undefined,
    signal: AbortSignal,
    turn: TurnState,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            this.handleEvent(JSON.parse(payload), directory, sessionId, onProgress, turn);
          } catch (error) {
            log("debug", "opencode.event_parse_failed", { sessionId, error: String(error) });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleEvent(event: any, directory: string, sessionId: string, onProgress: ProgressCallback | undefined, turn: TurnState): void {
    const properties = event?.properties ?? {};
    const eventSessionId = properties.sessionID ?? properties.part?.sessionID ?? properties.info?.sessionID;
    // Subagents run in child sessions of the root session. Their activity is
    // surfaced as prefixed progress lines and their tokens/cost fold into the
    // turn stats; everything else from unknown sessions stays filtered out.
    const isChild = Boolean(eventSessionId && eventSessionId !== sessionId && turn.childSessions.has(eventSessionId));
    if (eventSessionId && eventSessionId !== sessionId && !isChild) return;
    const childSessionId = isChild ? eventSessionId : undefined;
    const label = isChild ? "🤖 Subagent" : undefined;

    if (event?.type === "session.created" || event?.type === "session.updated") {
      if (!isChild && properties.info?.parentID === sessionId) turn.childSessions.add(String(properties.info.id));
      return;
    }

    if (event?.type === "message.part.delta") {
      sampleStreamDelta(properties, turn, onProgress);
      return;
    }

    if (event?.type === "message.updated") {
      // Track assistant message IDs so streaming text parts can be attributed to the
      // model's output rather than the echoed user prompt. The first sighting of
      // a message also opens its generation window for the tok/s rate.
      const info = properties.info;
      if (info?.role === "assistant" && info.id) {
        const id = String(info.id);
        if (!turn.assistantMessageIds.has(id)) {
          turn.assistantMessageIds.add(id);
          turn.stepStartAtByMessage.set(id, Date.now());
        }
        const providerID = info.providerID;
        const modelID = info.modelID;
        if (providerID && modelID) turn.messageModels.set(id, `${providerID}/${modelID}`);
        if (!isChild && providerID && modelID && (turn.model?.providerID !== providerID || turn.model?.modelID !== modelID)) {
          turn.model = { providerID, modelID };
          void this.applyContextLimit(turn, onProgress);
        }
      }
      return;
    }

    if (event?.type === "session.status") {
      const status = properties.status;
      if (status?.type === "busy") emit(onProgress, { text: isChild ? `${label} is working` : "🧠 Model is thinking" });
      if (status?.type === "retry") {
        this.handleRetryStatus(status, { sessionId: childSessionId ?? sessionId, directory, onProgress, turn, ...(isChild ? { actor: "Subagent" } : {}) });
      }
      return;
    }

    if (!isChild && event?.type === "session.error") {
      log("error", "opencode.session_error", { sessionId, providerError: properties.error });
      emit(onProgress, { text: "⚠️ Provider/session error detected" });
      return;
    }

    // The question tool blocks the turn until the user answers, so it must be
    // surfaced immediately as buttons on the Discord status message. Child
    // sessions never ask: only root-session questions surface as buttons.
    if (!isChild && (event?.type === "question.asked" || event?.type === "question.v2.asked")) {
      const requestID = typeof properties.id === "string" ? properties.id : "";
      const questions = Array.isArray(properties.questions) ? properties.questions : [];
      if (!requestID || !questions.length) return;
      log("info", "opencode.question_asked", {
        sessionId,
        requestID,
        count: questions.length,
        headers: questions.map((q: any) => q?.header).filter(Boolean),
      });
      emit(onProgress, {
        kind: "question",
        text: "❓ The agent has a question",
        question: { requestID, questions: questions.map(normalizeQuestion) },
      });
      return;
    }
    if (!isChild && (
      event?.type === "question.replied" || event?.type === "question.v2.replied"
      || event?.type === "question.rejected" || event?.type === "question.v2.rejected"
    )) {
      const requestID = String(properties.requestID ?? "");
      const rejected = event.type.includes("rejected");
      const labels = (Array.isArray(properties.answers) ? properties.answers : [])
        .flat()
        .filter((answer: unknown): answer is string => typeof answer === "string" && Boolean(answer));
      const text = rejected
        ? "🤔 Skipped — the agent decides on its own"
        : labels.length
          ? `✅ Answered: ${labels.join(", ")}`
          : "✅ Question answered";
      emit(onProgress, {
        kind: "question",
        text,
        question: { requestID, questions: [], resolved: true },
      });
      return;
    }

    if (!isChild && event?.type === "session.compacted") {
      turn.compactions += 1;
      log("info", "opencode.session_compacted", { sessionId, total: turn.compactions });
      emit(onProgress, { text: "🧠 Context compacted — continuing automatically" });
      emitPublicMetrics(turn, onProgress);
      return;
    }

    if (!isChild && event?.type === "session.diff") {
      const count = Array.isArray(properties.diff) ? properties.diff.length : undefined;
      emit(onProgress, { text: "🧩 Updating project files", detail: count ? `${count} changed` : undefined });
      return;
    }

    if (!isChild && event?.type === "todo.updated") {
      const todos = Array.isArray(properties.todos) ? properties.todos : [];
      emit(onProgress, { kind: "plan", text: "Updated plan", plan: planFromTodos(todos) });
      const done = todos.filter((todo: any) => todo?.status === "completed" || todo?.status === "cancelled").length;
      const active = todos.find((todo: any) => todo?.status === "in_progress");
      if (active?.content) {
        emit(onProgress, { text: `🗺️ ${done}/${todos.length} — ${truncate(String(active.content), 80)}` });
      } else if (todos.length) {
        emit(onProgress, { text: `🗺️ Plan: ${done}/${todos.length} steps done` });
      } else {
        emit(onProgress, { text: "🗺️ Planning the build" });
      }
      return;
    }

    if (event?.type !== "message.part.updated") return;
    const part = properties.part;
    if (!part) return;
    const tool = String(part.tool || "tool");

    if (part.type === "step-finish") {
      if (part.id && turn.finishedParts.has(part.id)) return;
      if (part.id) turn.finishedParts.add(part.id);
      const step = stepFigures(part);
      accumulateStep(turn, step, part.messageID);
      if (!isChild && part.messageID) this.stepBudgets.get(sessionId)?.observe(String(part.messageID));
      turn.liveTokenSamples.length = 0;
      // Every step re-processes the full context, so billed input accumulates
      // per step while the context display only wants the newest window size.
      if (!isChild) turn.contextTokens = step.inputTokens;
      emitPublicMetrics(turn, onProgress);
      return;
    }

    if (part.type === "text" && !part.synthetic && turn.assistantMessageIds.has(part.messageID)) {
      samplePartGrowth(turn, part, onProgress);
      if (isChild) {
        const text = singleLineText(String(part.text ?? ""));
        if (text) emit(onProgress, { text: `${label}: ${truncate(text, 100)}` });
      } else {
        const text = String(part.text ?? "").trim();
        if (text) emit(onProgress, { kind: "thought", text, narrationId: String(part.id ?? part.messageID) });
      }
      return;
    }

    // Reasoning streams as its own part type and often dominates output tokens;
    // it feeds the live meter, and the raw text rides the private thinking
    // trail for the owner-only details panel. It never becomes a public update.
    if (part.type === "reasoning" && !part.synthetic && turn.assistantMessageIds.has(part.messageID)) {
      samplePartGrowth(turn, part, onProgress);
      if (!isChild) {
        const text = String(part.text ?? "").trim();
        if (text) emit(onProgress, { kind: "thinking", text, narrationId: String(part.id ?? part.messageID) });
      }
      return;
    }

    if (part.type !== "tool") return;
    const state = part.state ?? {};

    // Generation is paused while tools run; drop live samples and settle the
    // stats line back to completed-step figures so the ⚡ rate cannot go stale.
    if (turn.liveTokenSamples.length && ["running", "completed", "error"].includes(String(state.status))) {
      turn.liveTokenSamples.length = 0;
      emitPublicMetrics(turn, onProgress);
    }

    if (state.status === "error") {
      log("warn", isChild ? "opencode.subagent_tool_error" : "opencode.tool_error", {
        sessionId: childSessionId ?? sessionId,
        ...(isChild ? { childSessionId } : {}),
        tool,
        error: state.error,
        ...(isChild ? {} : { title: state.title }),
      });
      emit(onProgress, {
        text: isChild ? `⚠️ ${label} tool error` : `⚠️ ${toolLabel(tool)} hit an error`,
        tool: { id: `${childSessionId ?? sessionId}:${part.callID ?? part.id}`, name: tool, status: "error" },
      });
      return;
    }

    if (state.status !== "running" && state.status !== "completed") return;
    const described = describeTool(tool, state.input, state.status, state.title, directory);
    if (described) {
      emit(onProgress, isChild
        ? { text: `${label} — ${described.text}`, detail: described.detail, tool: { id: `${childSessionId}:${part.callID ?? part.id}`, name: tool, status: state.status } }
        : { ...described, tool: { id: `${sessionId}:${part.callID ?? part.id}`, name: tool, status: state.status } });
    }
  }
}

/** Shared option/label clamping for question events and /questions polling. */
function normalizeQuestion(q: any): { header: string; question: string; multiple: boolean; options: Array<{ label: string; description?: string }> } {
  return {
    header: String(q?.header ?? "Question").slice(0, 80),
    question: String(q?.question ?? "").slice(0, 500),
    multiple: Boolean(q?.multiple),
    options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => ({
      label: String(o?.label ?? "Option"),
      description: typeof o?.description === "string" ? o.description : undefined,
    })),
  };
}

function singleLineText(value: string): string {
  return value.replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
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

function findTerminalAssistant(messages: SessionMessage[], snapshot: PromptSnapshot): SessionMessage | undefined {
  return messages
    .filter((message) => isTerminalAssistant(message.info, { since: snapshot.startedAt, agent: snapshot.agent })
      && !snapshot.ids.has(message.info!.id!))
    .sort((a, b) => (b.info?.time?.created ?? 0) - (a.info?.time?.created ?? 0))[0];
}

function extractText(parts: Array<{ type?: string; text?: string }> | undefined): string {
  return (parts ?? [])
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text!)
    .join("\n")
    .trim();
}

/** Token/cost figures of one step-finish part, before attribution. */
function stepFigures(part: any): { inputTokens: number; outputTokens: number; cacheTokens: number; cost: number } {
  const tokens = part.tokens ?? {};
  return {
    outputTokens: Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0),
    inputTokens: Number(tokens.input ?? 0) + Number(tokens.cache?.read ?? 0) + Number(tokens.cache?.write ?? 0),
    cacheTokens: Number(tokens.cache?.read ?? 0) + Number(tokens.cache?.write ?? 0),
    cost: Number(part.cost ?? 0),
  };
}

/** Recover billing from saved messages, with each model step counted once.
 * Saved history has no live message sightings, so it never contributes a tok/s
 * rate: without real anchors the windows would be event-processing gaps. */
export function usageFromMessages(
  messages: SessionMessage[], since = 0, until = Infinity, excludeIds = new Set<string>(),
): TurnUsage | undefined {
  const turn = createTurnState(since, 0, false);
  const seen = new Set<string>();
  for (const message of [...messages].sort((a, b) => (a.info?.time?.created ?? 0) - (b.info?.time?.created ?? 0))) {
    const info = message.info;
    if (info?.role !== "assistant" || !info.id || seen.has(info.id) || excludeIds.has(info.id)) continue;
    const created = info.time?.created;
    if (created === undefined || created < since || created > until) continue;
    seen.add(info.id);
    if (info.providerID && info.modelID) turn.messageModels.set(info.id, `${info.providerID}/${info.modelID}`);
    const parts = (message.parts ?? []).filter((part) => part.type === "step-finish");
    // Assistant totals and step-finish parts describe the same spend. Never
    // add both. Some providers/versions only persist the assistant totals.
    const billing = parts.length ? parts : info.tokens ? [info] : [];
    const partIds = new Set<string>();
    for (const part of billing) {
      if (part.id && partIds.has(part.id)) continue;
      if (part.id) partIds.add(part.id);
      const step = stepFigures(part);
      accumulateStep(turn, step, info.id);
      turn.contextTokens = step.inputTokens;
    }
  }
  return turn.steps ? usageOf(turn) : undefined;
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

function accumulateStep(
  turn: TurnState,
  step: { inputTokens: number; outputTokens: number; cacheTokens: number; cost: number },
  messageId: unknown,
): void {
  turn.steps += 1;
  turn.outputTokens += step.outputTokens;
  turn.inputTokens += step.inputTokens;
  turn.cacheTokens += step.cacheTokens;
  turn.cost += step.cost;
  const key = (typeof messageId === "string" ? turn.messageModels.get(messageId) : undefined)
    ?? (turn.model ? `${turn.model.providerID}/${turn.model.modelID}` : "unknown");
  const bucket = turn.modelUsage.get(key) ?? { inputTokens: 0, outputTokens: 0, cacheTokens: 0, cost: 0 };
  bucket.inputTokens += step.inputTokens;
  bucket.outputTokens += step.outputTokens;
  bucket.cacheTokens += step.cacheTokens;
  bucket.cost += step.cost;
  turn.modelUsage.set(key, bucket);
  closeStepWindow(turn, step, messageId);
}

/**
 * Close the finished step's generation window: its output tokens over the time
 * from the message's first sighting to its step-finish. Anchoring per message
 * keeps tool execution and question waits between steps out of the rate, and
 * stays correct when subagent children generate concurrently. Steps whose
 * window cannot be trusted (anchors lost to a stream drop, or absurdly long)
 * keep their tokens in the totals but drop out of the rate.
 */
function closeStepWindow(
  turn: TurnState,
  step: { outputTokens: number },
  messageId: unknown,
): void {
  const finishedAt = Date.now();
  if (typeof messageId === "string") {
    // A history rebuild has no live message sightings, so its fallback anchor
    // would measure the gap between step-end events rather than generation;
    // such steps keep their tokens in the totals but drop out of the rate.
    const startedAt = turn.stepStartAtByMessage.get(messageId) ?? (turn.liveAnchors ? turn.lastStepFinishAt : undefined);
    turn.stepStartAtByMessage.delete(messageId);
    if (startedAt !== undefined) {
      const elapsed = finishedAt - startedAt;
      if (step.outputTokens > 0 && elapsed > 0 && elapsed <= MAX_TIMED_STEP_MS) {
        turn.generationMs += elapsed;
        turn.timedOutputTokens += step.outputTokens;
      }
    }
    // The message is finished; its live-meter tracking goes with it.
    const prefix = `${messageId}:`;
    for (const key of turn.livePartBytes.keys()) if (key.startsWith(prefix)) turn.livePartBytes.delete(key);
    for (const key of turn.deltaFedParts) if (key.startsWith(prefix)) turn.deltaFedParts.delete(key);
  }
  // Advance even for untimed steps so the next fallback window starts fresh.
  turn.lastStepFinishAt = finishedAt;
}

/** Rough token estimate for live metering: ~5 bytes per token, like opencode-tps. */
function estimateTokens(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / 5));
}

function pushLiveSample(turn: TurnState, tokens: number): void {
  const now = Date.now();
  turn.liveTokenSamples.push({ tokens, at: now });
  const cutoff = now - LIVE_TPS_WINDOW_MS;
  while (turn.liveTokenSamples.length && turn.liveTokenSamples[0].at < cutoff) turn.liveTokenSamples.shift();
}

/**
 * Live-meter sampling from a streaming delta event, when the service forwards
 * them over SSE. Deltas are exact chunks, so a part that has produced deltas
 * stops growth-sampling — the two would double-count.
 */
function sampleStreamDelta(properties: any, turn: TurnState, onProgress: ProgressCallback | undefined): void {
  const part = properties?.part;
  const delta = typeof properties?.delta === "string" ? properties.delta : undefined;
  const messageID = typeof part?.messageID === "string"
    ? part.messageID
    : (typeof properties?.messageID === "string" ? properties.messageID : "");
  if (!part?.id || !messageID || !delta) return;
  turn.deltaFedParts.add(`${messageID}:${part.id}`);
  pushLiveSample(turn, estimateTokens(Buffer.byteLength(delta, "utf8")));
  emitLiveStats(turn, onProgress);
}

/**
 * Live-meter sampling from a message.part.updated text/reasoning part: the part
 * carries its accumulated text, so growth since the last sighting becomes one
 * estimated-token sample. Parts fed by delta events are skipped.
 */
function samplePartGrowth(turn: TurnState, part: any, onProgress: ProgressCallback | undefined): void {
  if (!part?.id || typeof part.text !== "string") return;
  const key = `${part.messageID}:${part.id}`;
  if (turn.deltaFedParts.has(key)) return;
  const bytes = Buffer.byteLength(part.text, "utf8");
  const previous = turn.livePartBytes.get(key) ?? 0;
  turn.livePartBytes.set(key, bytes);
  if (bytes <= previous) return;
  pushLiveSample(turn, estimateTokens(bytes - previous));
  emitLiveStats(turn, onProgress);
}

/** Emit the ⚡ live tok/s stats line, throttled; skips when the stream has gone quiet. */
function emitLiveStats(turn: TurnState, onProgress: ProgressCallback | undefined): void {
  const now = Date.now();
  if (now - turn.lastLiveStatsAt < LIVE_STATS_EMIT_MS) return;
  const samples = turn.liveTokenSamples;
  const last = samples[samples.length - 1];
  if (!last || now - last.at > LIVE_TPS_STALE_MS) return;
  let tokens = 0;
  let duration = 0;
  for (let i = 0; i < samples.length; i += 1) {
    tokens += samples[i].tokens;
    if (i > 0) duration += samples[i].at - samples[i - 1].at;
  }
  // Divide by the span the samples cover, not the whole window, so generation
  // that began mid-window is not undercounted; the tail cap keeps a single
  // burst from dividing by near-zero.
  duration += Math.min(now - last.at, 1_000);
  const rate = (tokens / Math.max(duration, LIVE_TPS_MIN_WINDOW_MS)) * 1000;
  turn.lastLiveStatsAt = now;
  emitPublicMetrics(turn, onProgress, rate);
}

function emitPublicMetrics(turn: TurnState, callback: ProgressCallback | undefined, liveRate?: number): void {
  const usage = usageOf(turn);
  emit(callback, {
    kind: "metrics", text: "Usage updated",
    metrics: {
      contextTokens: usage.contextTokens, contextLimit: usage.contextLimit,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheTokens: usage.cacheTokens,
      steps: usage.steps, compactions: usage.compactions, liveTokensPerSecond: liveRate,
      outputTokensPerSecond: usage.outputTokensPerSecond,
    },
  });
}

/** Snapshot of a TurnState's user-facing usage fields. */
function usageOf(turn: TurnState): TurnUsage {
  const rate = turn.generationMs > 0 && turn.timedOutputTokens > 0
    ? (turn.timedOutputTokens * 1000) / turn.generationMs
    : undefined;
  return {
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    cacheTokens: turn.cacheTokens,
    contextTokens: turn.contextTokens,
    contextLimit: turn.contextLimit,
    compactions: turn.compactions - turn.baselineCompactions,
    steps: turn.steps,
    cost: turn.cost,
    ...(rate !== undefined
      ? { outputTokensPerSecond: rate, generationMs: turn.generationMs, timedOutputTokens: turn.timedOutputTokens }
      : {}),
    models: [...turn.modelUsage.entries()]
      .map(([model, usage]) => ({ model, ...usage }))
      .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)),
  };
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

function emit(callback: ProgressCallback | undefined, update: ProgressUpdate): void {
  if (!callback) return;
  Promise.resolve(callback(update)).catch((error) => log("debug", "progress.callback_failed", { error: String(error) }));
}

const PLAN_STATUSES = new Set<ProgressPlanItem["status"]>(["completed", "cancelled", "in_progress"]);

/** Map OpenCode's todo entries onto the card's plan items, defaulting unknown statuses to pending. */
function planFromTodos(todos: readonly unknown[]): ProgressPlanItem[] {
  return todos.map((todo: any) => ({
    content: String(todo?.content ?? ""),
    status: PLAN_STATUSES.has(todo?.status) ? todo.status : "pending",
  }));
}

function isUnfinished(item: ProgressPlanItem): boolean {
  return item.status === "pending" || item.status === "in_progress";
}

export function describeTool(tool: string, input: any, status: string, title?: string, directory?: string): { text: string; detail?: string; command?: boolean } | undefined {
  const normalized = tool.toLowerCase().replace(/-/g, "_");
  if (normalized === "task" || normalized === "subagent") {
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
  if (normalized === "bash" || normalized === "shell") {
    // The command is its own label; `command` lets the card render the recent
    // command tail instead of a generic "Running a command" line.
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

/**
 * Classify a retry action as an exhausted quota. Transient backoff carries no
 * action at all; quota outages do, e.g. OpenCode's free tier:
 * { reason: "free_tier_limit", provider: "opencode", title: "Free limit reached",
 *   message: "Subscribe to OpenCode Go…", label: "subscribe", link: "https://opencode.ai/go" }
 */
function classifyQuotaAction(action: unknown): Omit<QuotaBlock, "until"> | undefined {
  if (!action || typeof action !== "object") return undefined;
  const record = action as Record<string, unknown>;
  const reason = typeof record.reason === "string" ? record.reason : "";
  if (!/free|tier|quota|credit|billing|payment|subscribe/i.test(reason)) return undefined;
  const link = typeof record.link === "string" && /^https?:\/\//.test(record.link) ? record.link : undefined;
  return {
    provider: typeof record.provider === "string" && record.provider ? record.provider : "opencode",
    reason,
    title: typeof record.title === "string" ? record.title : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
    link,
    linkLabel: typeof record.label === "string" ? record.label : undefined,
  };
}

/** The fail-fast error thrown while a provider's quota block is live. */
function quotaBlockedError(block: QuotaBlock, model?: string): Error {
  const extras = [block.message, block.link ? `${block.linkLabel ?? "link"}: ${block.link}` : undefined]
    .filter(Boolean)
    .join(" · ");
  const error = new Error(
    `Provider quota exhausted${model ? ` for ${model}` : ""}: ${block.reason} on ${block.provider}. `
    + `Retries resume ${quotaUntil(block)}.`
    + (extras ? ` ${extras}` : ""),
  );
  error.name = "OpenCodeQuotaError";
  (error as any).providerHint = "Provider quota exhausted (free tier)";
  (error as any).model = model;
  (error as any).quotaBlock = block;
  return error;
}

function enrichProviderError(error: unknown, model?: string, usage?: TurnUsage, quota?: QuotaBlock): Error {
  const block = quota ?? (error as any)?.quotaBlock;
  if (error instanceof Error && (error as any).providerHint) {
    if (block) (error as any).quotaBlock ??= block;
    return error;
  }

  const text = diagnosticText(error);
  let hint = "OpenCode/provider failure";
  // Persisted provider/session errors take precedence over the original transport cause used to discover them.
  if (block || /free.?tier|free usage|subscribe to (?:opencode|go)\b/i.test(text)) hint = "Provider quota exhausted (free tier)";
  else if (/\b401\b|unauthori[sz]ed|invalid api key|authentication/i.test(text)) hint = "Provider authentication failed";
  else if (/\b402\b|payment|required|billing|credit/i.test(text)) hint = "Provider billing/credits problem";
  else if (/\b429\b|rate.?limit|too many requests|quota/i.test(text)) hint = "Provider rate limit/quota reached";
  else if (/model.+(?:not found|unknown|invalid)|\b404\b.+model/i.test(text)) hint = "Configured model is unavailable";
  else if (/\b5\d\d\b|upstream|overloaded|temporarily unavailable/i.test(text)) hint = "Provider upstream error";
  else if (/timeout|timed out|ETIMEDOUT/i.test(text) && !isTransportLikeError(error)) hint = "Provider request timed out";
  else if (isTransportLikeError(error)) hint = "OpenCode transport failure";

  const quotaNote = block
    ? ` Quota resets ${quotaUntil(block)}`
      + (block.message ? ` — ${block.message}` : "")
      + (block.link ? ` ${block.link}` : "")
    : "";
  const enriched = new Error(`${hint}${model ? ` for ${model}` : ""}: ${errorText(error)}${quotaNote}`, { cause: error });
  (enriched as any).providerHint = hint;
  (enriched as any).model = model;
  if (block) (enriched as any).quotaBlock = block;
  // The event stream usually observed real model steps before the failure;
  // keep them so the failed turn can still be ledgered (errorUsage).
  if (usage) (enriched as any).turnUsage = usage;
  if ((error as any)?.details !== undefined) (enriched as any).recoveryDetails = (error as any).details;
  if ((error as any)?.mayStillBeRunning) (enriched as any).mayStillBeRunning = true;
  return enriched;
}

function isTransportLikeError(error: unknown): boolean {
  // A persisted assistant failure is conclusive; reconnecting cannot recover
  // it even when the provider's error happens to mention a socket or network.
  if (error instanceof OpenCodeRequestError && error.details.assistantError) return false;
  const text = diagnosticText(error);
  return /fetch failed|network|socket|connection (?:reset|closed|refused)|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_|SocketError|HeadersTimeoutError|other side closed|terminated|aborted/i.test(text);
}

/**
 * Whether a prompt failure looks like a transient upstream blip worth a quick
 * nudge: provider 5xx/overload or a plain 429 rate limit. Transport-like
 * errors recover through reconciliation instead, persisted assistant errors
 * are conclusive, structured quota blocks have their own failover path, and
 * auth/billing/model errors cannot succeed on a resend.
 */
function isProviderBlip(error: unknown): string | undefined {
  if (isTransportLikeError(error)) return undefined;
  if ((error as { quotaBlock?: unknown } | undefined)?.quotaBlock) return undefined;
  if (error instanceof OpenCodeRequestError && error.details.assistantError) return undefined;
  const text = diagnosticText(error);
  if (/\b401\b|unauthori[sz]ed|invalid api key|authentication/i.test(text)) return undefined;
  if (/\b402\b|payment required|billing|insufficient credit/i.test(text)) return undefined;
  if (/model.+(?:not found|unknown|invalid model)|\b404\b/i.test(text)) return undefined;
  if (/\b5\d\d\b|upstream|overloaded|temporarily unavailable|bad gateway|service unavailable|internal server error/i.test(text)) return "upstream error";
  if (/\b429\b|rate.?limit|too many requests/i.test(text)) return "rate limit";
  return undefined;
}

function diagnosticText(error: unknown, depth = 0): string {
  if (depth > 5) return "";
  if (error instanceof Error) {
    const own = Object.entries(error as unknown as Record<string, unknown>)
      .filter(([key]) => key !== "cause")
      .map(([key, value]) => `${key}=${safeJson(value)}`)
      .join(" ");
    const cause = (error as Error & { cause?: unknown }).cause;
    return [error.name, error.message, own, cause ? diagnosticText(cause, depth + 1) : ""].filter(Boolean).join(" | ");
  }
  if (error && typeof error === "object") return safeJson(error);
  return String(error ?? "");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function stopStream(stream: EventStreamHandle): Promise<void> {
  stream.stop();
  await Promise.race([stream.done.catch(() => undefined), sleep(400)]);
}
