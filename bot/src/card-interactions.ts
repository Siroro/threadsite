import { randomBytes } from "node:crypto";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, PermissionFlagsBits, TextDisplayBuilder,
  type AnySelectMenuInteraction, type Attachment, type ButtonInteraction, type ModalSubmitInteraction,
} from "discord.js";
import { cardId, parseCardId, type CardAction, type CardRoute } from "./card-actions.js";
import { addCardHeader, cardEdit, cardMessage, renderStatusCard, type CardMessage } from "./card-ui.js";
import { renderDetailPanel, renderQueuePanel, requestModal, wipeModal, type PanelSection, type PanelScope } from "./card-panels.js";
import type { RequestFormState, StoredTurnCard } from "./card-state.js";
import { elapsed, hasUsageData, modelUsageLines, sessionUsageLines, progressDetailSections, subagentDetailText, subagentHistory, usageDetailText, type ProgressSnapshot } from "./progress-view.js";
import { formatCost } from "./util.js";
import { answerModal, customAnswerModal, readAnswerForm, renderQuestionReview } from "./question-ui.js";
import type { QuestionService } from "./question-service.js";
import type { Store } from "./store.js";
import type { ProjectRecord, QueuedRequest } from "./types.js";
import { authorizeCard, CollaborationError, interactionActor, requireWipeAccess, type ProjectActor } from "./collaboration.js";
import type { CollaborationService } from "./collaboration-service.js";

export type CardInteraction = ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction;
export interface CardInteractionServices {
  store: Store;
  questions: QuestionService;
  /** The freshest snapshot for a still-running turn, straight from memory. */
  liveSnapshot?(resource: string): ProgressSnapshot | undefined;
  projectSections(project: ProjectRecord): Promise<PanelSection[]>;
  queue(threadId: string): { requests: QueuedRequest[]; preparing: number };
  cancel(threadId: string, statusId: string): Promise<string>;
  submit(interaction: ModalSubmitInteraction, project: ProjectRecord, form: RequestFormState, nonce: string, prompt: string, attachments: Attachment[]): Promise<string>;
  stop(threadId: string, statusMessageId: string): Promise<string>;
  /** Clear the game's shared relay state; resolves to the reply text. */
  wipe(threadId: string, userId: string, scope: { world: boolean; scores: boolean }): Promise<string>;
  rollback(threadId: string, expectedVersion: string, actor: ProjectActor): Promise<void>;
  busy(threadId: string): Promise<boolean>;
  error(error: unknown, interaction: CardInteraction): void;
  collaboration?: CollaborationService;
  adminUser?(userId: string): boolean;
}

/** Global routing survives restarts. Private views never edit the shared live card. */
export class CardInteractions {
  constructor(private readonly services: CardInteractionServices) {}

  async handle(interaction: CardInteraction, customId = interaction.customId): Promise<boolean> {
    if (!customId.startsWith("ts2:")) return false;
    try {
      const route = parseCardId(customId);
      if (!route) throw new Error("This control is no longer supported. Use the latest project card.");
      const project = this.project(interaction);
      this.checkResource(project, route);
      const actor = interactionActor(interaction, this.services.adminUser?.(interaction.user.id));
      authorizeCard(project, actor, route.action);
      if (["collaboration", "collabmode", "collabusers", "collabwipe", "approve", "reject", "reviewrequest"].includes(route.action)) {
        if (!this.services.collaboration) throw new CardUserError("Collaboration settings are unavailable.");
        await this.services.collaboration.handle(interaction, project, actor, route);
        return true;
      }
      const viewing = ["details", "tab", "page", "project", "queue", "doc", "review", "retry"].includes(route.action);
      if (!viewing && !interaction.memberPermissions?.has(PermissionFlagsBits.SendMessagesInThreads)) throw new Error("You need permission to send messages in this thread to use that action.");
      await this.dispatch(interaction, project, route);
    } catch (error) {
      this.services.error(error, interaction);
      // Service details remain in private logs. Domain errors below contain
      // only public wording; transport errors get a useful generic response.
      const message = error instanceof CardUserError || error instanceof CollaborationError ? error.message : publicMessage(error);
      await this.respond(interaction, renderStatusCard(`⚠️ ${message}`)).catch(() => undefined);
    }
    return true;
  }

  private project(interaction: CardInteraction): ProjectRecord {
    const project = interaction.channelId ? this.services.store.getProject(interaction.channelId) : undefined;
    if (!interaction.inGuild() || !interaction.channel?.isThread() || !project || project.pendingDeletion || project.guildId !== interaction.guildId) throw new CardUserError("This project is no longer available in this thread.");
    return project;
  }

  private checkResource(project: ProjectRecord, route: CardRoute): void {
    if (route.resource !== project.threadId && !this.services.store.getCardState<StoredTurnCard>(project.threadId, route.resource)) throw new CardUserError("That card is no longer available. Open the current project card.");
  }

  private async dispatch(interaction: CardInteraction, project: ProjectRecord, route: CardRoute): Promise<void> {
    const { action, resource, args } = route;
    const threadId = project.threadId;
    if (action === "details" || action === "project" || action === "doc" || action === "tab" || action === "page") {
      await this.begin(interaction, route.action);
      const scope: PanelScope = action === "project" ? "project" : action === "doc" ? "doc" : action === "tab" || action === "page" ? parseScope(args[0]) : "turn";
      const selected = action === "tab" && interaction.isStringSelectMenu() ? interaction.values[0] : action === "page" ? args[1] : args[0];
      const page = action === "page" ? indexArg(args[2]) : 0;
      // Spend figures ride only the viewer's own ephemeral panel, never the
      // shared card: gate them on the admin check at render time.
      const admin = Boolean(this.services.adminUser?.(interaction.user.id));
      const sections = scope === "project" ? await this.services.projectSections(project) : this.turnSections(threadId, resource, scope, admin);
      await this.respond(interaction, renderDetailPanel(scope === "project" ? project.displayName : "Turn details", resource, scope, sections, selected, page));
      return;
    }
    if (action === "queue" || action === "cancel") {
      await this.begin(interaction, route.action);
      let note: string | undefined;
      if (action === "cancel") {
        if (!/^\d{5,25}$/.test(args[0] ?? "")) throw new CardUserError("That queue entry is invalid.");
        note = await this.services.cancel(threadId, args[0]);
      }
      const queue = this.services.queue(threadId);
      const panel = renderQueuePanel(resource, queue.requests, queue.preparing, action === "queue" ? indexArg(args[0]) : 0);
      if (note) panel.components[0].addTextDisplayComponents(new TextDisplayBuilder().setContent(note));
      await this.respond(interaction, panel);
      return;
    }
    if (action === "change" || action === "steer") {
      if (!interaction.isButton()) throw new CardUserError("Open the request form from a button.");
      if (action === "steer" && project.pendingTurn?.statusMessageId !== resource) throw new CardUserError("That turn has finished. Use Request a change to queue a follow-up.");
      const nonce = randomBytes(8).toString("hex");
      this.services.store.patchCardState<RequestFormState>(threadId, `request:${nonce}`, { userId: interaction.user.id, resource, steer: action === "steer", status: "ready" });
      await interaction.showModal(requestModal(resource, nonce, action === "steer"));
      return;
    }
    if (action === "request") {
      if (!interaction.isModalSubmit()) throw new CardUserError("Submit the request form to continue.");
      const nonce = args[0];
      const form = this.services.store.getCardState<RequestFormState>(threadId, `request:${nonce}`);
      if (!form || form.userId !== interaction.user.id || form.resource !== resource) throw new CardUserError("That request form has expired. Open a new form from the project card.");
      await this.begin(interaction, route.action);
      if (form.status !== "ready") { await this.respond(interaction, renderStatusCard(form.status === "accepted" ? "✅ This request was already saved." : "⏳ This request is already being submitted.")); return; }
      const prompt = interaction.fields.getTextInputValue("prompt").trim();
      const attachments = [...(interaction.fields.getUploadedFiles("images")?.values() ?? [])];
      if (!prompt) throw new CardUserError("Describe the change you want before submitting.");
      // Modals opened before this checkbox existed still submit without it;
      // a missing component is simply an unchecked box.
      const claimed: RequestFormState = { ...form, prompt, restart: form.steer && (modalCheckbox(interaction, "restart") ?? false), status: "submitting" };
      if (!this.services.store.claimCardAction(threadId, `request:${nonce}`, claimed)) {
        await this.respond(interaction, renderStatusCard("⏳ This request is already being submitted."));
        return;
      }
      try {
        const text = await this.services.submit(interaction, project, claimed, nonce, prompt, attachments);
        this.services.store.patchCardState<RequestFormState>(threadId, `request:${nonce}`, { status: "accepted" });
        await this.respond(interaction, renderStatusCard(text));
      } catch (error) {
        // Once a public status exists, submission may have reached the durable
        // queue. Reconcile it instead of making the same form submit twice.
        const saved = this.services.store.getCardState<RequestFormState>(threadId, `request:${nonce}`);
        if (!saved?.statusMessageId) this.services.store.patchCardState<RequestFormState>(threadId, `request:${nonce}`, { status: "ready" });
        throw error;
      }
      return;
    }
    if (action === "stop") {
      if (project.pendingTurn?.statusMessageId !== resource) throw new CardUserError("That turn is no longer running. This control cannot stop a later turn.");
      await this.begin(interaction, route.action);
      await this.respond(interaction, renderStatusCard(await this.services.stop(threadId, resource)));
      return;
    }
    if (action === "rollback" || action === "keep" || action === "confirm") {
      const version = this.checkFailure(project, resource);
      await this.begin(interaction, route.action);
      if (action === "keep") { await this.respond(interaction, renderStatusCard("🗂️ Keeping the partial edits. The next message will build on them.")); return; }
      if (action === "rollback") {
        const card = new ContainerBuilder().setAccentColor(0xef4444);
        addCardHeader(card, "CONFIRM", "Discard partial edits?", "This restores the workspace to the last published commit. The partial edits will be discarded.");
        card.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(cardId("confirm", resource, "rollback")).setLabel("Discard partial edits").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(cardId("keep", resource)).setLabel("Keep edits").setStyle(ButtonStyle.Secondary),
        ));
        await this.respond(interaction, cardMessage(card));
        return;
      }
      if (args[0] !== "rollback") throw new CardUserError("That confirmation is not supported.");
      if (await this.services.busy(threadId)) throw new CardUserError("The agent is working. Wait until it has stopped before discarding edits.");
      // The enqueued rollback re-checks this version again once it is the
      // closure's turn to run: a turn accepted between the click and the queue
      // position must never have its work discarded.
      if (!this.services.store.claimCardAction(threadId, `rollback:${resource}`, { status: "submitting" })) throw new CardUserError("This rollback was already requested.");
      try {
        await this.services.rollback(threadId, version, interactionActor(interaction, this.services.adminUser?.(interaction.user.id)));
        this.services.store.patchCardState(threadId, `rollback:${resource}`, { status: "accepted" });
      } catch (error) {
        this.services.store.patchCardState(threadId, `rollback:${resource}`, { status: "retry" });
        throw error;
      }
      await this.respond(interaction, renderStatusCard("↩️ Restored the last published commit. The partial edits were discarded."));
      return;
    }
    if (action === "wipe") {
      if (!project.projectKind || project.projectKind === "site") throw new CardUserError("Only games keep state on the multiplayer relay.");
      if (interaction.isModalSubmit()) {
        await this.begin(interaction, route.action);
        // The form may sit open for a while: recheck the project, its kind and
        // the wipe policy against current settings before anything is deleted.
        const fresh = this.services.store.getProject(threadId);
        if (!fresh) throw new CardUserError("This project is no longer available.");
        if (!fresh.projectKind || fresh.projectKind === "site") throw new CardUserError("Only games keep state on the multiplayer relay.");
        requireWipeAccess(fresh, interactionActor(interaction, this.services.adminUser?.(interaction.user.id)));
        const singleplayer = (fresh.multiplayerMode ?? "arena") === "singleplayer";
        // Modals ship with both boxes; a missing component reads as checked.
        const world = singleplayer ? false : (modalCheckbox(interaction, "world") ?? true);
        const scores = modalCheckbox(interaction, "scores") ?? true;
        if (!world && !scores) throw new CardUserError("Choose at least one thing to clear.");
        await this.respond(interaction, renderStatusCard(await this.services.wipe(threadId, interaction.user.id, { world, scores })));
        return;
      }
      if (!interaction.isButton()) throw new CardUserError("Open the wipe form from the project card.");
      // The modal doubles as the confirmation: submitting is the deliberate act.
      await interaction.showModal(wipeModal(resource, (project.multiplayerMode ?? "arena") === "singleplayer"));
      return;
    }
    await this.question(interaction, project, route);
  }

  private async question(interaction: CardInteraction, project: ProjectRecord, route: CardRoute): Promise<void> {
    const { action, resource, args } = route;
    const revision = args[0];
    if (!revision) throw new CardUserError("The question identifier is missing.");
    const service = this.services.questions;
    const request = service.context(project.threadId, resource, revision);
    const userId = interaction.user.id;
    const draft = service.draft(project.threadId, resource, revision, userId);
    const index = indexArg(args[1]);
    if (action === "questions" || action === "other") {
      if (!interaction.isButton()) throw new CardUserError("Open the answer form from a button.");
      if (index >= (action === "questions" ? Math.ceil(request.questions.length / 5) : request.questions.length)) throw new CardUserError("That question page is no longer available.");
      await interaction.showModal(action === "questions" ? answerModal(resource, request, draft, index) : customAnswerModal(resource, request, index, draft));
      return;
    }
    await this.begin(interaction, route.action);
    if (action === "answer") {
      if (request.questions.length !== 1 || request.questions[0].multiple || !request.questions[0].options[index]) throw new CardUserError("Open Answer questions to answer this request completely.");
      draft.answers = [[request.questions[0].options[index].label]];
      service.saveDraft(project.threadId, resource, revision, userId, draft);
    } else if (action === "select") {
      if (!interaction.isStringSelectMenu() || !request.questions[index]) throw new CardUserError("That answer selection is invalid.");
      draft.answers[index] = interaction.values.map((value) => {
        if (!/^\d+$/.test(value) || !request.questions[index].options[Number(value)]) throw new CardUserError("That answer option is no longer available.");
        return request.questions[index].options[Number(value)].label;
      });
      draft.custom = draft.custom?.filter((entry) => entry !== index);
      service.saveDraft(project.threadId, resource, revision, userId, draft);
    } else if (action === "form") {
      if (!interaction.isModalSubmit()) throw new CardUserError("Submit the answer form to continue.");
      const values = readAnswerForm(interaction, request, index);
      for (const [questionIndex, answers] of values.answers) draft.answers[questionIndex] = answers;
      draft.custom = [...(draft.custom ?? []).filter((entry) => !values.answers.has(entry)), ...values.custom];
      service.saveDraft(project.threadId, resource, revision, userId, draft);
    } else if (action === "custom") {
      if (!interaction.isModalSubmit() || !request.questions[index]) throw new CardUserError("That question is no longer available.");
      const text = interaction.fields.getTextInputValue("answer").trim();
      if (!text) throw new CardUserError("Write an answer before submitting.");
      draft.answers[index] = request.questions[index].multiple ? text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [text];
      draft.custom = draft.custom?.filter((entry) => entry !== index);
      service.saveDraft(project.threadId, resource, revision, userId, draft);
    } else if (!["send", "skip", "review", "retry"].includes(action)) throw new CardUserError("That card action is no longer supported.");
    const complete = draft.answers.length === request.questions.length && draft.answers.every((answer) => answer?.length) && !draft.custom?.length;
    if (action === "skip" || action === "answer" || action === "send" || ((action === "form" || action === "custom") && complete)) {
      if (action !== "skip" && !complete) throw new CardUserError("Answer every question before submitting. Your draft is saved.");
      const delivery = await service.submit(project.threadId, resource, revision, interaction.user.globalName ?? interaction.user.username, action === "skip" ? undefined : draft.answers);
      if (delivery.status === "answered" || delivery.status === "skipped") {
        // A delivered answer is a contribution; skipping leaves the decision to
        // the agent and is not one. The tally is advisory: never fail the reply.
        if (delivery.status === "answered") {
          await this.services.store.addContribution(project.threadId, interaction.user.id, "answers").catch(() => undefined);
        }
        await this.respond(interaction, renderStatusCard(delivery.status === "answered" ? "✅ All answers were delivered to the agent." : "⏭️ Skipped; the agent will decide."));
        return;
      }
    }
    if (action === "retry") {
      const delivery = await service.reconcile(project.threadId, resource, revision);
      if (delivery.status === "answered" || delivery.status === "skipped") { await this.respond(interaction, renderStatusCard("✅ Answer delivery confirmed.")); return; }
    }
    const next = action === "form" ? draft.answers.findIndex((answer, i) => !answer?.length || draft.custom?.includes(i)) : index;
    await this.respond(interaction, renderQuestionReview(resource, request, draft, next < 0 ? 0 : next, service.delivery(project.threadId, resource, revision)));
  }

  private turnSections(threadId: string, resource: string, scope: PanelScope, admin = false): PanelSection[] {
    const card = this.services.store.getCardState<StoredTurnCard>(threadId, resource);
    // A running turn reads from memory: the persisted snapshot only reaches
    // disk on the few-seconds flush cadence, and Refresh should show now.
    const snapshot = this.services.liveSnapshot?.(resource) ?? card?.snapshot;
    if (!card && !snapshot) throw new CardUserError("No saved details are available for this older turn.");
    return turnPanelSections(card, snapshot, scope, admin);
  }

  private checkFailure(project: ProjectRecord, resource: string): string {
    const card = this.services.store.getCardState<StoredTurnCard & { failureVersion?: string }>(project.threadId, resource);
    if (project.pendingTurn || !card?.failureVersion || card.failureVersion !== `${project.lastCommit ?? ""}/${project.lastTurnAt ?? ""}`) throw new CardUserError("This outcome belongs to an older turn. Use the latest turn's controls.");
    return card.failureVersion;
  }

  private async begin(interaction: CardInteraction, action: CardAction): Promise<void> {
    if (!interaction.deferred && !interaction.replied) {
      if (interaction.message?.flags.has(MessageFlags.Ephemeral)) await interaction.deferUpdate();
      else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    authorizeCard(this.project(interaction), interactionActor(interaction, this.services.adminUser?.(interaction.user.id)), action);
  }

  private async respond(interaction: CardInteraction, message: CardMessage): Promise<void> {
    if (interaction.deferred || interaction.replied) await interaction.editReply(cardEdit(message));
    else await interaction.reply({ ...message, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
  }
}

/**
 * The pages behind a turn's details dropdown. Only sections with real content
 * are offered: an empty plan, absent findings or an unwritten changelog must
 * not become a dead entry in the select menu. Lifetime spend rides the pinned
 * project card; this panel's figures — per-turn spend, provider routing,
 * per-session splits — appear only when the viewer is a site admin.
 */
export function turnPanelSections(card: StoredTurnCard | undefined, snapshot: ProgressSnapshot | undefined, scope: PanelScope, admin = false): PanelSection[] {
  const sections = snapshot ? progressDetailSections(snapshot) : [];
  const result = card?.result;
  if (result) {
    const links = [
      result.siteUrl ? `[Live site](${result.siteUrl})` : "",
      result.repoUrl ? `[Source](${result.repoUrl})` : "",
      result.commit && result.repoUrl ? `[View commit](${result.repoUrl.replace(/\/$/, "")}/commit/${encodeURIComponent(result.commit)})` : "",
    ].filter(Boolean).join(" · ");
    const description = card?.documents?.description?.trim()
      || [result.description?.pitch, result.description?.play].filter(Boolean).join("\n\n");
    const changelog = card?.documents?.changelog?.trim()
      || [result.changelog?.title, result.changelog?.body].filter(Boolean).join("\n\n");
    const finished = [
      result.summary?.trim() ? { key: "report", label: "Full agent report", text: result.summary } : undefined,
      result.findings?.length ? { key: "qa", label: "Browser findings", text: `Advisory; publication is not blocked.\n\n${result.findings.join("\n\n")}` } : undefined,
      description ? { key: "description", label: "About & how to play", text: description } : undefined,
      changelog ? { key: "changelog", label: "Changelog", text: changelog } : undefined,
      { key: "outcome", label: "Outcome & commit", text: [
        result.published ? "**✅ Published**" : result.commit ? "**⚠️ Committed, not published**" : "**❌ Not published**",
        result.commit ? `Commit \`${result.commit}\`` : "No commit recorded",
        `${result.commitFiles} files · **+${result.additions} / −${result.deletions}** lines · ${elapsed(result.durationMs)}`,
        result.note,
        links,
      ].filter(Boolean).join("\n") },
    ].filter((entry): entry is PanelSection => Boolean(entry));
    sections.unshift(...finished);
  }
  if (result?.usage && hasUsageData(result.usage)) {
    const live = sections.find((entry) => entry.key === "usage")?.text;
    const models = modelUsageLines(result.usage.models, admin);
    // The split only earns its block when a subagent actually spent; a lone
    // root session is already what the totals say.
    const children = result.usage.sessions?.filter((entry) => !entry.root && (entry.inputTokens || entry.outputTokens)) ?? [];
    const split = children.length && result.usage.sessions
      ? `**Root & subagents**\n${sessionUsageLines(result.usage.sessions.filter((entry) => entry.root || entry.inputTokens || entry.outputTokens), admin)}`
      : "";
    const spend = admin
      ? result.usage.cost > 0
        ? `**Cost**\nTurn spend **${formatCost(result.usage.cost)}**${result.usage.catalogCost ? ` · **${formatCost(result.usage.catalogCost)}** at catalog rates` : ""}`
        : `**Cost**\n$0; the provider's pricing is not reported for these models`
      : "";
    const finalUsage: PanelSection = { key: "usage", label: "Usage & context", text: [
      `**Final provider counts**\n${usageDetailText(result.usage)}`,
      models ? `**By model**\n${models}` : "",
      split,
      spend,
      live ? `**Last live reading**\n${live}` : "",
    ].filter(Boolean).join("\n\n") };
    const position = sections.findIndex((entry) => entry.key === "usage");
    if (position >= 0) sections[position] = finalUsage;
    else sections.push(finalUsage);
  }
  const subagents = snapshot ? subagentHistory(snapshot) : result?.subagents ?? [];
  if (subagents.length && !sections.some((entry) => entry.key === "subagents")) {
    sections.push({ key: "subagents", label: "Subagents", text: subagentDetailText(subagents, snapshot?.now) });
  }
  const scoped = scope === "doc" ? sections.filter((entry) => entry.key === "description" || entry.key === "changelog") : sections;
  if (scoped.length) return scoped;
  return [scope === "doc"
    ? { key: "description", label: "About & how to play", text: "The agent has not written a description or changelog for this project yet." }
    : { key: "overview", label: "Overview", text: "No further information was recorded for this turn." }];
}

export class CardUserError extends Error {}
/** A modal checkbox's value, or undefined when the submitted form predates that component. */
function modalCheckbox(interaction: ModalSubmitInteraction, customId: string): boolean | undefined {
  try { return interaction.fields.getCheckbox(customId); } catch { return undefined; }
}
function indexArg(value?: string): number {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new CardUserError("That page is invalid.");
  return Number(value);
}
function parseScope(value?: string): PanelScope {
  if (value !== "turn" && value !== "project" && value !== "doc") throw new CardUserError("That details view is unavailable.");
  return value;
}
function publicMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  // These errors originate in our local validation and contain no service diagnostics.
  if (/^(That question|The question|Answer every|Question \d|An answer|Write an answer|This project)/.test(message)) return message;
  return "The action could not be completed. Your saved work and drafts are kept; try again shortly.";
}
