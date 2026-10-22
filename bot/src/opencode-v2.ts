import path from "node:path";
import { randomUUID } from "node:crypto";
import { Agent } from "undici";
import { OpenCode, type OpenCodeClient, type ModelInfo, type ModelRef, type SessionInfo,
  type SessionMessageInfo, type SessionInboxInfo, type FormInfo, type PermissionRuleset, type V2Event } from "@opencode/client";
import { config } from "./config.js";
import { log, serializeError } from "./logger.js";
import { applicationMessage, formQuestion } from "./opencode-v2-messages.js";
import { usageFromMessages, reconcileUsage, describeTool, toolLabel, type SessionMessage, type PromptImage,
  type PromptResult, type TurnUsage, type QuotaBlock } from "./opencode-v1.js";
import type { OpenCodeHarness } from "./opencode.js";
import type { ProgressCallback, ProgressUpdate, ProgressPlanItem, ProgressSubagent } from "./progress.js";
import { TurnStepBudget, finishUpInstruction } from "./step-budget.js";
import { steeringInstruction } from "./templates.js";
import { cleanThreadTitle, errorText, parseModel, sleep } from "./util.js";

const requestOptions = () => ({ signal: AbortSignal.timeout(10_000) });
const emptyUsage = (): TurnUsage => ({ inputTokens: 0, outputTokens: 0, cacheTokens: 0,
  contextTokens: 0, cost: 0, steps: 0, compactions: 0, models: [] });
const sameDirectory = (a: string, b: string) => path.resolve(a) === path.resolve(b);
/** A tool label with its target folded into one line, e.g. "📚 Reading · site/src/arena.ts". */
const activityLabel = (described: { text: string; detail?: string }): string => described.detail ? `${described.text} · ${described.detail}` : described.text;
const messageID = () => `msg_${randomUUID().replaceAll("-", "")}`;
const emit = (callback: ProgressCallback | undefined, update: ProgressUpdate): void => {
  try { void Promise.resolve(callback?.(update)).catch((error) => log("warn", "opencode.v2_progress_failed", { error: serializeError(error) })); }
  catch (error) { log("warn", "opencode.v2_progress_failed", { error: serializeError(error) }); }
};

export class V2TurnError extends Error {
  mayStillBeRunning = false;
  turnUsage?: TurnUsage;
  providerBlip?: boolean;
  quotaBlock?: QuotaBlock;
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "OpenCodeV2TurnError"; }
}

interface StepTiming { generationMs: number; timedOutputTokens: number }

/** Pair counts and duration from the same provider attempt. An invalid window
 * contributes neither: adding its tokens alone inflates every other sample. */
function stepTiming(started: number | undefined, streamed: number | undefined,
  tokens: { output: number; reasoning: number } | undefined): StepTiming | undefined {
  if (started === undefined || streamed === undefined || !Number.isFinite(started) || !Number.isFinite(streamed)
    || streamed <= started || !tokens || !Number.isFinite(tokens.output) || !Number.isFinite(tokens.reasoning)
    || tokens.output < 0 || tokens.reasoning < 0 || tokens.output + tokens.reasoning <= 0) return undefined;
  return { generationMs: streamed - started, timedOutputTokens: tokens.output + tokens.reasoning };
}

function timingTotals(samples: Iterable<StepTiming>): Pick<TurnUsage, "generationMs" | "timedOutputTokens" | "outputTokensPerSecond"> {
  let generationMs = 0;
  let timedOutputTokens = 0;
  for (const sample of samples) { generationMs += sample.generationMs; timedOutputTokens += sample.timedOutputTokens; }
  return generationMs > 0 && timedOutputTokens > 0
    ? { generationMs, timedOutputTokens, outputTokensPerSecond: timedOutputTokens * 1000 / generationMs } : {};
}

/** Server-clock provider windows exclude tool waits. History and live samples
 * overlap, so replace by message ID before summing; never divide all billed
 * tokens by a subset's time or use event-arrival gaps as generation time. */
function turnTiming(messages: Array<{ sessionID: string; message: SessionMessageInfo }>, since: number, baseline: ReadonlySet<string>):
Map<string, StepTiming> {
  const samples = new Map<string, StepTiming>();
  for (const { message } of messages) {
    if (message.type !== "assistant" || baseline.has(message.id) || message.time.created < since
      || message.time.completed === undefined) continue;
    const timed = stepTiming(message.time.created, message.time.streamed, message.tokens);
    if (timed) samples.set(message.id, timed);
  }
  return samples;
}

function pendingBrowserQa(history: SessionMessageInfo[], cancelled: unknown = []): Set<string> {
  const ignored = new Set(Array.isArray(cancelled) ? cancelled.filter((id): id is string => typeof id === "string") : []);
  const pending = new Set<string>();
  for (const message of history) {
    if (message.type === "synthetic" && message.metadata?.source === "subagent"
      && typeof message.metadata.childID === "string" && message.metadata.state !== "running") pending.delete(message.metadata.childID);
    if (message.type === "assistant") for (const part of message.content) {
      if (part.type !== "tool" || part.name !== "subagent" || part.state.status !== "completed"
        || part.state.input.agent !== "browser-qa" || part.state.input.background !== true) continue;
      const id = part.state.metadata?.sessionID;
      if (typeof id === "string" && part.state.metadata?.status === "running" && !ignored.has(`${message.id}:${part.id}`)) pending.add(id);
    }
  }
  return pending;
}

interface Watch {
  since: number;
  baseline: ReadonlySet<string>;
  controller: AbortController;
  done: Promise<void>;
  budget?: TurnStepBudget;
  children: Set<string>;
  activeChildren: Set<string>;
  /** Per-child detail for the card's subagent lines; keyed by child session id. */
  subagents: Map<string, { agent: string; steps: Set<string>; activity?: { text: string; at: number } }>;
  callback?: ProgressCallback;
  browserQaChildren: Set<string>;
  lastProgress: number;
  questionIds: Set<string>;
  progressKeys: Map<string, string>;
  steps: Map<string, SessionMessage>;
  models: Map<string, ModelRef>;
  tools: Map<string, { name: string; input?: Record<string, unknown> }>;
  text: Map<string, string>;
  started: Map<string, number>;
  streamed: Map<string, number>;
  timings: Map<string, StepTiming>;
  compactions: number;
  contextLimit?: number;
  quota?: QuotaBlock;
  liveSamples: Array<{ at: number; tokens: number }>;
  lastMeterAt: number;
}

/** Native OpenCode 2 adapter. Submission, observation and completion are separate
 * operations: a broken HTTP/SSE connection is never permission to replay a prompt. */
export class OpenCodeV2Harness implements OpenCodeHarness {
  private readonly client: OpenCodeClient;
  private catalog?: { expires: number; promise: Promise<ModelInfo[]> };
  private readonly watches = new Map<string, Watch>();
  private readonly stopped = new Set<string>();
  private readonly prompts = new Set<string>();
  private readonly quotas = new Map<string, QuotaBlock>();
  failoverModelSource: (() => string[] | null) | undefined;

  constructor(client?: OpenCodeClient) {
    const dispatcher = new Agent({ headersTimeout: config.opencodeRequestHeadersTimeoutMs,
      bodyTimeout: config.opencodeRequestBodyTimeoutMs });
    this.client = client ?? OpenCode.make({ baseUrl: config.opencodeUrl,
      headers: config.opencodePassword ? {
        Authorization: `Basic ${Buffer.from(`opencode:${config.opencodePassword}`).toString("base64")}`,
      } : undefined,
      fetch: (input, init) => fetch(input, { ...init, dispatcher } as RequestInit),
    });
  }

  private async session(directory: string, sessionID: string, signal?: AbortSignal): Promise<SessionInfo> {
    const session = await this.client.session.get({ sessionID }, { signal: signal ?? AbortSignal.timeout(10_000) });
    if (!sameDirectory(session.location.directory, directory)) throw new Error("OpenCode session belongs to a different project workspace");
    return session;
  }

  private models(): Promise<ModelInfo[]> {
    if (this.catalog && this.catalog.expires > Date.now()) return this.catalog.promise;
    const promise = this.client.model.list({}, requestOptions()).then(({ data }) => data).catch((error) => {
      this.catalog = undefined;
      log("warn", "opencode.v2_catalog_failed", { error: serializeError(error) });
      return [];
    });
    this.catalog = { expires: Date.now() + 60_000, promise };
    void promise.then((models) => { if (!models.length && this.catalog?.promise === promise) this.catalog = undefined; });
    return promise;
  }

  async listSelectableModels(): Promise<string[]> {
    return (await this.models()).filter((model) => model.enabled && model.status !== "deprecated")
      .map((model) => `${model.providerID}/${model.id}`).sort();
  }

  async modelAcceptsAttachments(providerID: string, modelID: string): Promise<boolean | undefined> {
    return (await this.models()).find((model) => model.providerID === providerID && model.id === modelID)?.capabilities.input.includes("image");
  }

  private blocked(provider?: string): QuotaBlock | undefined {
    for (const [key, block] of this.quotas) if (block.until <= Date.now()) this.quotas.delete(key);
    return provider ? this.quotas.get(provider) : undefined;
  }

  private fallback(model?: string): string | undefined {
    return (this.failoverModelSource?.() ?? config.opencodeFailoverModels).find((candidate) => {
      try { const parsed = parseModel(candidate); return candidate !== model && parsed && !this.blocked(parsed.providerID); }
      catch { return false; }
    });
  }

  failoverModelForError(error: unknown, attemptedModel?: string): string | undefined {
    const failure = error as V2TurnError;
    if (failure?.mayStillBeRunning || failure?.message === "The agent turn was stopped") return undefined;
    return failure?.providerBlip || failure?.quotaBlock ? this.fallback(attemptedModel) : undefined;
  }

  quotaStatus(): string {
    this.blocked();
    return [...this.quotas.values()].map((block) => `${block.provider} blocked until ${new Date(block.until).toISOString()} · ${block.reason}`).join("; ") || "no active quota blocks";
  }

  async health(): Promise<string> {
    try {
      const info = await this.client.server.info({ signal: AbortSignal.timeout(5_000) });
      return /^2\./.test(info.version) ? `ok (OpenCode ${info.version}, v2)` : `unavailable: expected OpenCode 2, received ${info.version}`;
    } catch (error) { return `unavailable: ${errorText(error)}`; }
  }

  async createSession(directory: string, title: string, signal?: AbortSignal): Promise<string> {
    const session = await this.client.session.create({ location: { directory }, title, agent: "sitebuilder",
      permissions: [{ action: "threadsite_browser", resource: "*", effect: "deny" },
        { action: "playwright_*", resource: "*", effect: "deny" }] },
    { signal: signal ?? AbortSignal.timeout(10_000) });
    return session.id;
  }

  private async configure(directory: string, sessionID: string, agent: string, model?: string, variant?: string): Promise<ModelRef | undefined> {
    // Permissions and guarded tools are part of the runtime contract. Do not
    // run a builder against a server whose native plugin failed to load.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { data } = await this.client.plugin.list({ location: { directory } }, requestOptions());
      const plugin = data.find((plugin) => plugin.id === "threadsite.v2");
      if (plugin?.state.status === "active") break;
      if (plugin?.state.status === "failed" || Date.now() >= deadline) throw new V2TurnError("The ThreadSite v2 runtime plugin is unavailable; rebuild the OpenCode service");
      await sleep(100);
    }
    const session = await this.session(directory, sessionID);
    const parsed = parseModel(model);
    const configuredModel = parsed ? { id: parsed.modelID, providerID: parsed.providerID } : session.model
      ?? (await this.client.agent.get({ agentID: agent, location: { directory } }, requestOptions())).data.model;
    const defaultModel = configuredModel ? undefined : (await this.client.model.default({ location: { directory } }, requestOptions())).data;
    const current = configuredModel ?? (defaultModel ? { id: defaultModel.id, providerID: defaultModel.providerID } : undefined);
    const selected = current ? { id: current.id, providerID: current.providerID,
      ...(variant && variant !== "auto" ? { variant } : {}) } : undefined;
    const vision = agent !== "titler" && !!selected
      && await this.modelAcceptsAttachments(selected.providerID, selected.id) === true;
    // Replace only harness-owned tool rules; preserve any other session rules.
    const permissions: PermissionRuleset = (session.permissions ?? []).filter((rule) =>
      !["threadsite_browser", "playwright_*"].includes(rule.action));
    if (agent === "titler") permissions.push({ action: "*", resource: "*", effect: "deny" });
    permissions.push({ action: "threadsite_browser", resource: "*", effect: vision ? "allow" : "deny" },
      { action: "playwright_*", resource: "*", effect: vision ? "allow" : "deny" });
    await this.client.session.update({ sessionID, permissions }, requestOptions());
    if (session.agent !== agent) await this.client.session.switchAgent({ sessionID, agent }, requestOptions());
    if (selected) await this.client.session.switchModel({ sessionID, model: selected }, requestOptions());
    return selected;
  }

  async prompt(directory: string, sessionID: string, text: string, model?: string, onProgress?: ProgressCallback,
    agent = "sitebuilder", variant?: string, images?: readonly PromptImage[]): Promise<PromptResult> {
    if (this.prompts.has(sessionID)) throw Object.assign(new V2TurnError("A prompt is already attached to this session"), { mayStillBeRunning: true });
    this.prompts.add(sessionID);
    this.stopped.delete(sessionID);
    let watch: Watch | undefined;
    let baseline = new Set<string>();
    const since = Date.now();
    try {
      if (await this.isBusy(directory, sessionID)) throw Object.assign(new V2TurnError("The saved agent turn is still running"), { mayStillBeRunning: true });
      const parsed = parseModel(model);
      const block = this.blocked(parsed?.providerID);
      if (block) {
        const candidate = this.fallback(model);
        if (!candidate) throw Object.assign(new V2TurnError(`Provider quota exhausted until ${new Date(block.until).toISOString()}`), { quotaBlock: block });
        model = candidate;
        emit(onProgress, { text: `⚠️ Switching to ${candidate} while the provider quota resets` });
      }
      const selected = await this.configure(directory, sessionID, agent, model, variant);
      const history = await this.rawMessages(sessionID);
      baseline = new Set(history.map((message) => message.id));
      watch = this.watch(directory, sessionID, onProgress, since, baseline, agent === "sitebuilder");
      if (selected) {
        watch.models.set("__session", selected);
        watch.contextLimit = (await this.models()).find((item) => item.id === selected.id && item.providerID === selected.providerID)?.limit.context;
      }
      const id = messageID();
      let submissionError: unknown;
      try {
        if (this.stopped.has(sessionID)) throw new V2TurnError("The agent turn was stopped");
        await this.client.session.prompt({ sessionID, id, text,
          files: images?.map((image) => ({ uri: image.dataUrl, name: image.filename })), delivery: "queue" }, requestOptions());
      } catch (error) {
        // The server may have persisted this input even when the HTTP reply was lost.
        submissionError = error;
        log("warn", "opencode.v2_submission_uncertain", { sessionID, id, error: serializeError(error) });
      }
      emit(onProgress, { text: "🧠 Model is working", phase: "working" });
      const summary = await this.awaitTurn(directory, sessionID, id, new Set(baseline), watch, onProgress, submissionError);
      if (selected) this.quotas.delete(selected.providerID);
      return { text: summary, usage: await this.finalUsage(directory, sessionID, since, baseline, watch) };
    } catch (cause) {
      const error = cause instanceof V2TurnError ? cause : new V2TurnError(errorText(cause), { cause });
      if (watch) {
        error.turnUsage = await this.finalUsage(directory, sessionID, since, baseline, watch);
        error.quotaBlock ??= watch.quota;
      }
      throw error;
    } finally {
      this.prompts.delete(sessionID);
      if (watch) await this.stopWatch(sessionID, watch);
    }
  }

  private async awaitTurn(directory: string, sessionID: string, id: string, baseline: Set<string>, watch: Watch,
    callback: ProgressCallback | undefined, submissionError: unknown): Promise<string> {
    let idleSince: number | undefined;
    let accepted = !submissionError;
    let continued = false;
    let nudges = config.opencodeBlipNudges;
    let previousFingerprint = "";
    let lastPollError: unknown;
    for (;;) {
      if (this.stopped.has(sessionID)) throw Object.assign(new V2TurnError("The agent turn was stopped"), {
        mayStillBeRunning: await this.isBusy(directory, sessionID).catch(() => true),
      });
      if (watch.quota) {
        const aborted = await this.abortTurn(directory, sessionID).catch(() => false);
        throw Object.assign(new V2TurnError("Provider quota exhausted"), { quotaBlock: watch.quota, mayStillBeRunning: !aborted });
      }
      try {
        // All three are required: an idle status alone does not prove an inbox input was delivered.
        const [history, active, inbox] = await Promise.all([
          this.rawMessages(sessionID), this.client.session.active(requestOptions()),
          this.client.session.inbox.list({ sessionID }, requestOptions()),
        ]);
        lastPollError = undefined;
        const fresh = history.filter((message) => !baseline.has(message.id));
        accepted ||= fresh.some((message) => message.id === id) || inbox.some((input) => input.id === id);
        const fingerprint = JSON.stringify(fresh);
        if (fingerprint !== previousFingerprint) { watch.lastProgress = Date.now(); previousFingerprint = fingerprint; }
        await this.restore(directory, sessionID, watch, callback, history);
        this.restoreSubagents(watch, active);
        // Native background results can wake an idle parent. Keep ownership of
        // this turn until those results are delivered and the parent finishes.
        const busy = !!active[sessionID] || pendingBrowserQa(fresh).size > 0;
        if (!active[sessionID]) await this.resumeBrowserQaResult(sessionID, inbox);
        const newest = [...fresh].reverse();
        const idle = newest.find((message) => message.type === "idle");
        const qaResult = newest.find((message) => message.type === "synthetic" && message.metadata?.source === "subagent"
          && message.metadata.agent === "browser-qa");
        const finishedAfterQa = !qaResult || (idle && newest.indexOf(idle) < newest.indexOf(qaResult));
        if (!busy && !inbox.length && accepted && idle?.type === "idle" && finishedAfterQa) {
          if (idle.outcome === "succeeded") {
            return this.summary(fresh);
          }
          if (idle.outcome === "failed") {
            const failure = new V2TurnError(idle.error?.message || "OpenCode execution failed", { cause: idle.error });
            const diagnostic = JSON.stringify(idle.error);
            failure.providerBlip = !/401|402|404|authentication|invalid.api.key|billing|insufficient.credit/i.test(diagnostic)
              && /429|5\d\d|overload|rate.?limit|upstream/i.test(diagnostic);
            if (failure.providerBlip && nudges-- > 0) {
              // Only a persisted failure AND confirmed idle permit a retry.
              fresh.forEach((message) => baseline.add(message.id));
              await this.client.session.prompt({ sessionID, id: messageID(), text: "Continue the current task after the transient provider error. Preserve partial edits.", delivery: "queue" }, requestOptions());
              continue;
            }
            throw failure;
          }
        }
        if (busy || inbox.length || watch.questionIds.size) idleSince = undefined;
        else idleSince ??= Date.now();
        if (idleSince !== undefined && Date.now() - idleSince > 8_000) {
          if (!accepted) throw new V2TurnError("OpenCode did not persist the submitted input; no prompt was replayed", { cause: submissionError });
          if (continued) throw new V2TurnError("The interrupted agent turn did not resume");
          continued = true;
          // Confirmed idle, delivered input and no terminal success: the service
          // restarted. Continue once without touching the workspace or model.
          fresh.forEach((message) => baseline.add(message.id));
          await this.client.session.prompt({ sessionID, id: messageID(), text:
            "Your previous turn was interrupted by a service restart. Inspect partial edits and continue exactly where it left off; finish the same task and summarize it.", delivery: "queue" }, requestOptions());
          idleSince = undefined;
          watch.lastProgress = Date.now();
        }
        // The busy poll is status only: identical text on every poll would bury
        // the real activity line. Only recovery reconciliation speaks.
        emit(callback, { kind: "heartbeat", text: busy ? "" : "Checking saved agent progress", active: busy });
      } catch (error) {
        if (error instanceof V2TurnError) throw error;
        if (this.notFound(error)) throw new V2TurnError("The saved OpenCode session is gone (unknown session)", { cause: error });
        lastPollError = error;
      }
      if (watch.questionIds.size) watch.lastProgress = Date.now();
      if (Date.now() - watch.lastProgress > config.opencodeReconcileTimeoutMs) {
        const stopped = await this.abortTurn(directory, sessionID).catch(() => false);
        throw Object.assign(new V2TurnError("Agent recovery timed out without progress; partial edits were preserved", { cause: lastPollError }),
          { mayStillBeRunning: !stopped });
      }
      await sleep(config.opencodeReconcilePollMs);
    }
  }

  private summary(messages: SessionMessageInfo[]): string {
    const assistant = [...messages].reverse().find((message) => message.type === "assistant");
    return assistant?.type === "assistant" ? assistant.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim() : "";
  }

  private async rawMessages(sessionID: string, limit?: number): Promise<SessionMessageInfo[]> {
    const messages: SessionMessageInfo[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await this.client.message.list({ sessionID, limit: Math.min(limit ?? 200, 200),
        ...(cursor ? { cursor } : { order: "desc" as const }) }, requestOptions());
      messages.push(...page.data);
      cursor = page.cursor.next ?? undefined;
      if (cursor && cursors.has(cursor)) throw new Error("OpenCode message pagination did not advance");
      if (cursor) cursors.add(cursor);
    } while (cursor && (!limit || messages.length < limit));
    // Pages are newest first. Reverse before the stable timestamp sort so
    // records created in the same millisecond retain admission order.
    return [...new Map(messages.map((message) => [message.id, message])).values()].reverse()
      .sort((a, b) => a.time.created - b.time.created);
  }

  async listMessages(directory: string, sessionID: string, limit = 100): Promise<SessionMessage[]> {
    await this.session(directory, sessionID);
    return (await this.rawMessages(sessionID, limit)).map((message) => applicationMessage(message, sessionID));
  }

  private async usageHistory(directory: string, sessionID: string): Promise<Array<{ sessionID: string; message: SessionMessageInfo }>> {
    await this.session(directory, sessionID);
    const sessions = await this.allSessions();
    const visited = new Set<string>();
    const result: Array<{ sessionID: string; message: SessionMessageInfo }> = [];
    const visit = async (id: string): Promise<void> => {
      if (visited.has(id)) return;
      visited.add(id);
      for (const message of await this.rawMessages(id)) result.push({ sessionID: id, message });
      for (const child of sessions) if (child.parentID === id && sameDirectory(child.location.directory, directory)) await visit(child.id);
    };
    await visit(sessionID);
    return result;
  }

  async usageMessages(directory: string, sessionID: string): Promise<SessionMessage[]> {
    return (await this.usageHistory(directory, sessionID)).map(({ sessionID: id, message }) => applicationMessage(message, id));
  }

  private async finalUsage(directory: string, sessionID: string, since: number, baseline: Set<string>, watch: Watch): Promise<TurnUsage> {
    const observed = usageFromMessages([...watch.steps.values()], since) ?? emptyUsage();
    observed.contextLimit = watch.contextLimit;
    observed.compactions = watch.compactions;
    Object.assign(observed, timingTotals(watch.timings.values()));
    try {
      const entries = await this.usageHistory(directory, sessionID);
      const messages = entries.map(({ sessionID: id, message }) => applicationMessage(message, id));
      observed.compactions = Math.max(observed.compactions, messages.filter((message) =>
        !baseline.has(message.info?.id ?? "") && (message.info?.time?.created ?? 0) >= since
        && message.parts?.some((part) => part.type === "compaction" && part.status === "completed")).length);
      const saved = usageFromMessages(messages, since, Infinity, baseline);
      const result = reconcileUsage(observed, saved) ?? observed;
      const samples = new Map(watch.timings);
      for (const [id, timed] of turnTiming(entries, since, baseline)) samples.set(id, timed);
      Object.assign(result, timingTotals(samples.values()));
      // Child billing is cumulative, but the context indicator belongs to root.
      result.contextTokens = usageFromMessages(messages.filter((message) => message.info?.sessionID === sessionID), since, Infinity, baseline)?.contextTokens
        ?? result.contextTokens;
      return result;
    }
    catch (error) { log("warn", "opencode.v2_usage_recovery_failed", { sessionID, error: serializeError(error) }); return observed; }
  }

  async lastUserMessageId(directory: string, sessionID: string): Promise<string | undefined> {
    await this.session(directory, sessionID);
    return (await this.rawMessages(sessionID, 100)).filter((message) => message.type === "user").at(-1)?.id;
  }

  async lastAssistantModel(directory: string, sessionID: string): Promise<{ providerID: string; modelID: string } | undefined> {
    const session = await this.session(directory, sessionID);
    return session.model ? { providerID: session.model.providerID, modelID: session.model.id } : undefined;
  }

  async isBusy(directory: string, sessionID: string, signal?: AbortSignal): Promise<boolean> {
    const session = await this.session(directory, sessionID, signal);
    const [active, inbox, forms] = await Promise.all([
      this.client.session.active({ signal: signal ?? AbortSignal.timeout(10_000) }),
      this.client.session.inbox.list({ sessionID }, { signal: signal ?? AbortSignal.timeout(10_000) }),
      this.client.session.form.list({ sessionID }, { signal: signal ?? AbortSignal.timeout(10_000) }),
    ]);
    const watch = this.watches.get(sessionID);
    if (watch) this.restoreSubagents(watch, active);
    if (!active[sessionID]) await this.resumeBrowserQaResult(sessionID, inbox);
    if (active[sessionID] || inbox.length || forms.length) return true;
    return pendingBrowserQa(await this.rawMessages(sessionID), session.metadata?.threadsiteCancelledBrowserQa).size > 0;
  }

  private async resumeBrowserQaResult(sessionID: string, inbox: SessionInboxInfo[]): Promise<void> {
    // Native restart recovery can park a job's result without resuming its
    // parent. Wake only an attached turn and reuse the persisted input ID:
    // retries admit the same receipt, never duplicate the model's prompt.
    if (!this.watches.has(sessionID) || this.stopped.has(sessionID)) return;
    for (const item of inbox) if (item.type === "synthetic" && item.payload.metadata?.source === "subagent"
      && item.payload.metadata.agent === "browser-qa") {
      if (this.stopped.has(sessionID)) return;
      await this.client.session.synthetic({ sessionID, id: item.id, ...item.payload, delivery: item.delivery, resume: true }, requestOptions());
    }
  }

  async steer(directory: string, sessionID: string, text: string): Promise<boolean> {
    if (this.stopped.has(sessionID) || !await this.isBusy(directory, sessionID)) return false;
    await this.client.session.synthetic({ sessionID, id: messageID(), text: steeringInstruction([text]), delivery: "steer", resume: false }, requestOptions());
    return true;
  }

  async abortTurn(directory: string, sessionID: string): Promise<boolean> {
    this.stopped.add(sessionID); // Mark before I/O so no concurrent watcher can resurrect it.
    let session = await this.session(directory, sessionID);
    const initialHistory = await this.rawMessages(sessionID);
    const pending = pendingBrowserQa(initialHistory, session.metadata?.threadsiteCancelledBrowserQa);
    if (pending.size) {
      for (const childID of pending) {
        const child = await this.session(directory, childID);
        if (child.parentID !== sessionID) throw new Error("Browser QA session belongs to a different parent");
        this.stopped.add(childID);
        await this.client.session.interrupt({ sessionID: childID, resume: false }, requestOptions());
      }
      // Drain the native job notifications before the final parent interrupt;
      // otherwise a late QA result could resurrect a deliberately stopped turn.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [history, inbox] = await Promise.all([this.rawMessages(sessionID), this.client.session.inbox.list({ sessionID }, requestOptions())]);
        const outstanding = pendingBrowserQa(history);
        for (const item of inbox) if (item.type === "synthetic" && typeof item.payload.metadata?.childID === "string") {
          outstanding.delete(item.payload.metadata.childID);
        }
        if (![...pending].some((id) => outstanding.has(id))) break;
        await this.client.session.interrupt({ sessionID, resume: false }, requestOptions());
        if (Date.now() >= deadline) return false;
        await sleep(100);
      }
      session = await this.session(directory, sessionID);
      const previous = session.metadata?.threadsiteCancelledBrowserQa;
      const cancelledCalls = initialHistory.flatMap((message) => message.type === "assistant" ? message.content.flatMap((part) =>
        part.type === "tool" && part.name === "subagent" && part.state.status === "completed"
          && typeof part.state.metadata?.sessionID === "string" && pending.has(part.state.metadata.sessionID)
          ? [`${message.id}:${part.id}`] : []) : []);
      await this.client.session.update({ sessionID, metadata: { ...session.metadata,
        threadsiteCancelledBrowserQa: [...new Set([...(Array.isArray(previous) ? previous : []), ...cancelledCalls])] } }, requestOptions());
    }
    // Interrupt alone leaves inbox entries capable of starting another execution.
    for (const input of await this.client.session.inbox.list({ sessionID }, requestOptions())) {
      await this.client.session.inbox.cancel({ sessionID, inboxID: input.id }, requestOptions());
    }
    for (const form of await this.client.session.form.list({ sessionID }, requestOptions())) {
      await this.client.session.form.cancel({ sessionID, formID: form.id }, requestOptions());
    }
    await this.client.session.interrupt({ sessionID, resume: false }, requestOptions());
    const deadline = Date.now() + 10_000;
    do {
      if (!await this.isBusy(directory, sessionID)) return true;
      await sleep(100);
    } while (Date.now() < deadline);
    return false;
  }

  async revertSession(directory: string, sessionID: string, messageID: string): Promise<void> {
    await this.session(directory, sessionID);
    // The harness owns Git rollback. Revert conversation only, never snapshots.
    await this.client.session.revert.stage({ sessionID, messageID, files: false }, requestOptions());
    await this.client.session.revert.commit({ sessionID }, requestOptions());
  }

  async compactSession(directory: string, sessionID: string, providerID: string, modelID: string): Promise<void> {
    await this.session(directory, sessionID);
    if (await this.isBusy(directory, sessionID)) throw new Error("Cannot compact a running agent turn");
    const session = await this.client.session.get({ sessionID }, requestOptions());
    await this.client.session.switchModel({ sessionID, model: { id: modelID, providerID, variant: session.model?.variant } }, requestOptions());
    await this.client.session.compact({ sessionID }, requestOptions());
    await this.client.session.wait({ sessionID }, { signal: AbortSignal.timeout(config.opencodeReconcileTimeoutMs) });
    const compaction = (await this.rawMessages(sessionID, 100)).filter((message) => message.type === "compaction").at(-1);
    if (compaction?.type === "compaction" && compaction.status === "failed") {
      throw new V2TurnError(`Session compaction failed: ${compaction.error.message}`, { cause: compaction.error });
    }
  }

  async generateTitle(directory: string, requestText: string, model?: string): Promise<{ title?: string; usage: TurnUsage }> {
    const sessionID = await this.createSession(directory, "ThreadSite title");
    const timeout = AbortSignal.timeout(30_000);
    let usage = emptyUsage();
    try {
      await this.configure(directory, sessionID, "titler", model);
      await this.client.session.prompt({ sessionID, text: `Give this project a short readable title. Return only the title.\n${requestText}`, delivery: "queue" }, { signal: timeout });
      await this.client.session.wait({ sessionID }, { signal: timeout });
      const messages = await this.rawMessages(sessionID);
      usage = usageFromMessages(messages.map((message) => applicationMessage(message, sessionID))) ?? usage;
      if (messages.at(-1)?.type === "idle" && (messages.at(-1) as { outcome: string }).outcome !== "succeeded") throw new V2TurnError("Title generation failed");
      return { title: cleanThreadTitle(this.summary(messages)) || undefined, usage };
    } catch (cause) {
      try { usage = usageFromMessages(await this.usageMessages(directory, sessionID)) ?? usage; } catch { /* keep observed usage */ }
      throw Object.assign(new V2TurnError(errorText(cause), { cause }), { turnUsage: usage });
    } finally {
      // Stop first; failed cleanup must not orphan a title request burning tokens.
      await this.abortTurn(directory, sessionID).catch((error) => log("warn", "opencode.v2_title_abort_failed", { error: serializeError(error) }));
      await this.client.session.remove({ sessionID }, requestOptions()).catch((error) => log("warn", "opencode.v2_title_cleanup_failed", { error: serializeError(error) }));
      this.stopped.delete(sessionID);
    }
  }

  private async allSessions(): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.client.session.list({ limit: 200, cursor }, requestOptions());
      sessions.push(...page.data);
      cursor = page.cursor.next ?? undefined;
      if (cursor && seen.has(cursor)) throw new Error("OpenCode session pagination did not advance");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return sessions;
  }

  async workspaceSessions(): Promise<Array<{ id: string; directory: string; parentID?: string }>> {
    return (await this.allSessions()).filter((session) => {
      const relative = path.relative(config.workspaceRoot, session.location.directory);
      return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    }).map((session) => ({ id: session.id, directory: session.location.directory, parentID: session.parentID }));
  }

  async stopAllSessions(keep: ReadonlySet<string>): Promise<{ sessions: number; aborted: number }> {
    return this.sweep((await this.workspaceSessions()).filter((session) => !keep.has(session.id)));
  }

  async stopSessionsInDirectory(directory: string, knownSessionId: string, keep: ReadonlySet<string>): Promise<{ sessions: number; aborted: number }> {
    const sessions = (await this.workspaceSessions()).filter((session) => sameDirectory(session.directory, directory) && !keep.has(session.id));
    if (!keep.has(knownSessionId) && !sessions.some((session) => session.id === knownSessionId)) {
      try { await this.session(directory, knownSessionId); sessions.push({ id: knownSessionId, directory }); }
      catch (error) { if (!this.notFound(error)) throw error; }
    }
    return this.sweep(sessions);
  }

  private async sweep(sessions: Array<{ id: string; directory: string; parentID?: string }>): Promise<{ sessions: number; aborted: number }> {
    let aborted = 0;
    const parents = new Map(sessions.map((session) => [session.id, session.parentID]));
    const depth = (id: string): number => {
      const visited = new Set<string>();
      while (parents.get(id) && !visited.has(id)) { visited.add(id); id = parents.get(id)!; }
      return visited.size;
    };
    // Native removal cascades. Stop descendants first so no parent can delete
    // their records while they are still running or being reconciled.
    for (const session of [...sessions].sort((a, b) => depth(b.id) - depth(a.id))) {
      try {
        if (await this.isBusy(session.directory, session.id)) {
          if (!await this.abortTurn(session.directory, session.id)) throw new Error("OpenCode session is still running after interruption");
          aborted++;
        }
        await this.client.session.remove({ sessionID: session.id }, requestOptions());
        this.stopped.delete(session.id);
      } catch (error) {
        if (!this.notFound(error)) throw error;
      }
    }
    return { sessions: sessions.length, aborted };
  }

  async deleteSessionsInDirectory(directory: string, knownSessionId: string): Promise<void> {
    await this.stopSessionsInDirectory(directory, knownSessionId, new Set());
    if ((await this.workspaceSessions()).some((session) => sameDirectory(session.directory, directory))) throw new Error("OpenCode still has sessions for the deleted project");
  }

  private notFound(error: unknown): boolean {
    return /SessionNotFound|session.+not found|\b404\b/i.test(errorText(error));
  }

  async setProviderToken(providerID: string, token: string): Promise<void> {
    const { data: provider } = await this.client.provider.get({ providerID }, requestOptions());
    await this.client.credential.create({ integrationID: provider.integrationID ?? providerID, label: "ThreadSite", value: { type: "key", key: token }, activate: true }, requestOptions());
    this.catalog = undefined;
    this.quotas.delete(providerID);
  }

  async clearProviderToken(providerID: string): Promise<void> {
    const { data: provider } = await this.client.provider.get({ providerID }, requestOptions());
    for (const credential of await this.client.credential.list(requestOptions())) {
      if (credential.integrationID === (provider.integrationID ?? providerID)) await this.client.credential.remove({ credentialID: credential.id }, requestOptions());
    }
    this.catalog = undefined;
    this.quotas.delete(providerID);
  }

  private async forms(directory: string): Promise<FormInfo[]> {
    return (await this.client.form.list({ location: { directory } }, requestOptions())).data;
  }

  async listPendingQuestions(directory: string): Promise<Array<{ id: string; sessionID: string; questions: ReturnType<typeof formQuestion>["questions"] }>> {
    return (await this.forms(directory)).map((form) => ({ id: form.id, sessionID: form.sessionID, questions: formQuestion(form).questions }));
  }

  async replyToQuestion(directory: string, requestID: string, answers: string[][]): Promise<void> {
    const form = (await this.forms(directory)).find((item) => item.id === requestID);
    if (!form) throw new Error("The question is no longer pending");
    const answer: Record<string, string | string[]> = {};
    form.fields.filter((field) => !("hidden" in field && field.hidden)).forEach((field, index) => {
      const values = (answers[index] ?? []).map((label) => ("options" in field ? field.options?.find((option) => option.label === label)?.value : undefined) ?? label);
      answer[field.key] = field.type === "multiselect" ? values : values[0] ?? "";
    });
    await this.client.session.form.reply({ sessionID: form.sessionID, formID: requestID, answer }, requestOptions());
  }

  async rejectQuestion(directory: string, requestID: string): Promise<void> {
    const form = (await this.forms(directory)).find((item) => item.id === requestID);
    if (form) await this.client.session.form.cancel({ sessionID: form.sessionID, formID: requestID }, requestOptions());
  }

  async watchExistingTurn(directory: string, sessionID: string, callback?: ProgressCallback, startedAt = Date.now()): Promise<() => Promise<void>> {
    const session = await this.session(directory, sessionID);
    const watch = this.watch(directory, sessionID, callback, startedAt, new Set(), true);
    if (session.model) watch.models.set("__session", session.model);
    await this.restore(directory, sessionID, watch, callback, await this.rawMessages(sessionID));
    return () => this.stopWatch(sessionID, watch);
  }

  private watch(directory: string, sessionID: string, callback: ProgressCallback | undefined, since: number, baseline: Set<string>, budgeted: boolean): Watch {
    const watch: Watch = { since, baseline, controller: new AbortController(), done: Promise.resolve(), children: new Set(), activeChildren: new Set(), subagents: new Map(), callback, browserQaChildren: new Set(),
      lastProgress: Date.now(), questionIds: new Set(), progressKeys: new Map(), steps: new Map(), models: new Map(),
      tools: new Map(), text: new Map(), started: new Map(), streamed: new Map(), timings: new Map(), compactions: 0,
      liveSamples: [], lastMeterAt: 0 };
    this.watches.set(sessionID, watch);
    if (budgeted) {
      watch.budget = new TurnStepBudget({ limit: config.opencodeMaxSteps, since, baseline,
        read: async () => (await this.rawMessages(sessionID)).map((message) => applicationMessage(message, sessionID)),
        send: async (steps, signal) => {
          if (signal.aborted || watch.controller.signal.aborted || this.stopped.has(sessionID) || !await this.isBusy(directory, sessionID)) return false;
          // Use the running session's model/variant; a synthetic input cannot change either.
          await this.client.session.synthetic({ sessionID, id: `msg_threadsite_finish_${sessionID}_${since}`,
            text: finishUpInstruction(steps, config.opencodeMaxSteps), delivery: "steer", resume: false }, { signal });
          return true;
        }, onError: (error) => log("warn", "opencode.v2_finish_steer_failed", { sessionID, error: serializeError(error) }),
      });
      void watch.budget.refresh();
    }
    watch.done = (async () => {
      while (!watch.controller.signal.aborted) {
        try {
          // Rehydrate on every reconnect; global SSE alone cannot replay a gap.
          const sessions = await this.allSessions();
          let changed: boolean;
          do {
            changed = false;
            for (const child of sessions) if (child.parentID && (child.parentID === sessionID || watch.children.has(child.parentID))
              && !watch.children.has(child.id) && sameDirectory(child.location.directory, directory)) {
              watch.children.add(child.id); changed = true;
              if (child.agent === "browser-qa") watch.browserQaChildren.add(child.id);
              const info = watch.subagents.get(child.id);
              if (!info) watch.subagents.set(child.id, { agent: child.agent || "subagent", steps: new Set() });
              else if (child.agent) info.agent = child.agent;
            }
          } while (changed);
          for (const child of watch.children) {
            const childHistory = await this.rawMessages(child);
            this.restoreUsage(watch, child, childHistory);
            this.rehydrateSubagent(watch, child, directory, childHistory);
          }
          await this.restore(directory, sessionID, watch, callback, await this.rawMessages(sessionID));
          this.restoreSubagents(watch, await this.client.session.active(requestOptions()));
          for await (const event of this.client.event.subscribe({ signal: watch.controller.signal })) {
            if (watch.controller.signal.aborted) break;
            this.event(event, directory, sessionID, watch, callback);
          }
        } catch (error) {
          if (!watch.controller.signal.aborted) log("warn", "opencode.v2_event_stream_lost", { sessionID, error: serializeError(error) });
        }
        if (!watch.controller.signal.aborted) await sleep(1_000);
      }
    })();
    return watch;
  }

  private async stopWatch(sessionID: string, watch: Watch): Promise<void> {
    watch.controller.abort();
    await watch.budget?.stop();
    await watch.done;
    watch.activeChildren.clear();
    this.publishSubagents(watch);
    if (this.watches.get(sessionID) === watch) this.watches.delete(sessionID);
  }

  private publish(watch: Watch, key: string, value: ProgressUpdate, callback?: ProgressCallback): void {
    const serialized = JSON.stringify(value);
    if (watch.progressKeys.get(key) === serialized) return;
    watch.progressKeys.set(key, serialized);
    if (value.kind !== "heartbeat") watch.lastProgress = Date.now();
    emit(callback, value);
  }

  private publishSubagents(watch: Watch): void {
    this.publish(watch, "subagents", { kind: "heartbeat", text: "", activeSubagents: watch.activeChildren.size,
      subagents: [...watch.activeChildren].map((id): ProgressSubagent => {
        const info = watch.subagents.get(id);
        return { id, agent: info?.agent ?? "subagent", steps: info?.steps.size ?? 0, activity: info?.activity?.text, activityAt: info?.activity?.at };
      }) }, watch.callback);
  }

  private restoreSubagents(watch: Watch, active: Record<string, unknown>): void {
    watch.activeChildren = new Set([...watch.children].filter((id) => active[id]));
    this.publishSubagents(watch);
  }

  private async restore(directory: string, sessionID: string, watch: Watch, callback: ProgressCallback | undefined, history: SessionMessageInfo[]): Promise<void> {
    this.restoreUsage(watch, sessionID, history);
    this.metrics(watch, callback);
    const forms = (await this.forms(directory)).filter((form) => form.sessionID === sessionID);
    const pending = new Set(forms.map((form) => form.id));
    for (const id of watch.questionIds) if (!pending.has(id)) this.publish(watch, `question:${id}`, {
      kind: "question", text: "Question resolved", question: { requestID: id, questions: [], resolved: true } }, callback);
    watch.questionIds = pending;
    for (const form of forms) this.publish(watch, `question:${form.id}`, { kind: "question", text: "❓ The agent has a question", question: formQuestion(form) }, callback);
    let latestPlan: Record<string, unknown> | undefined;
    let planIsCurrent = false;
    for (const message of history) if (message.type === "assistant") {
      const current = !watch.baseline.has(message.id) && message.time.created >= watch.since;
      for (const part of message.content) {
        if (part.type !== "tool") continue;
        watch.tools.set(part.id, { name: part.name, input: "input" in part.state && typeof part.state.input === "object" ? part.state.input : undefined });
        if (current && ["running", "completed", "error"].includes(part.state.status)) {
          this.toolProgress(watch, sessionID, part.id, part.state.status as "running" | "completed" | "error", directory, false, callback);
        }
        if (part.name === "todowrite" && "input" in part.state && typeof part.state.input === "object") {
          latestPlan = part.state.input; planIsCurrent = current;
        }
      }
    }
    if (latestPlan && (planIsCurrent || (latestPlan.todos as Array<{ status: string }> | undefined)?.some((todo) =>
      todo.status === "pending" || todo.status === "in_progress"))) this.plan(watch, latestPlan, callback);
    const latest = history.at(-1);
    if (latest?.type === "assistant" && latest.retry) {
      this.retry(watch, { next: latest.retry.at, message: latest.retry.error.message }, callback);
    }
  }

  private restoreUsage(watch: Watch, sessionID: string, history: SessionMessageInfo[]): void {
    for (const message of history) {
      if (message.type !== "assistant" || watch.baseline.has(message.id) || message.time.created < watch.since
        || message.time.completed === undefined || !message.tokens) continue;
      // A history fetch begun before a live retry must not restore its old window.
      if (message.time.created < (watch.started.get(message.id) ?? -Infinity)) continue;
      watch.models.set(message.id, message.model);
      watch.steps.set(message.id, applicationMessage(message, sessionID));
      watch.started.set(message.id, message.time.created);
      if (message.time.streamed !== undefined) watch.streamed.set(message.id, message.time.streamed);
      else watch.streamed.delete(message.id);
      const timed = stepTiming(message.time.created, message.time.streamed, message.tokens);
      if (timed) watch.timings.set(message.id, timed);
      else watch.timings.delete(message.id);
    }
  }

  private metrics(watch: Watch, callback?: ProgressCallback): void {
    const usage = usageFromMessages([...watch.steps.values()]) ?? emptyUsage();
    const timing = timingTotals(watch.timings.values());
    this.publish(watch, "metrics", { kind: "metrics", text: "Usage updated", metrics: {
      ...usage, ...timing, outputTokensPerSecond: timing.outputTokensPerSecond, liveTokensPerSecond: undefined,
      contextLimit: watch.contextLimit, compactions: watch.compactions,
    } }, callback);
  }

  private plan(watch: Watch, input: Record<string, unknown>, callback?: ProgressCallback): void {
    if (!Array.isArray(input.todos)) return;
    const plan: ProgressPlanItem[] = input.todos.map((item) => ({ content: String(item?.content ?? ""),
      status: ["pending", "in_progress", "completed", "cancelled"].includes(item?.status) ? item.status : "pending" }));
    this.publish(watch, "plan", { kind: "plan", text: "Updated plan", plan }, callback);
  }

  private toolProgress(watch: Watch, sessionID: string, id: string, status: "running" | "completed" | "error",
    directory: string, child: boolean, callback?: ProgressCallback): void {
    const tool = watch.tools.get(id);
    const described = this.describeToolState(watch, id, status, directory);
    // Same vocabulary as v1: a named action with its target, not a bare tool id.
    if (!tool || !described) return;
    const label = child ? "🤖 Subagent — " : "";
    this.publish(watch, `tool:${id}`, { text: `${label}${described.text}`, detail: described.detail, command: described.command,
      tool: { id: `${sessionID}:${id}`, name: tool.name, status } }, callback);
  }

  /** The human label for a tool call in any state, shared by the activity feed and the per-subagent lines. */
  private describeToolState(watch: Watch, id: string, status: "running" | "completed" | "error", directory: string): { text: string; detail?: string; command?: boolean } | undefined {
    const tool = watch.tools.get(id);
    if (!tool) return undefined;
    const described = status === "error" ? undefined : describeTool(tool.name, tool.input, status, undefined, directory);
    return described ?? { text: status === "error" ? `⚠️ ${toolLabel(tool.name)} hit an error` : `${status === "running" ? "⚙️" : "✓"} ${toolLabel(tool.name)}` };
  }

  /** Child tools stay out of the public feed; they drive the subagent's own line instead. */
  private noteChildTool(watch: Watch, sessionID: string, toolID: string, status: "running" | "completed" | "error", directory: string): void {
    watch.lastProgress = Date.now();
    const info = watch.subagents.get(sessionID);
    const described = this.describeToolState(watch, toolID, status, directory);
    if (info && described) info.activity = { text: activityLabel(described), at: Date.now() };
    this.publishSubagents(watch);
  }

  /** Rebuild a child's steps and last-known activity from history — the stream may have missed everything before attach. */
  private rehydrateSubagent(watch: Watch, sessionID: string, directory: string, history: SessionMessageInfo[]): void {
    const info = watch.subagents.get(sessionID) ?? { agent: "subagent", steps: new Set<string>() };
    watch.subagents.set(sessionID, info);
    for (const message of history) {
      if (message.type !== "assistant") continue;
      if (message.time.completed !== undefined) info.steps.add(message.id);
      for (const part of message.content) if (part.type === "tool") {
        watch.tools.set(part.id, { name: part.name, input: "input" in part.state && typeof part.state.input === "object" ? part.state.input : undefined });
      }
    }
    for (const message of [...history].reverse()) {
      if (message.type !== "assistant") continue;
      for (const part of [...message.content].reverse()) {
        if (part.type !== "tool" || !["running", "completed", "error"].includes(part.state.status)) continue;
        const described = this.describeToolState(watch, part.id, part.state.status as "running" | "completed" | "error", directory);
        if (described) info.activity = { text: activityLabel(described), at: message.time.completed ?? message.time.created };
        return;
      }
    }
  }

  private event(event: V2Event, directory: string, sessionID: string, watch: Watch, callback?: ProgressCallback): void {
    if (event.location && !sameDirectory(event.location.directory, directory)) return;
    if (event.type === "form.created" && event.data.form.sessionID === sessionID) {
      watch.questionIds.add(event.data.form.id);
      this.publish(watch, `question:${event.data.form.id}`, { kind: "question", text: "❓ The agent has a question", question: formQuestion(event.data.form) }, callback);
      return;
    }
    if (event.type === "session.created" && (event.data.parentID === sessionID || watch.children.has(event.data.parentID ?? ""))) {
      watch.children.add(event.data.sessionID);
      const info = watch.subagents.get(event.data.sessionID);
      if (!info) watch.subagents.set(event.data.sessionID, { agent: event.data.agent || "subagent", steps: new Set() });
      else if (event.data.agent) info.agent = event.data.agent;
      if (event.data.agent === "browser-qa") watch.browserQaChildren.add(event.data.sessionID);
      return;
    }
    const data = event.data;
    if (!("sessionID" in data) || (data.sessionID !== sessionID && !watch.children.has(data.sessionID))) return;
    const child = data.sessionID !== sessionID;
    if (child) {
      if (event.type === "session.execution.started" || event.type === "session.step.started" || event.type === "session.tool.called"
        || (event.type === "session.status" && event.data.status.type !== "idle")) watch.activeChildren.add(data.sessionID);
      if (["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.deleted"].includes(event.type)
        || (event.type === "session.status" && event.data.status.type === "idle")) watch.activeChildren.delete(data.sessionID);
      this.publishSubagents(watch);
    }
    switch (event.type) {
      case "session.step.started":
        watch.models.set(event.data.assistantMessageID, event.data.model);
        watch.started.set(event.data.assistantMessageID, event.data.started);
        // A retried step re-anchors and discards its earlier streamed window,
        // mirroring opencode's message updater.
        watch.streamed.delete(event.data.assistantMessageID);
        watch.timings.delete(event.data.assistantMessageID);
        watch.lastProgress = Date.now();
        if (!child) void this.models().then((models) => {
          const selected = event.data.model;
          watch.contextLimit = models.find((model) => model.id === selected.id && model.providerID === selected.providerID)?.limit.context;
        });
        break;
      case "session.step.streamed":
        watch.streamed.set(event.data.assistantMessageID, event.created);
        break;
      case "session.step.ended":
      case "session.step.failed": {
        const step = event.data;
        const model = watch.models.get(step.assistantMessageID);
        watch.steps.set(step.assistantMessageID, { info: { id: step.assistantMessageID, sessionID: step.sessionID,
          role: "assistant", time: { created: watch.started.get(step.assistantMessageID) ?? event.created }, providerID: model?.providerID, modelID: model?.id,
          tokens: step.tokens, cost: step.cost } });
        const timed = stepTiming(watch.started.get(step.assistantMessageID), watch.streamed.get(step.assistantMessageID), step.tokens);
        if (timed) watch.timings.set(step.assistantMessageID, timed);
        else watch.timings.delete(step.assistantMessageID);
        if (child) {
          const info = watch.subagents.get(data.sessionID);
          if (info && !info.steps.has(step.assistantMessageID)) {
            info.steps.add(step.assistantMessageID);
            this.publishSubagents(watch);
          }
        } else watch.budget?.observe(step.assistantMessageID);
        watch.liveSamples = [];
        this.metrics(watch, callback);
        break;
      }
      case "session.text.delta":
      case "session.reasoning.delta":
      case "session.text.ended":
      case "session.reasoning.ended": {
        const part = event.data;
        // Ordinals are local to the content channel: reasoning and public text
        // can both be ordinal 0 in one message. Never reuse their buffers/IDs.
        const reasoning = event.type.startsWith("session.reasoning");
        const key = `${part.assistantMessageID}:${reasoning ? "reasoning" : "text"}:${part.ordinal}`;
        const text = "text" in part ? part.text : (watch.text.get(key) ?? "") + part.delta;
        if (child) {
          if (text.trim()) watch.lastProgress = Date.now();
          break;
        }
        watch.text.set(key, text);
        const now = Date.now();
        const growth = "delta" in part ? part.delta : "";
        if (growth) watch.liveSamples.push({ at: now, tokens: Math.max(1, Buffer.byteLength(growth) / 5) });
        watch.liveSamples = watch.liveSamples.filter((sample) => now - sample.at < 5_000);
        if (watch.liveSamples.length && now - watch.lastMeterAt > 3_000) {
          watch.lastMeterAt = now;
          const rate = watch.liveSamples.reduce((sum, sample) => sum + sample.tokens, 0) * 1000
            / Math.max(250, now - watch.liveSamples[0].at);
          emit(callback, { kind: "metrics", text: "Generating", metrics: { liveTokensPerSecond: rate } });
        }
        this.publish(watch, key, { kind: reasoning ? "thinking" : "thought", text, narrationId: key }, callback);
        break;
      }
      case "session.tool.input.started":
        watch.tools.set(event.data.id, { name: event.data.name }); break;
      case "session.tool.called": {
        const tool = watch.tools.get(event.data.id);
        if (tool) { tool.input = event.data.input;
          if (child) this.noteChildTool(watch, event.data.sessionID, event.data.id, "running", directory);
          else this.toolProgress(watch, event.data.sessionID, event.data.id, "running", directory, false, callback);
          if (!child && tool.name === "todowrite") this.plan(watch, event.data.input, callback); }
        break;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const tool = watch.tools.get(event.data.id);
        if (event.type === "session.tool.failed") log("warn", "opencode.v2_tool_failed", {
          sessionID: event.data.sessionID, tool: tool?.name, error: event.data.error,
        });
        if (child) this.noteChildTool(watch, event.data.sessionID, event.data.id, event.type === "session.tool.success" ? "completed" : "error", directory);
        else if (tool) this.toolProgress(watch, event.data.sessionID, event.data.id,
          event.type === "session.tool.success" ? "completed" : "error", directory, false, callback);
        break;
      }
      case "session.compaction.ended":
        if (!child) { watch.compactions++; this.publish(watch, "compactions", { text: "🧠 Context compacted — continuing automatically" }, callback); }
        break;
      case "session.status":
        if (event.data.status.type === "retry") this.retry(watch, event.data.status, callback,
          watch.browserQaChildren.has(event.data.sessionID) ? event.data.sessionID : undefined);
        // Status is a heartbeat, never evidence of agent progress — and never a
        // headline: the status stream repeats on every event, and its technical
        // text would bury the real activity line between tools.
        if (!child) emit(callback, { kind: "heartbeat", text: "", active: event.data.status.type !== "idle" });
        break;
      case "session.retry.scheduled":
        this.retry(watch, { next: event.data.at, message: event.data.error.message }, callback,
          watch.browserQaChildren.has(event.data.sessionID) ? event.data.sessionID : undefined); break;
      case "session.execution.interrupted":
        if (!child && event.data.reason !== "shutdown") this.stopped.add(sessionID);
        break;
      case "form.replied":
      case "form.cancelled":
        if (!child) { watch.questionIds.delete(event.data.id); this.publish(watch, `question:${event.data.id}`, {
          kind: "question", text: "Question resolved", question: { requestID: event.data.id, questions: [], resolved: true } }, callback); }
        break;
    }
  }

  private retry(watch: Watch, status: { next: number; message: string; action?: { provider: string; reason: string; title: string } }, callback?: ProgressCallback, browserQaSessionID?: string): void {
    if (browserQaSessionID) {
      // Optional QA quota cannot fail or switch the builder's provider. Native
      // cancellation delivers an advisory result to the parent as usual.
      if (status.next - Date.now() >= config.opencodeQuotaBlockMinRetryMs) {
        void this.client.session.interrupt({ sessionID: browserQaSessionID, resume: false }, requestOptions())
          .catch((error) => log("warn", "opencode.v2_qa_interrupt_failed", { sessionID: browserQaSessionID, error: serializeError(error) }));
      }
      emit(callback, { kind: "heartbeat", text: "Browser QA provider retry", detail: status.message });
      return;
    }
    if (status.next - Date.now() >= config.opencodeQuotaBlockMinRetryMs) {
      const provider = status.action?.provider ?? [...watch.models.values()].at(-1)?.providerID;
      if (provider) {
        watch.quota = { provider, reason: status.action?.reason ?? "quota", until: status.next, title: status.action?.title, message: status.message };
        this.quotas.set(provider, watch.quota);
      }
    }
    emit(callback, { kind: "heartbeat", text: "⏳ Provider retry scheduled", detail: status.message });
  }
}
