import type { AgentQuestion } from "./progress.js";
import type { ProgressSnapshot } from "./progress-view.js";
import type { TurnCardState } from "./turn-card.js";

export type QuestionStatus = "ready" | "submitting" | "answered" | "skipped" | "retry";
export interface QuestionDelivery {
  requestID: string;
  status: QuestionStatus;
  operation?: "answer" | "skip";
  answers?: string[][];
  responder?: string;
  error?: string;
}
export interface StoredTurnCard {
  snapshot?: ProgressSnapshot;
  question?: AgentQuestion;
  delivery?: QuestionDelivery;
  result?: Omit<TurnCardState, "screenshot">;
  documents?: { description?: string; changelog?: string };
  closed?: boolean;
}
export interface QuestionDraft { requestID: string; answers: string[][]; custom?: number[] }
export interface RequestFormState {
  userId: string;
  resource: string;
  steer: boolean;
  /** Steer form only: stop the turn and restart it in the same card instead of steering mid-turn. */
  restart?: boolean;
  status: "ready" | "submitting" | "accepted";
  statusMessageId?: string;
  prompt?: string;
}
