import type { SessionMessage } from "./opencode.js";

export const FORCE_FINISH_MARKER = "[THREADSITE_FORCE_FINISH]";

export function finishUpInstruction(steps: number, limit: number): string {
  return `${FORCE_FINISH_MARKER}\nMandatory steering for the CURRENT task: you have completed ${steps} of ${limit} model steps; approximately ${Math.max(0, limit - steps)} remain. Finish up now. Stop exploring, adding features, expanding scope, or starting new subsystems. Complete the edits already in progress and leave the requested experience coherent and playable. Prioritize fixing syntax/import/type errors and broken core interactions; run js_syntax_check and the required TypeScript check, update your todos accurately, then give your final summary. Defer optional polish and clearly mention any remaining limitations. Do not restart the task, replace working gameplay with a stub, or spend the remaining budget on browser retries. This steering does not grant a new step budget.`;
}

/** Root-session budget only: child-agent usage must not consume its parent's steps. */
export class TurnStepBudget {
  private readonly finished = new Set<string>();
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setInterval>;
  private sending?: Promise<void>;
  private refreshing = false;
  private sent = false;
  private retryAt = 0;
  readonly threshold: number;

  constructor(private readonly options: {
    limit: number;
    since: number;
    baseline?: ReadonlySet<string>;
    read: () => Promise<SessionMessage[]>;
    send: (steps: number, signal: AbortSignal) => Promise<boolean>;
    onError: (error: unknown) => void;
  }) {
    // Leave at least one step for very small custom budgets.
    this.threshold = Math.max(1, options.limit - Math.max(1, Math.ceil(options.limit * 0.1)));
    this.timer = setInterval(() => { void this.refresh(); }, 5_000);
    this.timer.unref();
  }

  observe(messageId: string): void {
    if (this.controller.signal.aborted) return;
    this.finished.add(messageId);
    this.check();
  }

  async refresh(): Promise<void> {
    if (this.controller.signal.aborted || this.refreshing || this.sent) return;
    this.refreshing = true;
    try {
      const messages = await this.options.read();
      if (this.controller.signal.aborted) return;
      for (const { info, parts } of messages) {
        if (!info?.id || this.options.baseline?.has(info.id)
          || (info.time?.created ?? 0) < this.options.since) continue;
        if (info.role === "user" && parts?.some((part) => part.type === "text" && String(part.text).startsWith(FORCE_FINISH_MARKER))) {
          this.sent = true; // Durable receipt, including bot restarts and missed SSE events.
        }
        if (info.role === "assistant" && (parts?.some((part) => part.type === "step-finish") || info.finish)) {
          this.finished.add(info.id);
        }
      }
      this.check();
    } catch (error) {
      if (!this.controller.signal.aborted) this.options.onError(error);
    } finally { this.refreshing = false; }
  }

  private check(): void {
    if (this.sent || this.sending || this.controller.signal.aborted
      || this.finished.size < this.threshold || Date.now() < this.retryAt) return;
    this.sending = (async () => {
      try {
        this.sent = await this.options.send(this.finished.size, this.controller.signal);
      } catch (error) {
        if (!this.controller.signal.aborted) this.options.onError(error);
      } finally {
        this.retryAt = Date.now() + 5_000;
        this.sending = undefined;
      }
    })();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.controller.abort();
    await this.sending;
  }
}
