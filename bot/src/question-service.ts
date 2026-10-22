import type { Store } from "./store.js";
import type { AgentQuestion, DiscordProgress } from "./progress.js";
import type { QuestionDelivery, QuestionDraft, StoredTurnCard } from "./card-state.js";
import { validateAnswers } from "./question-ui.js";

export interface QuestionServices {
  store: Store;
  progress(resource: string): DiscordProgress | undefined;
  pending(directory: string): Promise<Array<{ id: string }>>;
  answer(directory: string, requestID: string, answers: string[][]): Promise<void>;
  skip(directory: string, requestID: string): Promise<void>;
  error(error: unknown): void;
}

/** Owns complete answer batches, durable drafts and the ambiguous-delivery state. */
export class QuestionService {
  private readonly inFlight = new Set<string>();
  constructor(private readonly services: QuestionServices) {}

  context(threadId: string, resource: string, revision: string): AgentQuestion {
    const project = this.services.store.getProject(threadId);
    const card = this.services.store.getCardState<StoredTurnCard>(threadId, resource);
    if (!project || project.pendingDeletion || project.pendingTurn?.statusMessageId !== resource || card?.closed || card?.question?.resolved || card?.question?.requestID !== revision) {
      throw new Error("That question is no longer pending. Open the current turn to see its latest state.");
    }
    return card.question;
  }

  draft(threadId: string, resource: string, revision: string, userId: string): QuestionDraft {
    const request = this.context(threadId, resource, revision);
    return this.services.store.getCardState<QuestionDraft>(threadId, this.draftKey(resource, revision, userId))
      ?? { requestID: revision, answers: request.questions.map(() => []) };
  }

  saveDraft(threadId: string, resource: string, revision: string, userId: string, draft: QuestionDraft): QuestionDraft {
    this.context(threadId, resource, revision);
    if (draft.requestID !== revision) throw new Error("The question changed while you were answering.");
    return this.services.store.patchCardState<QuestionDraft>(threadId, this.draftKey(resource, revision, userId), draft);
  }

  delivery(threadId: string, resource: string, revision: string): QuestionDelivery {
    return this.services.store.getCardState<QuestionDelivery>(threadId, this.deliveryKey(resource, revision)) ?? { requestID: revision, status: "ready" };
  }

  async submit(threadId: string, resource: string, revision: string, responder: string, answers?: string[][]): Promise<QuestionDelivery> {
    const request = this.context(threadId, resource, revision);
    if (answers) validateAnswers(request, answers);
    const existing = this.delivery(threadId, resource, revision);
    if (existing.status === "answered" || existing.status === "skipped") return existing;
    if (existing.status === "submitting") return this.reconcile(threadId, resource, revision);
    const delivery: QuestionDelivery = { requestID: revision, status: "submitting", operation: answers ? "answer" : "skip", answers, responder };
    const key = this.deliveryKey(resource, revision);
    if (!this.services.store.claimCardAction(threadId, key, delivery)) return this.delivery(threadId, resource, revision);
    this.update(threadId, resource, delivery);
    this.inFlight.add(key);
    try {
      const directory = this.services.store.getProject(threadId)!.workspacePath;
      if (answers) await this.services.answer(directory, revision, answers);
      else await this.services.skip(directory, revision);
      return this.finish(threadId, resource, delivery);
    } catch (error) {
      this.services.error(error);
      this.inFlight.delete(key);
      // A rejected transport can have accepted the answer. Confirm it is still
      // pending before offering a retry; never clear unanswered questions here.
      return this.reconcile(threadId, resource, revision);
    } finally { this.inFlight.delete(key); }
  }

  async reconcile(threadId: string, resource: string, revision: string): Promise<QuestionDelivery> {
    const delivery = this.delivery(threadId, resource, revision);
    if (delivery.status !== "submitting" || this.inFlight.has(this.deliveryKey(resource, revision))) return delivery;
    const project = this.services.store.getProject(threadId);
    if (!project || project.pendingDeletion) return delivery;
    try {
      const pending = await this.services.pending(project.workspacePath);
      if (!pending.some((request) => request.id === revision)) return this.finish(threadId, resource, delivery);
      return this.update(threadId, resource, { ...delivery, status: "retry", error: "The agent is still waiting. Your answers are saved; submit again to retry." });
    } catch (error) {
      this.services.error(error);
      return this.update(threadId, resource, { ...delivery, error: "Checking whether the agent received your answer. Your draft is saved; check delivery again shortly." });
    }
  }

  private finish(threadId: string, resource: string, delivery: QuestionDelivery): QuestionDelivery {
    const result: QuestionDelivery = { ...delivery, status: delivery.operation === "answer" ? "answered" : "skipped", error: undefined };
    this.update(threadId, resource, result);
    const progress = this.services.progress(resource);
    if (progress) {
      if (delivery.operation === "answer") progress.recordAnswer(delivery.requestID, delivery.responder ?? "A contributor", (delivery.answers ?? []).map((answer) => answer.join(", ")).join(" · "));
      else progress.recordSkip(delivery.requestID, delivery.responder ?? "A contributor");
      progress.clearQuestion(delivery.requestID);
    }
    return result;
  }

  private update(threadId: string, resource: string, delivery: QuestionDelivery): QuestionDelivery {
    this.services.store.patchCardState(threadId, this.deliveryKey(resource, delivery.requestID), delivery);
    const card = this.services.store.getCardState<StoredTurnCard>(threadId, resource);
    if (card?.question?.requestID === delivery.requestID) {
      this.services.store.patchCardState<StoredTurnCard>(threadId, resource, { delivery });
      this.services.progress(resource)?.setQuestionStatus({ status: delivery.status, error: delivery.error });
    }
    return delivery;
  }

  private draftKey(resource: string, revision: string, userId: string): string { return `draft:${resource}:${revision}:${userId}`; }
  private deliveryKey(resource: string, revision: string): string { return `question:${resource}:${revision}`; }
}
