import path from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { config } from "./config.js";
import { log, logError, serializeError } from "./logger.js";
import type { ProgressCallback } from "./progress.js";
import { cleanThreadTitle, errorText, parseModel, truncate } from "./util.js";

// Sent to a session whose turn was killed by an agent-service restart. The
// workspace keeps the turn's partial edits, so this must continue, not restart.
const CONTINUE_AFTER_RESTART =
  "Your previous turn was interrupted by a service restart. Inspect the workspace for partial edits from that turn, "
+ "continue exactly where it left off, finish the requested change (do not start over), and summarize what you did.";

function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
  if (config.opencodePassword) {
    headers.set(
      "Authorization",
      `Basic ${Buffer.from(`${config.opencodeUsername}:${config.opencodePassword}`).toString("base64")}`,
    );
  }
  return fetch(input, { ...init, headers });
}

function unwrap<T>(result: any, operation: string): T {
  if (result?.error) {
    const text = typeof result.error === "string" ? result.error : JSON.stringify(result.error);
    throw new OpenCodeRequestError(`${operation} failed: ${text}`, { operation, response: result.error });
  }
  return (result?.data ?? result) as T;
}

class OpenCodeRequestError extends Error {
  constructor(message: string, readonly details: Record<string, unknown>) {
    super(message);
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

interface SessionMessage {
  info?: {
    id?: string;
    role?: string;
    agent?: string;
    parentID?: string;
    finish?: string;
    providerID?: string;
    modelID?: string;
    error?: unknown;
    time?: { created?: number; completed?: number };
  };
  parts?: Array<{ type?: string; text?: string }>;
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
  /** Session-lifetime compaction count; starts at the pre-turn baseline. */
  compactions: number;
  /** Value `compactions` started at, so per-turn deltas are distinguishable. */
  baselineCompactions: number;
  model?: { providerID: string; modelID: string };
  /** Subagent sessions (task-tool children of the root session) seen this turn. */
  childSessions: Set<string>;
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
}

/** Result of one completed prompt: the assistant text plus its turn usage. */
export interface PromptResult {
  text: string;
  usage: TurnUsage;
}

export class OpenCodeHarness {
  private readonly client = createOpencodeClient({
    baseUrl: config.opencodeUrl,
    fetch: authFetch,
  });

  // "providerID/modelID" -> advertised context limit, from OpenCode's provider list
  // (which already reflects the generated SURPLUS_CONTEXT_CAP values). Cached briefly.
  private providerLimits?: { expires: number; promise: Promise<Map<string, number>> };

  private providerContextLimits(): Promise<Map<string, number>> {
    if (this.providerLimits && this.providerLimits.expires > Date.now()) return this.providerLimits.promise;
    const promise = this.fetchProviderContextLimits();
    this.providerLimits = { expires: Date.now() + 10 * 60_000, promise };
    return promise;
  }

  private async fetchProviderContextLimits(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    try {
      const response = await authFetch(`${config.opencodeUrl}/provider`, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const providers = (payload as any)?.data?.all ?? (payload as any)?.all;
      if (!Array.isArray(providers)) return map;
      for (const provider of providers) {
        const providerID = typeof provider?.id === "string" ? provider.id : undefined;
        const models = provider?.models;
        if (!providerID || !models || typeof models !== "object") continue;
        for (const [modelID, model] of Object.entries(models as Record<string, unknown>)) {
          const context = Number((model as any)?.limit?.context ?? 0);
          if (context > 0) map.set(`${providerID}/${modelID}`, context);
        }
      }
    } catch (error) {
      log("debug", "opencode.provider_limits_failed", { error: String(error) });
    }
    return map;
  }

  private async applyContextLimit(turn: TurnState, onProgress: ProgressCallback | undefined): Promise<void> {
    const model = turn.model;
    if (!model || turn.contextLimit) return;
    const limit = (await this.providerContextLimits()).get(`${model.providerID}/${model.modelID}`);
    if (!limit || !turn.model || turn.model.providerID !== model.providerID) return;
    turn.contextLimit = limit;
    const stats = composeStats(turn);
    if (stats) emit(onProgress, { kind: "stats", text: stats });
  }

  async createSession(directory: string, title: string): Promise<string> {
    const result = await this.client.session.create({
      query: { directory },
      body: { title },
    } as any);
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
  ): Promise<PromptResult> {
    const body: any = {
      agent,
      parts: [{ type: "text", text }],
    };
    const parsed = parseModel(model);
    if (parsed) body.model = parsed;
    // Model variant, i.e. reasoning effort (opencode "variant"). Omitted for "auto"
    // so the model's built-in default variant applies.
    if (variant && variant !== "auto") body.variant = variant;

    const snapshot = await this.capturePromptSnapshot(directory, sessionId, agent);
    // One TurnState per prompt, shared by the initial event stream and any reconnect
    // so token/context totals survive a transport recovery.
    const turn: TurnState = {
      assistantMessageIds: new Set<string>(),
      outputTokens: 0,
      inputTokens: 0,
      cacheTokens: 0,
      contextTokens: 0,
      cost: 0,
      compactions: snapshot.compactions,
      baselineCompactions: snapshot.compactions,
      model: parsed ? { providerID: parsed.providerID, modelID: parsed.modelID } : undefined,
      childSessions: new Set<string>(),
    };
    if (turn.model) void this.applyContextLimit(turn, onProgress);
    let stream = await this.startEventStream(directory, sessionId, onProgress, turn).catch((error) => {
      log("warn", "opencode.event_stream_unavailable", { sessionId, error: serializeError(error) });
      return undefined;
    });

    emit(onProgress, { text: "🧠 Model is working" });
    log("info", "opencode.prompt_started", {
      sessionId,
      model: model || "default",
      variant: variant || "auto",
      promptChars: text.length,
      baselineMessages: snapshot.ids.size,
    });

    try {
      const summary = await this.sendPromptRaw(directory, sessionId, body);
      log("info", "opencode.prompt_completed", { sessionId, model: model || "default" });
      return { text: summary, usage: usageOf(turn) };
    } catch (error) {
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

        try {
          const recovered = await this.reconcilePrompt(directory, sessionId, snapshot, model, onProgress, error, body);
          log("info", "opencode.prompt_recovered", {
            sessionId,
            model: model || "default",
            originalTransportError: serializeError(error),
          });
          emit(onProgress, { text: "✅ Recovered the completed agent turn" });
          return { text: recovered, usage: usageOf(turn) };
        } catch (recoveryError) {
          const enriched = enrichProviderError(recoveryError, model);
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

      const enriched = enrichProviderError(error, model);
      logError("opencode.prompt_failed", enriched, {
        sessionId,
        model: model || "default",
        provider: parsed?.providerID,
        modelId: parsed?.modelID,
      });
      throw enriched;
    } finally {
      if (stream) await stopStream(stream);
    }
  }

  async listMessages(directory: string, sessionId: string, limit = 100): Promise<SessionMessage[]> {
    return this.listSessionMessages(directory, sessionId, limit);
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

  async isBusy(directory: string, sessionId: string): Promise<boolean> {
    const statuses = await this.sessionStatus(directory);
    const type = (statuses[sessionId] as any)?.type;
    return type === "busy" || type === "retry";
  }

  async revertSession(directory: string, sessionId: string, messageID: string): Promise<void> {
    const result = await this.client.session.revert({
      path: { id: sessionId },
      query: { directory },
      body: { messageID },
    } as any);
    unwrap(result, "OpenCode session revert");
    log("info", "opencode.session_reverted", { sessionId, messageID });
  }

  async compactSession(directory: string, sessionId: string, providerID: string, modelID: string): Promise<void> {
    const result = await this.client.session.summarize({
      path: { id: sessionId },
      query: { directory },
      body: { providerID, modelID, auto: false },
    } as any);
    unwrap(result, "OpenCode session compaction");
    log("info", "opencode.session_compact_requested", { sessionId, model: `${providerID}/${modelID}` });
  }

  async generateTitle(directory: string, requestText: string, model?: string): Promise<string | undefined> {
    const sessionId = await this.createSession(directory, "ThreadSite thread title");
    try {
      const instruction =
        "Write a concise Discord thread title (3-6 words, Title Case, no quotes, no emoji, no trailing punctuation) " +
        "naming the website or game described by this request. Reply with only the title.\n\nREQUEST:\n" +
        truncate(requestText, 1200);
      const raw = await this.prompt(directory, sessionId, instruction, model, undefined, "titler");
      return cleanThreadTitle(raw.text);
    } finally {
      await this.client.session.delete({ path: { id: sessionId }, query: { directory } } as any)
        .catch((error: unknown) => log("debug", "opencode.title_session_delete_failed", { sessionId, error: String(error) }));
    }
  }

  async setProviderToken(providerID: string, token: string): Promise<void> {
    const response = await authFetch(`${config.opencodeUrl}/auth/${encodeURIComponent(providerID)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api", key: token }),
    });
    if (!response.ok) throw new Error(`OpenCode auth update failed (${response.status}): ${await response.text()}`);
    log("info", "opencode.provider_token_updated", { providerID });
  }

  async clearProviderToken(providerID: string): Promise<void> {
    const response = await authFetch(`${config.opencodeUrl}/auth/${encodeURIComponent(providerID)}`, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`OpenCode auth removal failed (${response.status}): ${await response.text()}`);
    }
    log("info", "opencode.provider_token_removed", { providerID });
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
      let messages: SessionMessage[] | undefined;
      try {
        messages = await this.listSessionMessages(directory, sessionId, 100);
        consecutivePollFailures = 0;
      } catch (error) {
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
          emit(onProgress, {
            text: `⏳ Provider retry #${(lastStatus as any)?.attempt ?? "?"}`,
            detail: truncate(String((lastStatus as any)?.message ?? ""), 100) || undefined,
          });
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
    const result = await this.client.session.prompt({
      path: { id: sessionId },
      query: { directory },
      body,
    } as any);
    const response = unwrap<{ parts?: Array<{ type: string; text?: string }> }>(result, "OpenCode prompt");
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

  private async listSessionMessages(directory: string, sessionId: string, limit: number): Promise<SessionMessage[]> {
    const url = new URL(`${config.opencodeUrl}/session/${encodeURIComponent(sessionId)}/message`);
    url.searchParams.set("directory", directory);
    url.searchParams.set("limit", String(limit));
    const response = await authFetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!response.ok) throw new Error(`OpenCode message history returned HTTP ${response.status}: ${truncate(await response.text(), 500)}`);
    const payload = await response.json();
    const data = (payload as any)?.data ?? payload;
    if (!Array.isArray(data)) throw new Error("OpenCode message history returned an unexpected payload");
    return data as SessionMessage[];
  }

  private async sessionStatus(directory: string): Promise<Record<string, unknown>> {
    const url = new URL(`${config.opencodeUrl}/session/status`);
    url.searchParams.set("directory", directory);
    const response = await authFetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!response.ok) throw new Error(`OpenCode session status returned HTTP ${response.status}: ${truncate(await response.text(), 500)}`);
    const payload = await response.json();
    const data = (payload as any)?.data ?? payload;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("OpenCode session status returned an unexpected payload");
    return data as Record<string, unknown>;
  }

  /** Best-effort HTTP abort of a still-running turn; used when recovery stops waiting. */
  async abortTurn(directory: string, sessionId: string): Promise<boolean> {
    const url = new URL(`${config.opencodeUrl}/session/${encodeURIComponent(sessionId)}/abort`);
    url.searchParams.set("directory", directory);
    const response = await authFetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`OpenCode abort returned HTTP ${response.status}: ${truncate(await response.text(), 500)}`);
    log("warn", "opencode.session_aborted_after_recovery_timeout", { sessionId });
    return true;
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

    const done = this.consumeEventStream(response.body, sessionId, onProgress, controller.signal, turn)
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
            this.handleEvent(JSON.parse(payload), sessionId, onProgress, turn);
          } catch (error) {
            log("debug", "opencode.event_parse_failed", { sessionId, error: String(error) });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleEvent(event: any, sessionId: string, onProgress: ProgressCallback | undefined, turn: TurnState): void {
    const properties = event?.properties ?? {};
    const eventSessionId = properties.sessionID ?? properties.part?.sessionID ?? properties.info?.sessionID;
    if (eventSessionId && eventSessionId !== sessionId) {
      // Subagents run in child sessions of the root session. Their activity is
      // surfaced as prefixed progress lines and their tokens/cost fold into the
      // turn stats; everything else from unknown sessions stays filtered out.
      const isChild = eventSessionId && turn.childSessions.has(eventSessionId);
      if (!isChild) return;
      this.handleChildEvent(event, properties, eventSessionId, sessionId, onProgress, turn);
      return;
    }

    if (event?.type === "session.created" && properties.info?.parentID === sessionId) {
      turn.childSessions.add(String(properties.info.id));
      return;
    }
    if (event?.type === "session.updated" && properties.info?.parentID === sessionId) {
      turn.childSessions.add(String(properties.info.id));
      return;
    }

    if (event?.type === "message.updated") {
      // Track assistant message IDs so streaming text parts can be attributed to the
      // model's output rather than the echoed user prompt.
      if (properties.info?.role === "assistant" && properties.info?.id) {
        turn.assistantMessageIds.add(String(properties.info.id));
        const providerID = properties.info.providerID;
        const modelID = properties.info.modelID;
        if (providerID && modelID && (turn.model?.providerID !== providerID || turn.model?.modelID !== modelID)) {
          turn.model = { providerID, modelID };
          void this.applyContextLimit(turn, onProgress);
        }
      }
      return;
    }

    if (event?.type === "session.status") {
      const status = properties.status;
      if (status?.type === "busy") emit(onProgress, { text: "🧠 Model is thinking" });
      if (status?.type === "retry") {
        log("warn", "opencode.provider_retry", {
          sessionId,
          attempt: status.attempt,
          next: status.next,
          message: status.message,
          action: status.action,
        });
        emit(onProgress, { text: `⏳ Provider retry #${status.attempt ?? "?"}` });
      }
      return;
    }

    if (event?.type === "session.error") {
      log("error", "opencode.session_error", { sessionId, providerError: properties.error });
      emit(onProgress, { text: "⚠️ Provider/session error detected" });
      return;
    }

    if (event?.type === "session.compacted") {
      turn.compactions += 1;
      log("info", "opencode.session_compacted", { sessionId, total: turn.compactions });
      emit(onProgress, { text: "🧠 Context compacted — continuing automatically" });
      const stats = composeStats(turn);
      if (stats) emit(onProgress, { kind: "stats", text: stats });
      return;
    }

    if (event?.type === "session.diff") {
      const count = Array.isArray(properties.diff) ? properties.diff.length : undefined;
      emit(onProgress, { text: "🧩 Updating project files", detail: count ? `${count} changed` : undefined });
      return;
    }

    if (event?.type === "todo.updated") {
      const todos = Array.isArray(properties.todos) ? properties.todos : [];
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

    if (part.type === "step-finish") {
      const tokens = part.tokens ?? {};
      turn.outputTokens += Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0);
      // Every step re-processes the full context, so billed input accumulates
      // per step while the context display only wants the newest window size.
      const stepInput = Number(tokens.input ?? 0) + Number(tokens.cache?.read ?? 0) + Number(tokens.cache?.write ?? 0);
      turn.inputTokens += stepInput;
      turn.cacheTokens += Number(tokens.cache?.read ?? 0) + Number(tokens.cache?.write ?? 0);
      turn.contextTokens = stepInput;
      turn.cost += Number(part.cost ?? 0);
      const stats = composeStats(turn);
      if (stats) emit(onProgress, { kind: "stats", text: stats });
      return;
    }

    if (part.type === "text" && !part.synthetic && turn.assistantMessageIds.has(part.messageID)) {
      const text = String(part.text ?? "").trim();
      if (text) emit(onProgress, { kind: "thought", text });
      return;
    }

    if (part.type !== "tool") return;
    const state = part.state ?? {};
    const tool = String(part.tool || "tool");

    if (state.status === "error") {
      log("warn", "opencode.tool_error", {
        sessionId,
        tool,
        error: state.error,
        title: state.title,
      });
      emit(onProgress, { text: `⚠️ ${toolLabel(tool)} hit an error` });
      return;
    }

    if (state.status !== "running" && state.status !== "completed") return;
    const progress = describeTool(tool, state.input, state.status, state.title);
    if (progress) emit(onProgress, progress);
  }

  // Events from a subagent's child session: attributed, prefixed activity lines
  // plus token/cost accounting merged into the parent turn's shared stats.
  private handleChildEvent(
    event: any,
    properties: any,
    childSessionId: string,
    rootSessionId: string,
    onProgress: ProgressCallback | undefined,
    turn: TurnState,
  ): void {
    const label = "🤖 Subagent";

    if (event?.type === "session.status") {
      const type = properties.status?.type;
      if (type === "busy") emit(onProgress, { text: `${label} is working` });
      else if (type === "retry") emit(onProgress, { text: `⏳ ${label} retrying (#${properties.status?.attempt ?? "?"})` });
      return;
    }

    if (event?.type !== "message.part.updated") return;
    const part = properties.part;
    if (!part) return;

    if (part.type === "step-finish") {
      const tokens = part.tokens ?? {};
      turn.outputTokens += Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0);
      turn.inputTokens += Number(tokens.input ?? 0) + Number(tokens.cache?.read ?? 0) + Number(tokens.cache?.write ?? 0);
      turn.cacheTokens += Number(tokens.cache?.read ?? 0) + Number(tokens.cache?.write ?? 0);
      turn.cost += Number(part.cost ?? 0);
      const stats = composeStats(turn);
      if (stats) emit(onProgress, { kind: "stats", text: stats });
      return;
    }

    if (part.type === "text" && !part.synthetic) {
      const text = singleLineText(String(part.text ?? ""));
      if (text) emit(onProgress, { text: `${label}: ${truncate(text, 100)}` });
      return;
    }

    if (part.type !== "tool") return;
    const state = part.state ?? {};
    if (state.status === "error") {
      log("warn", "opencode.subagent_tool_error", {
        sessionId: rootSessionId,
        childSessionId,
        tool: String(part.tool || "tool"),
        error: state.error,
      });
      emit(onProgress, { text: `⚠️ ${label} tool error` });
      return;
    }
    if (state.status !== "running" && state.status !== "completed") return;
    const described = describeTool(String(part.tool || "tool"), state.input, state.status, state.title);
    if (described) emit(onProgress, { text: `${label} — ${described.text}`, detail: described.detail });
  }
}

function singleLineText(value: string): string {
  return value.replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
}

function findTerminalAssistant(messages: SessionMessage[], snapshot: PromptSnapshot): SessionMessage | undefined {
  return messages
    .filter((message) => {
      const info = message.info;
      if (!info?.id || info.role !== "assistant") return false;
      if (snapshot.ids.has(info.id)) return false;
      if ((info.time?.created ?? 0) < snapshot.startedAt - 2_000) return false;
      if (info.agent && info.agent !== snapshot.agent) return false;
      if (info.error) return true;
      if (!info.finish || info.finish === "tool-calls") return false;
      return Boolean(info.time?.completed || info.finish);
    })
    .sort((a, b) => (b.info?.time?.created ?? 0) - (a.info?.time?.created ?? 0))[0];
}

function extractText(parts: Array<{ type?: string; text?: string }> | undefined): string {
  return (parts ?? [])
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text!)
    .join("\n")
    .trim();
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`.replace(/\.0$/, "");
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`.replace(/\.0$/, "");
  return String(count);
}

function composeStats(turn: TurnState): string {
  const text = formatTurnUsage(usageOf(turn));
  return text ? `🧠 ${text}` : "";
}

/** Snapshot of a TurnState's user-facing usage fields. */
function usageOf(turn: TurnState): TurnUsage {
  return {
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    cacheTokens: turn.cacheTokens,
    contextTokens: turn.contextTokens,
    contextLimit: turn.contextLimit,
    compactions: turn.compactions - turn.baselineCompactions,
  };
}

/** Public turn-usage line: current context size, cumulative billed tokens, cache share. */
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
  if (usage.compactions > 0) parts.push(`compacted ${usage.compactions}×`);
  return parts.join(" · ");
}

/** Combine the usage of multiple prompts that belong to one turn (e.g. a repair pass). */
export function addUsage(a: TurnUsage | undefined, b: TurnUsage | undefined): TurnUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  // Context size/limit describe the model's latest window, not amounts to sum.
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheTokens: a.cacheTokens + b.cacheTokens,
    contextTokens: b.contextTokens || a.contextTokens,
    contextLimit: b.contextLimit ?? a.contextLimit,
    compactions: a.compactions + b.compactions,
  };
}

function emit(callback: ProgressCallback | undefined, update: { text: string; detail?: string; kind?: "activity" | "thought" | "stats" }): void {
  if (!callback) return;
  Promise.resolve(callback(update)).catch((error) => log("debug", "progress.callback_failed", { error: String(error) }));
}

function describeTool(tool: string, input: any, status: string, title?: string): { text: string; detail?: string } | undefined {
  const normalized = tool.toLowerCase().replace(/-/g, "_");
  if (normalized === "task") {
    const agent = typeof input?.agent === "string" && input.agent ? input.agent : "subagent";
    const description = typeof input?.description === "string" ? input.description : undefined;
    return {
      text: status === "running" ? `🤖 Delegating to ${agent}` : `🤖 ${agent} finished`,
      detail: description ? truncate(description, 90) : undefined,
    };
  }
  if (normalized === "websearch") return { text: status === "running" ? "🔎 Searching the web" : "🔎 Web research gathered" };
  if (normalized === "webfetch") return { text: status === "running" ? "🌐 Reading a web reference" : "🌐 Web reference read" };
  if (normalized === "asset_download") {
    const destination = typeof input?.destination === "string" ? path.basename(input.destination) : undefined;
    return { text: status === "running" ? "📥 Downloading a media asset" : "📦 Asset saved locally", detail: destination };
  }
  if (["edit", "write", "apply_patch"].includes(normalized)) {
    const target = input?.filePath ?? input?.path ?? input?.file;
    const detail = typeof target === "string" ? path.basename(target) : undefined;
    return { text: status === "running" ? "✏️ Editing code" : "✅ File edit complete", detail };
  }
  if (["read", "glob", "grep", "list"].includes(normalized)) {
    return { text: status === "running" ? "📚 Inspecting the project" : "📚 Project context inspected" };
  }
  if (["todowrite", "todoread"].includes(normalized)) return { text: "🗺️ Organising the build" };
  if (title) return { text: status === "running" ? `⚙️ ${toolLabel(tool)}` : `✅ ${truncate(String(title), 90)}` };
  return status === "running" ? { text: `⚙️ ${toolLabel(tool)}` } : undefined;
}

function toolLabel(tool: string): string {
  return tool.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function enrichProviderError(error: unknown, model?: string): Error {
  if (error instanceof Error && (error as any).providerHint) return error;

  const text = diagnosticText(error);
  let hint = "OpenCode/provider failure";
  // Persisted provider/session errors take precedence over the original transport cause used to discover them.
  if (/\b401\b|unauthori[sz]ed|invalid api key|authentication/i.test(text)) hint = "Provider authentication failed";
  else if (/\b402\b|payment|required|billing|credit/i.test(text)) hint = "Provider billing/credits problem";
  else if (/\b429\b|rate.?limit|too many requests|quota/i.test(text)) hint = "Provider rate limit/quota reached";
  else if (/model.+(?:not found|unknown|invalid)|\b404\b.+model/i.test(text)) hint = "Configured model is unavailable";
  else if (/\b5\d\d\b|upstream|overloaded|temporarily unavailable/i.test(text)) hint = "Provider upstream error";
  else if (/timeout|timed out|ETIMEDOUT/i.test(text) && !isTransportLikeError(error)) hint = "Provider request timed out";
  else if (isTransportLikeError(error)) hint = "OpenCode transport failure";

  const enriched = new Error(`${hint}${model ? ` for ${model}` : ""}: ${errorText(error)}`, { cause: error });
  (enriched as any).providerHint = hint;
  (enriched as any).model = model;
  if ((error as any)?.details !== undefined) (enriched as any).recoveryDetails = (error as any).details;
  if ((error as any)?.mayStillBeRunning) (enriched as any).mayStillBeRunning = true;
  return enriched;
}

function isTransportLikeError(error: unknown): boolean {
  const text = diagnosticText(error);
  return /fetch failed|network|socket|connection (?:reset|closed|refused)|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_|other side closed|terminated|aborted/i.test(text);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
