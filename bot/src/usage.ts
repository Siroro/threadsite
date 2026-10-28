import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "./logger.js";
import { usageFromMessages, type SessionMessage, type ModelUsage, type TurnUsage } from "./opencode.js";
import { formatCost, formatTokens, truncate } from "./util.js";

/**
 * Append-only token/cost ledger behind `/site-admin usage`: one JSONL line per
 * agent turn — completed or failed, initial, mutation, repair, restart-recovery
 * — plus, in older deployments, per AI thread-title prompt. Turn IDs allow
 * durable revisions without counting recovery twice. A separate file from
 * project state so day-by-day history survives without growing the store, and
 * so a corrupt line costs one entry, not the whole bot state.
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
  models: Map<string, ModelUsage & { turns: number; /** At least one contributing turn priced by rate, not by a provider charge. */ unreported?: true }>;
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
      ?? { model: model.model, inputTokens: 0, outputTokens: 0, cacheTokens: 0, cost: 0, turns: 0 };
    bucket.inputTokens += model.inputTokens;
    bucket.outputTokens += model.outputTokens;
    bucket.cacheTokens += model.cacheTokens;
    bucket.cost += model.cost;
    if (model.catalogCost !== undefined) bucket.catalogCost = (bucket.catalogCost ?? 0) + model.catalogCost;
    // A model's figure is a provider charge only when every contribution in the
    // bucket was; one estimate makes the whole line an estimate.
    if (!model.reported) bucket.unreported = true;
    // Pre-aggregated contributions (a whole day folded into one blob) carry
    // their own turn count; raw entries count as one.
    bucket.turns += model.turns ?? (isTurn ? 1 : 0);
    total.models.set(model.model, bucket);
  }
}

/** `in 1.2M (980k cached) · out 45.1k · $3.42` */
function figuresLine(total: UsageTotal): string {

  const cached = total.cacheTokens > 0 ? ` (${formatTokens(total.cacheTokens)} cached)` : "";
  return `in ${formatTokens(total.inputTokens)}${cached} · out ${formatTokens(total.outputTokens)} · ${formatCost(total.cost)}`;
}

export class UsageLog {
  private writes: Promise<void> = Promise.resolve();
  private readonly forgottenThreads = new Set<string>();
  constructor(private readonly file: string) {}

  /**
   * Persist one usage record, completed or failed. Best-effort: a ledger
   * failure is logged and never fails the turn it describes. Turns whose usage
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
    const inputTokens = usage?.inputTokens ?? usage?.models?.reduce((sum, model) => sum + model.inputTokens, 0) ?? 0;
    const outputTokens = usage?.outputTokens ?? usage?.models?.reduce((sum, model) => sum + model.outputTokens, 0) ?? 0;
    const cacheTokens = usage?.cacheTokens ?? usage?.models?.reduce((sum, model) => sum + model.cacheTokens, 0) ?? 0;
    const cost = usage?.cost ?? usage?.models?.reduce((sum, model) => sum + model.cost, 0) ?? 0;
    let models = (usage?.models ?? []).filter((entry) => entry.inputTokens || entry.outputTokens || entry.cost);
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
    };
    await this.append(entry);
  }

  private async append(entry: UsageEntry): Promise<void> {
    const write = this.writes.then(async () => {
      if (this.forgottenThreads.has(entry.threadId)) return;
      const previous = (await this.readEntries(false)).find((value) => value.id === entry.id);
      // Keep durable counts if recovery temporarily cannot read history.
      if (previous && previous.inputTokens + previous.outputTokens > entry.inputTokens + entry.outputTokens) {
        entry = { ...entry, inputTokens: previous.inputTokens, outputTokens: previous.outputTokens,
          cacheTokens: previous.cacheTokens, cost: previous.cost, models: previous.models };
      }
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const handle = await fs.open(this.file, "a");
      try {
        // The leading newline isolates a torn last line from a previous crash.
        await handle.writeFile(`\n${JSON.stringify(entry)}\n`, "utf8");
        await handle.sync();
      } finally { await handle.close(); }
    });
    this.writes = write.catch((error) => {
      log("warn", "usage.record_failed", { file: this.file, error: String(error) });
    });
    await this.writes;
  }

  /** Reconcile saved turn usage from its session and time boundaries. */
  async reconcileThread(threadId: string, sessionId: string, messages: SessionMessage[]): Promise<boolean> {
    if (this.forgottenThreads.has(threadId)) return false;
    let changed = false;
    for (const entry of await this.readEntries()) {
      if (entry.threadId !== threadId || entry.label !== "turn") continue;
      const until = Date.parse(entry.ts);
      if (entry.pending || entry.sessionId !== sessionId || !entry.startedAt) continue;
      const since = Date.parse(entry.startedAt);
      const saved = usageFromMessages(messages, since, until);
      if (!saved || saved.inputTokens + saved.outputTokens <= entry.inputTokens + entry.outputTokens) continue;
      await this.append({ ...entry, sessionId, startedAt: new Date(since).toISOString(),
        inputTokens: saved.inputTokens, outputTokens: saved.outputTokens, cacheTokens: saved.cacheTokens,
        cost: saved.cost, models: saved.models });
      changed = true;
    }
    return changed;
  }

  /** Remove every revision, and ignore late billing from the aborted turn. */
  async threadIds(): Promise<string[]> {
    return [...new Set((await this.readEntries()).map((entry) => entry.threadId))];
  }

  async forgetThread(threadId: string): Promise<void> {
    this.forgottenThreads.add(threadId);
    const write = this.writes.then(async () => {
      const raw = await fs.readFile(this.file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ""; throw error;
      });
      const lines = raw.split("\n").filter((line) => {
        try { return JSON.parse(line).threadId !== threadId; } catch { return true; }
      });
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temporary, "wx", 0o600);
        try { await handle.writeFile(lines.join("\n")); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, this.file);
      } finally { await fs.rm(temporary, { force: true }); }
    });
    this.writes = write.catch(() => undefined);
    await write;
  }

  /** Lifetime ledgered usage for one thread (completed + failed turns and title prompts). */
  async threadTotal(threadId: string): Promise<UsageTotal & { lastTs?: string }> {
    const total = emptyTotal();
    let lastTs: string | undefined;
    for (const entry of await this.readEntries()) {
      if (entry.threadId !== threadId) continue;
      addToTotal(total, entry);
      if (!lastTs || entry.ts > lastTs) lastTs = entry.ts;
    }
    return { ...total, lastTs };
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
      .sort((a, b) => b.cost - a.cost || (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))
      .map((model) =>
        `\`${model.model}\`: ${model.turns} turn${model.turns === 1 ? "" : "s"} · in ${formatTokens(model.inputTokens)} · out ${formatTokens(model.outputTokens)} · ${formatCost(model.cost)}`
      );
    const shownModels = modelLines.slice(0, 8);
    const hiddenModels = modelLines.length - shownModels.length;

    const footer =
      `**${days}-day total**: ${total.turns} turn${total.turns === 1 ? "" : "s"}${total.failedTurns > 0 ? ` (${total.failedTurns} failed)` : ""} · ${figuresLine(total)}\n\n`
      + `**Models**\n${shownModels.join("\n")}${hiddenModels > 0 ? `\n+${hiddenModels} more model${hiddenModels === 1 ? "" : "s"}` : ""}`
      + (total.cost === 0 && (total.inputTokens || total.outputTokens) > 0
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
    const entries = await this.readEntries();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const since = startOfToday.getTime() - (days - 1) * DAY_MS;

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

  private async readEntries(waitForWrites = true): Promise<UsageEntry[]> {
    if (waitForWrites) await this.writes;
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      log("warn", "usage.read_failed", { file: this.file, error: String(error) });
      return [];
    }
    const entries = new Map<string, UsageEntry>();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as UsageEntry;
        if (parsed?.v === 1 && typeof parsed.id === "string" && typeof parsed.ts === "string") {
          entries.set(parsed.id, parsed);
        }
      } catch {
        log("warn", "usage.entry_parse_failed", { file: this.file });
      }
    }
    return [...entries.values()];
  }
}
