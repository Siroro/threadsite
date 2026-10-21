import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Message, type MessageEditOptions } from "discord.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { renderProgressCard, renderProgressText, type ProgressSnapshot, type ProgressActivity, type ProgressContext, type ProgressFiles, type ProgressMetrics, type ProgressPhase, type ProgressPlanItem, type ProgressTool } from "./progress-view.js";
export type { ProgressContext, ProgressFiles, ProgressMetrics, ProgressPhase, ProgressPlanItem, ProgressTool } from "./progress-view.js";

/** One question the agent asked via OpenCode's question tool. */
export interface AgentQuestion {
  /** OpenCode question request id, used to route the Discord answer back. */
  requestID: string;
  questions: Array<{
    header: string;
    question: string;
    multiple?: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
  /** Set when the request was answered/rejected on the OpenCode side. */
  resolved?: boolean;
}

export interface ProgressUpdate {
  text: string;
  detail?: string;
  /**
   * Activity drives the current action and recent history. Structured updates
   * populate independent card sections; thought is public assistant narration,
   * never the model's reasoning stream. Questions also carry answer buttons.
   */
  kind?: "activity" | "thought" | "stats" | "changes" | "question" | "plan" | "metrics" | "context" | "queue";
  question?: AgentQuestion;
  phase?: ProgressPhase;
  context?: ProgressContext;
  plan?: ProgressPlanItem[];
  metrics?: ProgressMetrics;
  files?: ProgressFiles;
  tool?: ProgressTool;
  queuedRequests?: number;
}

export type ProgressCallback = (update: ProgressUpdate) => void | Promise<void>;

const MAX_SUMMARY_CHARS = 280;
// Keep a small event tail; the card shows the most recent useful activities.
const HISTORY_LINES = 8;

export class DiscordProgress {
  private readonly started = Date.now();
  private latest: ProgressActivity = { text: "Preparing your update", at: this.started };
  private readonly history: ProgressActivity[] = [];
  private phase: ProgressPhase = "preparing";
  private context: ProgressContext = {};
  private plan: ProgressPlanItem[] = [];
  private metrics?: ProgressMetrics;
  private metricsAt = 0;
  private files?: ProgressFiles;
  private queuedRequests = 0;
  private readonly tools = new Map<string, ProgressTool>();
  private inFlight?: Promise<void>;
  private dirty = false;
  private textOnly = false;
  private thought?: string;
  private stats?: string;
  private changes?: string;
  private question?: AgentQuestion;
  /**
   * Pinned block directly under the head: the question, then who answered and
   * what they picked once resolved. Stays visible for the rest of the turn.
   */
  private questionPin?: { requestID: string; question: string; resolution?: string };
  private lastEdit = 0;
  /** Last time the agent reported anything at all; drives the stalled watchdog. */
  private lastActivityAt = this.started;
  private pending?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private closed = false;
  /** When set, a persistent Stop button rides under every render of the turn. */
  private stopCustomId?: string;

  constructor(
    private readonly message: Message,
    private readonly title: string,
  ) {
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastEdit > 12_000) void this.flush();
    }, 8_000);
  }

  callback: ProgressCallback = (update) => {
    if (this.closed) return;
    // A newly queued user message is not agent progress: it must not hide a
    // provider that has stopped emitting events.
    if (update.kind !== "queue") this.lastActivityAt = Date.now();
    if (update.phase) this.phase = update.phase;
    if (update.context) this.context = { ...this.context, ...update.context };
    if (update.metrics) { this.metrics = { ...this.metrics, ...update.metrics }; this.metricsAt = Date.now(); }
    if (update.files) this.files = update.files;
    if (update.queuedRequests !== undefined) this.queuedRequests = Math.max(0, update.queuedRequests);
    if (update.plan) this.plan = update.plan;
    if (update.tool) {
      const previous = this.tools.get(update.tool.id);
      this.tools.set(update.tool.id, update.tool);
      if (previous?.status === update.tool.status) { this.schedule(); return; }
      this.update(update.text, update.detail, update.tool.id);
    } else if (["context", "metrics", "plan", "queue"].includes(update.kind ?? "")) {
      this.schedule();
    } else if (update.kind === "thought") {
      const summary = summarizeThought(update.text);
      if (summary !== undefined) this.thought = summary;
      this.schedule();
    } else if (update.kind === "stats") {
      this.stats = singleLine(update.text);
      this.schedule();
    } else if (update.kind === "changes") {
      this.changes = singleLine(update.text);
      this.schedule();
    } else if (update.kind === "question") {
      if (update.question?.resolved) {
        if (this.questionPin?.requestID === update.question.requestID && !this.questionPin.resolution) {
          this.question = undefined;
          // Generic decision line for answers that didn't come from the
          // Discord buttons (recordAnswer/recordSkip write the named one).
          this.questionPin.resolution = singleLine(update.text);
          this.schedule();
        }
      } else if (update.question) {
        this.question = update.question;
        const first = update.question.questions[0];
        const asked = first ? `${first.header}: ${first.question}` : update.text;
        const question = `❓ ${singleLine(asked)}${update.question.questions.length > 1 ? ` (+${update.question.questions.length - 1} more)` : ""}`;
        this.questionPin = { requestID: update.question.requestID, question };
        this.update(update.text, update.detail);
      }
    } else {
      this.update(update.text, update.detail);
    }
  };

  /** Buttons for the pending agent question; empty when none is pending. */
  questionComponents(): Array<ActionRowBuilder<ButtonBuilder>> {
    if (!this.question) return [];
    const rows: Array<ActionRowBuilder<ButtonBuilder>> = [];
    this.question.questions.slice(0, 5).forEach((q, qIndex) => {
      const row = new ActionRowBuilder<ButtonBuilder>();
      for (const [oIndex, option] of q.options.slice(0, 4).entries()) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`q:${this.question!.requestID}:${qIndex}:${oIndex}`)
            .setLabel(option.label.slice(0, 80))
            .setStyle(ButtonStyle.Primary),
        );
      }
      // Skip rejects the whole request; offer it once, on the first row.
      if (qIndex === 0) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`qskip:${this.question!.requestID}`)
            .setLabel("Skip — decide yourself")
            .setStyle(ButtonStyle.Secondary),
        );
      }
      rows.push(row);
    });
    return rows;
  }

  /** The stored pending question, for resolving button customIds back to labels. */
  pendingQuestion(requestID: string): AgentQuestion | undefined {
    return this.question?.requestID === requestID ? this.question : undefined;
  }

  /** Drop the stored question once answered/rejected so flushes stop re-rendering it. */
  clearQuestion(requestID: string): void {
    if (this.question?.requestID === requestID) {
      this.question = undefined;
      this.schedule();
    }
  }

  /**
   * Pin who answered the pinned question and what they picked. Called from the
   * button handler, which knows the Discord user; the OpenCode resolved event
   * carries no responder, so it only fills in a fallback line.
   */
  recordAnswer(requestID: string, responder: string, label: string): void {
    if (this.questionPin?.requestID !== requestID) return;
    this.questionPin.resolution = `✅ ${singleLine(responder)} chose: ${singleLine(label)}`;
    this.schedule();
  }

  /** Pin that the pinned question was skipped and by whom. */
  recordSkip(requestID: string, responder: string): void {
    if (this.questionPin?.requestID !== requestID) return;
    this.questionPin.resolution = `⏭️ ${singleLine(responder)} skipped — the agent uses its best judgment`;
    this.schedule();
  }

  /** Show a Stop button under the live status while the turn runs; the final outcome edit clears it. */
  enableStopButton(customId = "threadsite:stop"): void {
    this.stopCustomId = customId;
    this.schedule();
  }

  update(text: string, detail?: string, key?: string): void {
    if (this.closed) return;
    this.lastActivityAt = Date.now();
    if (/waiting for (?:the )?project queue|queued/i.test(text)) this.phase = "queued";
    // A generic session-busy event must not bury a more useful running tool.
    if (/model is (?:thinking|working)/i.test(text) && [...this.tools.values()].some((tool) => tool.status === "running")) return;
    if (text !== this.latest.text || detail !== this.latest.detail) {
      if (!key || this.latest.key !== key) this.history.push(this.latest);
      while (this.history.length > HISTORY_LINES) this.history.shift();
      if (key) {
        const existing = this.history.findIndex((activity) => activity.key === key);
        if (existing >= 0) this.history.splice(existing, 1);
      }
      this.latest = { text, detail, key, at: key === this.latest.key && text === this.latest.text ? this.latest.at : Date.now() };
    }
    this.schedule();
  }

  close(): Promise<void> {
    this.closed = true;
    if (this.pending) clearTimeout(this.pending);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.pending = undefined;
    this.heartbeat = undefined;
    return this.inFlight ?? Promise.resolve();
  }

  private schedule(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.inFlight) return;
    const remaining = config.progressUpdateMs - (Date.now() - this.lastEdit);
    if (remaining <= 0) void this.flush();
    else if (!this.pending) this.pending = setTimeout(() => void this.flush(), remaining);
  }

  private async flush(): Promise<void> {
    if (this.closed || this.inFlight) return;
    if (this.pending) clearTimeout(this.pending);
    this.pending = undefined;
    this.lastEdit = Date.now();
    this.dirty = false;
    this.inFlight = (async () => {
      try {
        const rows = this.questionComponents();
        // The stop row yields its slot to questions (Discord caps 5 rows); an
        // answered question's buttons must always be explicitly cleared.
        if (this.stopCustomId && rows.length < 5) {
          rows.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId(this.stopCustomId).setLabel("Stop").setStyle(ButtonStyle.Danger),
            ),
          );
        }
        const snapshot = this.snapshot();
        const options: MessageEditOptions = { ...(this.textOnly ? renderProgressText(snapshot) : renderProgressCard(snapshot)), components: rows };
        try { await this.message.edit(options); }
        catch (error) {
          if (this.textOnly || (error as { code?: number }).code !== 50013) throw error;
          this.textOnly = true;
          await this.message.edit({ ...renderProgressText(snapshot), components: rows });
        }
      } catch (error) {
        log("debug", "discord.progress_edit_failed", { messageId: this.message.id, error: String(error) });
      }
    })();
    try { await this.inFlight; }
    finally {
      this.inFlight = undefined;
      if (this.dirty && !this.closed) this.schedule();
    }
  }

  private snapshot(): ProgressSnapshot {
    const tools = [...this.tools.values()];
    const idleMs = Date.now() - this.lastActivityAt;
    // A failed tool and a provider retry both turn the card amber, so name the
    // cause: an alarm without a label tells the reader nothing.
    const latestToolFailed = this.latest.key ? this.tools.get(this.latest.key)?.status === "error" : false;
    const serviceWaiting = /retry|backoff|unavailable|reconnect|waiting for.*(?:agent|service)|hit an error/i.test(this.latest.text);
    return {
      title: this.title, phase: this.phase, startedAt: this.started, now: Date.now(), latest: this.latest,
      history: this.history, context: this.context, thought: this.thought, stats: this.stats, changes: this.changes,
      files: this.files, metrics: this.metrics && Date.now() - this.metricsAt > 5000 ? { ...this.metrics, liveTokensPerSecond: undefined } : this.metrics,
      plan: this.plan, queuedRequests: this.queuedRequests,
      actions: tools.length, activeTools: tools.filter((tool) => tool.status === "running").length,
      toolErrors: tools.filter((tool) => tool.status === "error").length, questionPin: this.questionPin,
      waiting: latestToolFailed || serviceWaiting,
      waitingReason: latestToolFailed
        ? "A tool reported an error — the agent is retrying"
        : serviceWaiting ? "Waiting on the agent service — it will retry automatically" : undefined,
      questions: this.question?.questions,
      stalledForMs: config.turnStallWarnMs > 0 && idleMs >= config.turnStallWarnMs ? idleMs : undefined,
    };
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
