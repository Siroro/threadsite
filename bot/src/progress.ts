import type { Message } from "discord.js";
import { config } from "./config.js";
import { log } from "./logger.js";

export interface ProgressUpdate {
  text: string;
  detail?: string;
  /**
   * "activity" (default) lines become the rolling status bullet. "thought",
   * "stats", and "changes" update dedicated lines streamed from the agent/harness.
   */
  kind?: "activity" | "thought" | "stats" | "changes";
}

export type ProgressCallback = (update: ProgressUpdate) => void | Promise<void>;

const MAX_SUMMARY_CHARS = 180;
const HISTORY_LINES = 3;
const MAX_RENDER_CHARS = 1990;

export class DiscordProgress {
  private readonly started = Date.now();
  private latest = "🧠 Starting…";
  private readonly history: string[] = [];
  private thought?: string;
  private stats?: string;
  private changes?: string;
  private lastEdit = 0;
  private pending?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly message: Message,
    private readonly title: string,
  ) {
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastEdit > 12_000) void this.flush();
    }, 8_000);
  }

  callback: ProgressCallback = (update) => {
    if (update.kind === "thought") {
      const summary = summarizeThought(update.text);
      if (summary !== undefined) this.thought = summary;
      this.schedule();
    } else if (update.kind === "stats") {
      this.stats = singleLine(update.text);
      this.schedule();
    } else if (update.kind === "changes") {
      this.changes = singleLine(update.text);
      this.schedule();
    } else {
      this.update(update.text, update.detail);
    }
  };

  update(text: string, detail?: string): void {
    if (this.closed) return;
    const line = detail ? `${text} — ${detail}` : text;
    if (line !== this.latest) {
      this.history.push(this.latest);
      while (this.history.length > HISTORY_LINES) this.history.shift();
      this.latest = line;
    }
    this.schedule();
  }

  close(): void {
    this.closed = true;
    if (this.pending) clearTimeout(this.pending);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.pending = undefined;
    this.heartbeat = undefined;
  }

  private schedule(): void {
    const remaining = config.progressUpdateMs - (Date.now() - this.lastEdit);
    if (remaining <= 0) void this.flush();
    else if (!this.pending) this.pending = setTimeout(() => void this.flush(), remaining);
  }

  private async flush(): Promise<void> {
    if (this.closed) return;
    if (this.pending) clearTimeout(this.pending);
    this.pending = undefined;
    this.lastEdit = Date.now();
    try {
      await this.message.edit(this.render());
    } catch (error) {
      log("debug", "discord.progress_edit_failed", { messageId: this.message.id, error: String(error) });
    }
  }

  // Compact rolling view: a short tail of recent activity (newest at the bottom),
  // a summary line of what the model is narrating, and a context-usage subtext.
  // The whole message stays inside Discord's 2000-character edit budget; when it
  // would overflow, the oldest history lines are dropped first.
  private render(): string {
    const elapsed = formatElapsed(Date.now() - this.started);
    const head = `**${this.title}** · ${elapsed}`;
    const withHistory = (history: string[]) =>
      [head, ...[...history, this.latest].map((line) => `• ${singleLine(line)}`)].join("\n");
    let history = this.history;
    let body = withHistory(history);
    while (body.length + (this.thought ? this.thought.length + 8 : 0) + (this.stats ? this.stats.length + 4 : 0) + (this.changes ? this.changes.length + 4 : 0) > MAX_RENDER_CHARS && history.length) {
      history = history.slice(1);
      body = withHistory(history);
    }
    const lines = [body];
    if (this.thought) lines.push(`> 💭 ${this.thought}`);
    if (this.stats) lines.push(`-# ${this.stats}`);
    if (this.changes) lines.push(`-# ${this.changes}`);
    return lines.join("\n").slice(0, MAX_RENDER_CHARS);
  }
}

// Collapse streamed model narration into one short public line: the newest
// sentence, trimmed to a word boundary. Trailing colons are dropped because
// model narration frequently ends with list lead-ins like "Next I will:".
function summarizeThought(text: string, max = MAX_SUMMARY_CHARS): string | undefined {
  const clean = text
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[#>*\-•\s`]+/, "")
    .replace(/[:\s]+$/, "")
    .trim();
  if (clean.length < 12) return undefined;
  const sentences = clean.split(/(?<=[.!?])\s+/);
  let pick = sentences[sentences.length - 1] ?? clean;
  if (pick.length < 12 && sentences.length > 1) pick = sentences[sentences.length - 2] ?? pick;
  if (pick.length > max) {
    const cut = pick.slice(0, max).replace(/\s+\S*$/, "").trim();
    return cut.length < 12 ? undefined : `${cut}…`;
  }
  return pick.length < 12 ? undefined : pick;
}

function singleLine(value: string): string {
  return value
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[:\s]+$/, "")
    .trim();
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
