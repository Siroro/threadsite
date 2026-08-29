import fs from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";
import type { ModelUsage, TurnUsage } from "./opencode.js";
import { formatCost, formatTokens, truncate } from "./util.js";

/**
 * Append-only token/cost ledger behind `/site-admin usage`: one JSONL line per
 * completed agent turn (initial, mutation, repair, restart-recovery) and per AI
 * thread-title prompt. A separate file from state.json so day-by-day history
 * survives without growing the store, and so a corrupt line costs one entry,
 * not the whole bot state.
 */
export interface UsageEntry {
  v: 1;
  /** ISO completion timestamp. */
  ts: string;
  label: "turn" | "title";
  threadId: string;
  project: string;
  kind: string;
  durationMs?: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cost: number;
  models: ModelUsage[];
}

interface UsageTotal {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cost: number;
  models: Map<string, ModelUsage & { turns: number }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local-time YYYY-MM-DD key for an ISO timestamp ("today" means bot-local today). */
function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function emptyTotal(): UsageTotal {
  return { turns: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, cost: 0, models: new Map() };
}

function addToTotal(
  total: UsageTotal,
  entry: {
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    cost: number;
    turns?: number;
    models?: Array<ModelUsage & { turns?: number }>;
  },
): void {
  total.turns += entry.turns ?? 1;
  total.inputTokens += entry.inputTokens;
  total.outputTokens += entry.outputTokens;
  total.cacheTokens += entry.cacheTokens;
  total.cost += entry.cost;
  for (const model of entry.models ?? []) {
    const bucket = total.models.get(model.model)
      ?? { model: model.model, inputTokens: 0, outputTokens: 0, cacheTokens: 0, cost: 0, turns: 0 };
    bucket.inputTokens += model.inputTokens;
    bucket.outputTokens += model.outputTokens;
    bucket.cacheTokens += model.cacheTokens;
    bucket.cost += model.cost;
    // Pre-aggregated contributions (a whole day folded into one blob) carry
    // their own turn count; raw entries count as one.
    bucket.turns += model.turns ?? 1;
    total.models.set(model.model, bucket);
  }
}

/** `in 1.2M (980k cached) · out 45.1k · $3.42` */
function figuresLine(total: UsageTotal): string {
  const cached = total.cacheTokens > 0 ? ` (${formatTokens(total.cacheTokens)} cached)` : "";
  return `in ${formatTokens(total.inputTokens)}${cached} · out ${formatTokens(total.outputTokens)} · ${formatCost(total.cost)}`;
}

export class UsageLog {
  constructor(private readonly file: string) {}

  /**
   * Persist one completed usage record. Best-effort: a ledger failure is logged
   * and never fails the turn it describes. Turns whose usage could not be
   * observed (e.g. recovered after finishing while the bot was down) still
   * record a zero-token entry so day turn counts stay truthful.
   */
  async record(input: {
    label?: "turn" | "title";
    threadId: string;
    project: string;
    kind: string;
    durationMs?: number;
    usage?: TurnUsage;
    /** Model to attribute tokens to when the turn reported no per-model breakdown. */
    fallbackModel?: string;
  }): Promise<void> {
    const usage = input.usage;
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const cacheTokens = usage?.cacheTokens ?? 0;
    const cost = usage?.cost ?? 0;
    let models = (usage?.models ?? []).filter((entry) => entry.inputTokens || entry.outputTokens || entry.cost);
    if (!models.length && (inputTokens || outputTokens || cost)) {
      models = [{ model: input.fallbackModel || "unknown", inputTokens, outputTokens, cacheTokens, cost }];
    }
    const entry: UsageEntry = {
      v: 1,
      ts: new Date().toISOString(),
      label: input.label ?? "turn",
      threadId: input.threadId,
      project: input.project,
      kind: input.kind,
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      inputTokens,
      outputTokens,
      cacheTokens,
      cost,
      models,
    };
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (error) {
      log("warn", "usage.record_failed", { file: this.file, error: String(error) });
    }
  }

  /** Render the `/site-admin usage` report covering the last `days` local days (today included). */
  async renderReport(days: number): Promise<string> {
    const dayTotals = await this.summarize(days);
    const total = emptyTotal();
    for (const day of dayTotals) addToTotal(total, { ...day, turns: day.turns, models: [...day.models.values()] });

    if (!dayTotals.length) {
      return `📊 No recorded model usage in the last ${days} day${days === 1 ? "" : "s"}. `
        + "Usage is ledgered per completed turn, so history builds up from now on.";
    }

    const todayKey = localDateKey(new Date());
    const dayLines = dayTotals.map((day) => {
      const date = day.date === todayKey ? `Today · ${day.date}` : day.date;
      return `**${date}** — ${day.turns} turn${day.turns === 1 ? "" : "s"} · ${figuresLine(day)}`;
    });
    if (!dayTotals.some((day) => day.date === todayKey)) {
      dayLines.unshift(`**Today · ${todayKey}** — no completed turns yet`);
    }

    const modelLines = [...total.models.values()]
      .sort((a, b) => b.cost - a.cost || (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))
      .map((model) =>
        `\`${model.model}\` — ${model.turns} turn${model.turns === 1 ? "" : "s"} · in ${formatTokens(model.inputTokens)} · out ${formatTokens(model.outputTokens)} · ${formatCost(model.cost)}`
      );
    const shownModels = modelLines.slice(0, 8);
    const hiddenModels = modelLines.length - shownModels.length;

    const footer =
      `**${days}-day total** — ${total.turns} turn${total.turns === 1 ? "" : "s"} · ${figuresLine(total)}\n\n`
      + `**Models**\n${shownModels.join("\n")}${hiddenModels > 0 ? `\n+${hiddenModels} more model${hiddenModels === 1 ? "" : "s"}` : ""}`
      + (total.cost === 0 && (total.inputTokens || total.outputTokens) > 0
        ? "\n-# Costs show $0 because the provider's pricing is not reported for these models."
        : "");

    // Ephemeral replies cap at 2000 chars: reserve the footer and the possible
    // elision note, then fit as many day lines as possible (newest first) and
    // elide the oldest with a note.
    const header = `📊 **Model usage — last ${days} day${days === 1 ? "" : "s"}**\n`;
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

  private async readEntries(): Promise<UsageEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      log("warn", "usage.read_failed", { file: this.file, error: String(error) });
      return [];
    }
    const entries: UsageEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as UsageEntry;
        if (parsed?.v === 1 && typeof parsed.ts === "string") entries.push(parsed);
      } catch {
        log("warn", "usage.entry_parse_failed", { file: this.file });
      }
    }
    return entries;
  }
}
