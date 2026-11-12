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
/** Card-state key for one request form draft, keyed by its nonce. */
export function requestFormKey(nonce: string): string {
  return `request:${nonce}`;
}

/** Rollback guard for a finished turn's controls: the commit and settlement it belongs to. */
export function failureVersionOf(project: { lastCommit?: string; lastTurnAt?: string }): string {
  return `${project.lastCommit ?? ""}/${project.lastTurnAt ?? ""}`;
}

export interface StoredTurnCard {
  /** Set when failure controls were attached; rollback rechecks it against the live project. */
  failureVersion?: string;
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
