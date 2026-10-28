import { randomUUID } from "node:crypto";
import { log } from "./logger.js";
import { UsageDatabase } from "./usage-db.js";
import { usageFromMessages, type SessionMessage, type ModelUsage, type TurnUsage } from "./opencode.js";
import { costsHidden, formatCost, formatTokens, truncate } from "./util.js";

/**
 * Indexed token/cost ledger behind `/site-admin usage`: one current row per
 * agent turn — completed or failed, initial, mutation, repair, restart-recovery
 * — plus, in older deployments, per AI thread-title prompt. Turn IDs allow
 * durable revisions without counting recovery twice. The legacy JSONL is imported
 * transactionally and preserved for recovery.
 */
export interface UsageEntry {
  v: 1;
  /** Revisions with the same identity replace earlier snapshots when read. */
  id: string;
  sessionId?: string;
  startedAt?: string;
  pending?: boolean;
  /** ISO completion timestamp. */
  ts: string;
  /** "turn" is a real agent turn; "title" is a retired side prompt kept for historical ledger lines. */
  label: "turn" | "title";
  threadId: string;
  project: string;
  kind: string;
  durationMs?: number;
  /** Present when the turn failed; failed turns still consumed tokens. */
  failed?: true;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cost: number;
  models: ModelUsage[];
  generationMs?: number;
  timedOutputTokens?: number;
}

interface UsageTotal {
  turns: number;
  failedTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cost: number;
  /** Catalog-rate equivalent across surplus-served models; 0 when no recorded
   * turn carries a comparison. */
  catalogCost: number;
  models: Map<string, ModelUsage & { turns: number; /** At least one contributing turn was priced by rate, not by a provider charge. */ unreported?: true; /** At least one of those was a bare catalog guess rather than a live market rate. */ catalogEstimated?: true }>;
}

export type { UsageTotal };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local-time YYYY-MM-DD key for an ISO timestamp ("today" means bot-local today). */
function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function emptyTotal(): UsageTotal {
  return { turns: 0, failedTurns: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, cost: 0, catalogCost: 0, models: new Map() };
}

function addToTotal(
  total: UsageTotal,
  entry: {
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    cost: number;
    turns?: number;
    /** Pre-aggregated failed-turn count, when folding a whole day/blob in. */
    failedTurns?: number;
    /** Single-entry failure marker (a raw ledger line). */
    failed?: boolean;
    /** Ledger label of a raw entry; side prompts are not turns. */
    label?: UsageEntry["label"];
    models?: Array<ModelUsage & { turns?: number }>;
  },
): void {
  // Title prompts spend tokens without counting as agent turns.
  const isTurn = !entry.label || entry.label === "turn";
  total.turns += entry.turns ?? (isTurn ? 1 : 0);
  total.failedTurns += entry.failedTurns ?? (entry.failed && isTurn ? 1 : 0);
  total.inputTokens += entry.inputTokens;
  total.outputTokens += entry.outputTokens;
  total.cacheTokens += entry.cacheTokens;
  total.cost += entry.cost;
  // The comparison lives per model (a turn mixes surplus and other routing),
  // so the total rolls up from the same breakdown.
  total.catalogCost += (entry.models ?? []).reduce((sum, model) => sum + (model.catalogCost ?? 0), 0);
  for (const model of entry.models ?? []) {
    const bucket = total.models.get(model.model)
      ?? { model: model.model, inputTokens: 0, outputTokens: 0, cacheTokens: 0, cost: 0, turns: 0,
        ...(model.reported ? { reported: true as const } : {}) };
    bucket.inputTokens += model.inputTokens;
    bucket.outputTokens += model.outputTokens;
    bucket.cacheTokens += model.cacheTokens;
    bucket.cost += model.cost;
    if (model.catalogCost !== undefined) bucket.catalogCost = (bucket.catalogCost ?? 0) + model.catalogCost;
    // A model's figure is a provider charge only when every contribution in the
    // bucket was; one estimate makes the whole line an estimate. A catalog
    // guess anywhere in it keeps the whole line at the coarser label.
    if (!model.reported) {
      bucket.unreported = true;
      bucket.reported = undefined;
    }
    if (!model.reported && !model.marketEstimated) bucket.catalogEstimated = true;
    // Pre-aggregated contributions (a whole day folded into one blob) carry
    // their own turn count; raw entries count as one.
    bucket.turns += model.turns ?? (isTurn ? 1 : 0);
    total.models.set(model.model, bucket);
  }
}

/** `in 1.2M (980k cached) · out 45.1k · $3.42` */
function figuresLine(total: UsageTotal): string {

  const cached = total.cacheTokens > 0 ? ` (${formatTokens(total.cacheTokens)} cached)` : "";
  return `in ${formatTokens(total.inputTokens)}${cached} · out ${formatTokens(total.outputTokens)}${costsHidden() ? "" : ` · ${formatCost(total.cost)}`}`;
}

export class UsageLog {
  private writes: Promise<void> = Promise.resolve();
  private readonly forgottenThreads = new Set<string>();
  private readonly database: UsageDatabase;
  constructor(legacyFile: string, databaseFile?: string) { this.database = new UsageDatabase(legacyFile, databaseFile); }

  /**
   * Persist one usage record, completed or failed. A write failure is propagated
   * so recovery markers are not cleared before usage is durable. Turns whose usage
   * could not be observed (e.g. recovered after finishing while the bot was
   * down, or dropped before the first model step) retain their turn count;
   * persisted OpenCode history can later fill missing token figures.
   */
  async record(input: {
    id?: string;
    sessionId?: string;
    startedAt?: string;
    pending?: boolean;
    label?: "turn" | "title";
    threadId: string;
    project: string;
    kind: string;
    durationMs?: number;
    /** True when the turn threw or failed validation; its tokens were still spent. */
    failed?: boolean;
    usage?: TurnUsage;
    /** Model to attribute tokens to when the turn reported no per-model breakdown. */
    fallbackModel?: string;
  }): Promise<void> {
    if (this.forgottenThreads.has(input.threadId)) return;
    const usage = input.usage;
    // Incomplete provider snapshots can produce NaN during repair-turn
    // aggregation. Keep them unavailable instead of passing NaN to SQLite.
    const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    let models = (usage?.models ?? []).map((model) => ({ ...model,
      inputTokens: count(model.inputTokens), outputTokens: count(model.outputTokens),
      cacheTokens: count(model.cacheTokens), cost: count(model.cost),
    })).filter((entry) => entry.inputTokens || entry.outputTokens || entry.cost);
    const sum = (key: "inputTokens" | "outputTokens" | "cacheTokens" | "cost") => models.reduce((total, model) => total + model[key], 0);
    const measured = (value: unknown, fallback: number): number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
    const inputTokens = measured(usage?.inputTokens, sum("inputTokens"));
    const outputTokens = measured(usage?.outputTokens, sum("outputTokens"));
    const cacheTokens = measured(usage?.cacheTokens, sum("cacheTokens"));
    const cost = measured(usage?.cost, sum("cost"));
    if (!models.length && (inputTokens || outputTokens || cost)) {
      models = [{ model: input.fallbackModel || "unknown", inputTokens, outputTokens, cacheTokens, cost }];
    }
    const entry: UsageEntry = {
      v: 1,
      id: input.id ?? randomUUID(),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      ...(input.pending ? { pending: true } : {}),
      ts: new Date().toISOString(),
      label: input.label ?? "turn",
      threadId: input.threadId,
      project: input.project,
      kind: input.kind,
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.failed ? { failed: true as const } : {}),
      inputTokens,
      outputTokens,
      cacheTokens,
      cost,
      models,
      ...(usage?.generationMs && Number.isFinite(usage.generationMs) && usage.timedOutputTokens && Number.isFinite(usage.timedOutputTokens)
        && usage.generationMs > 0 && usage.timedOutputTokens > 0
        ? { generationMs: usage.generationMs, timedOutputTokens: usage.timedOutputTokens } : {}),
    };
    await this.append(entry);
  }

  private async append(entry: UsageEntry): Promise<void> {
    const write = this.writes.then(async () => {
      if (this.forgottenThreads.has(entry.threadId)) return;
      await this.database.putEntry(entry);
    });
    this.writes = write.catch((error) => {
      log("warn", "usage.record_failed", { file: this.database.file, error: String(error) });
    });
    await write;
  }

  /** Reconcile saved turn usage and repair catalog estimates when market prices are available. */
  async reconcileThread(threadId: string, sessionId: string, messages: SessionMessage[],
    priceUsage?: (usage: TurnUsage) => Promise<void>): Promise<boolean> {
    if (this.forgottenThreads.has(threadId)) return false;
    let changed = false;
    for (const entry of await this.readEntries(threadId)) {
      if (entry.pending) continue;
      const canRecoverHistory = entry.label === "turn" && entry.sessionId === sessionId && Boolean(entry.startedAt);
      const saved = canRecoverHistory
        ? usageFromMessages(messages, Date.parse(entry.startedAt!), Date.parse(entry.ts)) : undefined;
      const fuller = saved && saved.inputTokens + saved.outputTokens > entry.inputTokens + entry.outputTokens;
      const usage: TurnUsage = fuller ? saved : {
        inputTokens: entry.inputTokens, outputTokens: entry.outputTokens, cacheTokens: entry.cacheTokens,
        cost: entry.cost, models: structuredClone(entry.models), contextTokens: 0, compactions: 0, steps: 0,
      };
      if (priceUsage) await priceUsage(usage);
      if (!fuller && JSON.stringify(usage.models) === JSON.stringify(entry.models)) continue;
      await this.append({ ...entry, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        cacheTokens: usage.cacheTokens, cost: usage.cost, models: usage.models });
      changed = true;
    }
    return changed;
  }

  /** Remove every revision, and ignore late billing from the aborted turn. */
  async threadIds(): Promise<string[]> {
    await this.writes;
    return this.database.threadIds();
  }

  async forgetThread(threadId: string): Promise<void> {
    this.forgottenThreads.add(threadId);
    const write = this.writes.then(async () => {
      await this.database.forget(threadId);
    });
    this.writes = write.catch(() => undefined);
    await write;
  }

  /** Lifetime ledgered usage for one thread (completed + failed turns and title prompts). */
  async threadTotal(threadId: string): Promise<UsageTotal & { lastTs?: string }> {
    await this.writes;
    return this.database.threadTotal(threadId);
  }

  /**
   * Lifetime per-model rollups for the admin models view: one pass over the
   * ledger producing the deployment-wide per-model table and each thread's own
   * model breakdown (with its display name for rendering).
   */
  async modelBreakdown(): Promise<{
    models: Array<ModelUsage & { turns: number }>;
    threads: Array<{ threadId: string; project: string; turns: number; models: Array<ModelUsage & { turns: number }> }>;
  }> {
    const global = emptyTotal();
    const byThread = new Map<string, { project: string; total: UsageTotal }>();
    for (const entry of await this.readEntries()) {
      addToTotal(global, entry);
      let thread = byThread.get(entry.threadId);
      if (!thread) {
        thread = { project: entry.project, total: emptyTotal() };
        byThread.set(entry.threadId, thread);
      }
      addToTotal(thread.total, entry);
    }
    const byVolume = (a: ModelUsage & { turns: number }, b: ModelUsage & { turns: number }) =>
      (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens);
    return {
      models: [...global.models.values()].sort(byVolume),
      threads: [...byThread.entries()]
        .map(([threadId, { project, total }]) => ({ threadId, project, turns: total.turns, models: [...total.models.values()].sort(byVolume) }))
        .sort((a, b) => b.turns - a.turns),
    };
  }

  /** Render the `/site-admin usage` report covering the last `days` local days (today included). */
  async renderReport(days: number): Promise<string> {
    const dayTotals = await this.summarize(days);
    const total = emptyTotal();
    for (const day of dayTotals) addToTotal(total, { ...day, turns: day.turns, models: [...day.models.values()] });

    if (!dayTotals.length) {
      return `📊 No recorded model usage in the last ${days} day${days === 1 ? "" : "s"}. `
        + "Usage is ledgered per turn (completed or failed), so history builds up from now on.";
    }

    const todayKey = localDateKey(new Date());
    const dayLines = dayTotals.map((day) => {
      const date = day.date === todayKey ? `Today · ${day.date}` : day.date;
      const failed = day.failedTurns > 0 ? ` (${day.failedTurns} failed)` : "";
      return `**${date}**: ${day.turns} turn${day.turns === 1 ? "" : "s"}${failed} · ${figuresLine(day)}`;
    });
    if (!dayTotals.some((day) => day.date === todayKey)) {
      dayLines.unshift(`**Today · ${todayKey}**: no turns yet`);
    }

    const modelLines = [...total.models.values()]
      .sort((a, b) => (costsHidden() ? 0 : b.cost - a.cost) || (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))
      .map((model) =>
        `\`${model.model}\`: ${model.turns} turn${model.turns === 1 ? "" : "s"} · in ${formatTokens(model.inputTokens)} · out ${formatTokens(model.outputTokens)}${costsHidden() ? "" : ` · ${formatCost(model.cost)}`}`
      );
    const shownModels = modelLines.slice(0, 8);
    const hiddenModels = modelLines.length - shownModels.length;

    const footer =
      `**${days}-day total**: ${total.turns} turn${total.turns === 1 ? "" : "s"}${total.failedTurns > 0 ? ` (${total.failedTurns} failed)` : ""} · ${figuresLine(total)}\n\n`
      + `**Models**\n${shownModels.join("\n")}${hiddenModels > 0 ? `\n+${hiddenModels} more model${hiddenModels === 1 ? "" : "s"}` : ""}`
      + (!costsHidden() && total.cost === 0 && (total.inputTokens || total.outputTokens) > 0
        ? "\n-# Costs show $0 because the provider's pricing is not reported for these models."
        : "");

    // Ephemeral replies cap at 2000 chars: reserve the footer and the possible
    // elision note, then fit as many day lines as possible (newest first) and
    // elide the oldest with a note.
    const header = `📊 **Model usage, last ${days} day${days === 1 ? "" : "s"}**\n`;
    const budget = 1950 - header.length - footer.length - 64;
    const fitted: string[] = [];
    let omitted = 0;
    for (const line of dayLines) {
      const next = [...fitted, line].join("\n");
      if (next.length > budget) {
        omitted = dayLines.length - fitted.length;
        break;
      }
      fitted.push(line);
    }
    const omissionNote = omitted > 0 ? `\n… ${omitted} older day${omitted === 1 ? "" : "s"} with usage elided for length` : "";
    return truncate(`${header}${fitted.join("\n")}${omissionNote}\n\n${footer}`, 1950);
  }

  /** Per-local-day totals within the window, newest first; days without usage are skipped. */
  private async summarize(days: number): Promise<Array<{ date: string } & UsageTotal>> {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const since = startOfToday.getTime() - (days - 1) * DAY_MS;
    const entries = await this.readEntries(undefined, new Date(since).toISOString());

    const byDay = new Map<string, { date: string } & UsageTotal>();
    for (const entry of entries) {
      const ts = Date.parse(entry.ts);
      if (!Number.isFinite(ts) || ts < since) continue;
      const key = localDateKey(new Date(ts));
      let day = byDay.get(key);
      if (!day) {
        day = { date: key, ...emptyTotal() };
        byDay.set(key, day);
      }
      addToTotal(day, entry);
    }
    return [...byDay.values()].sort((a, b) => b.date.localeCompare(a.date));
  }

  private async readEntries(threadId?: string, since?: string): Promise<UsageEntry[]> {
    await this.writes;
    return this.database.entries(threadId, since);
  }
}
