import fs from "node:fs/promises";
import path from "node:path";
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags,
  StringSelectMenuBuilder, UserSelectMenuBuilder, TextDisplayBuilder, type Attachment,
} from "discord.js";
import { cardId, type CardRoute } from "./card-actions.js";
import { addCardField, addCardHeader, addCardLinks, cardEdit, cardMessage, type CardMessage } from "./card-ui.js";
import { contributionAccess, CollaborationError, managesProject, ownerId, requireManager, type ProjectActor } from "./collaboration.js";
import type { CardInteraction } from "./card-interactions.js";
import type { Store } from "./store.js";
import type { ApprovalAttachment, CollaborationMode, CommitAuthor, ProjectApproval, ProjectRecord, QueuedRequest, WipePolicy } from "./types.js";
import { safeChild, truncate } from "./util.js";
import { UPLOAD_DIR, uploadFileName, type UploadedFile } from "./uploads.js";

export const COLLABORATION_LABELS = { open: "Anyone can edit", contributors: "Selected contributors", approval: "Owner approves requests" } as const;
export const WIPE_POLICY_LABELS = { owner: "Owner & admins", anyone: "Anyone in the thread" } as const;
const MAX_APPROVAL_BYTES = 8 * 1024 * 1024;
const PAGE_SIZE = 5;

/** Capture expiring Discord URLs into private SQLite state, never into an unapproved workspace. */
export async function captureApprovalAttachments(attachments: Attachment[]): Promise<ApprovalAttachment[]> {
  if (attachments.length > 4 || attachments.reduce((sum, attachment) => sum + attachment.size, 0) > MAX_APPROVAL_BYTES) {
    throw new CollaborationError("Approval requests accept up to 4 attachments totalling 8 MiB.");
  }
  const saved: ApprovalAttachment[] = [];
  let total = 0;
  for (const attachment of attachments) {
    try {
      const response = await fetch(attachment.url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok || !response.body) throw new Error("download failed");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > MAX_APPROVAL_BYTES) throw new Error("too large");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const mime = attachment.contentType ?? "application/octet-stream";
      saved.push({ name: uploadFileName(attachment.name), mime, dataUrl: `data:${mime};base64,${Buffer.concat(chunks).toString("base64")}` });
    } catch { throw new CollaborationError("An attachment could not be saved for approval. No request was accepted; attach the files again."); }
  }
  return saved;
}

/** Stable filenames make an approval retriable after a crash before queue admission. */
export async function installApprovedUploads(workspace: string, request: ProjectApproval): Promise<UploadedFile[]> {
  const files: UploadedFile[] = [];
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(request.id)) throw new Error("Invalid approval identifier.");
  for (const [index, attachment] of request.attachments.entries()) {
    if (attachment.mime.startsWith("image/")) continue;
    const bytes = Buffer.from(attachment.dataUrl.slice(attachment.dataUrl.indexOf(",") + 1), "base64");
    const name = `approval-${request.id}-${index}-${uploadFileName(attachment.name)}`;
    const dir = safeChild(workspace, UPLOAD_DIR);
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, name);
    try { await fs.writeFile(target, bytes, { flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await fs.readFile(target)).equals(bytes)) throw error;
    }
    files.push({ name, path: `${UPLOAD_DIR}/${name}`, bytes: bytes.length, mime: attachment.mime });
  }
  return files;
}

interface Services {
  store: Store;
  serialize<T>(threadId: string, work: () => Promise<T>): Promise<T>;
  prepare(project: ProjectRecord, request: ProjectApproval): Promise<{ request: QueuedRequest; accepted(): Promise<void> }>;
  rejected(threadId: string, requestId: string): Promise<void>;
  changed(threadId: string): void;
}

export class CollaborationService {
  constructor(private readonly services: Services) {}

  async request(threadId: string, actor: ProjectActor, id: string, prompt: string, author: CommitAuthor, attachments: Attachment[]): Promise<void> {
    if (!prompt.trim() || prompt.length > 6000) throw new CollaborationError("Describe the requested change in 1–6000 characters.");
    this.allowRequest(threadId, actor);
    const captured = await captureApprovalAttachments(attachments);
    this.allowRequest(threadId, actor); // Settings may have changed while downloading.
    this.services.store.addApproval(threadId, { id, requesterId: actor.userId, author, prompt, attachments: captured, attachmentCount: captured.length, createdAt: new Date().toISOString() });
    this.services.changed(threadId);
  }

  private allowRequest(threadId: string, actor: ProjectActor): void {
    const project = this.services.store.getProject(threadId);
    if (!project || contributionAccess(project, actor) === "denied") throw new CollaborationError("The thread owner has restricted contributions to selected people.");
  }

  update(threadId: string, actor: ProjectActor, revision: number, patch: { mode?: CollaborationMode; userIds?: string[]; wipePolicy?: WipePolicy }): void {
    const project = this.services.store.getProject(threadId);
    if (!project) throw new CollaborationError("This project is no longer available.");
    requireManager(project, actor);
    const current = project.collaboration ?? { mode: "open", userIds: [], revision: 0 };
    const mode = patch.mode ?? current.mode;
    const userIds = [...new Set(patch.userIds ?? current.userIds)];
    const wipePolicy = patch.wipePolicy ?? current.wipePolicy;
    if (!Object.hasOwn(COLLABORATION_LABELS, mode) || userIds.length > 25 || userIds.some((id) => !/^\d{5,25}$/.test(id))
      || (wipePolicy !== undefined && !WIPE_POLICY_LABELS[wipePolicy])) {
      throw new CollaborationError("Select up to 25 Discord contributors and a supported editing mode.");
    }
    try { this.services.store.setCollaboration(threadId, { mode, userIds, revision: current.revision + 1, ...(wipePolicy ? { wipePolicy } : {}) }, revision, ownerId(project, actor)); }
    catch (error) { throw new CollaborationError((error as Error).message); }
    this.services.changed(threadId);
  }

  async decide(threadId: string, actor: ProjectActor, id: string, approve: boolean): Promise<boolean> {
    return this.services.serialize(threadId, async () => {
      const project = this.services.store.getProject(threadId);
      if (!project) throw new CollaborationError("This project is no longer available.");
      requireManager(project, actor); // Recheck when queued work actually begins.
      const request = this.services.store.getApproval(threadId, id);
      if (!request) return false;
      if (approve) {
        const prepared = await this.services.prepare(project, request);
        const fresh = this.services.store.getProject(threadId);
        if (!fresh) throw new CollaborationError("This project is no longer available.");
        requireManager(fresh, actor);
        if (!this.services.store.approveRequest(threadId, id, prepared.request)) return false;
        await prepared.accepted();
      } else {
        this.services.store.rejectApproval(threadId, id);
        await this.services.rejected(threadId, id);
      }
      this.services.changed(threadId);
      return true;
    });
  }

  panel(project: ProjectRecord, actor: ProjectActor, page = 0): CardMessage {
    const manager = managesProject(project, actor);
    const settings = project.collaboration ?? { mode: "open", userIds: [], revision: 0 };
    const isGame = Boolean(project.projectKind && project.projectKind !== "site");
    const card = new ContainerBuilder().setAccentColor(0x5865f2);
    addCardHeader(card, "COLLABORATION", project.displayName, COLLABORATION_LABELS[settings.mode]);
    addCardField(card, "Who can contribute", [
      ownerId(project, actor) ? `Owner: <@${ownerId(project, actor)}>` : "Owner not recorded; a server administrator can manage this project.",
      settings.userIds.length ? `Selected contributors: ${settings.userIds.map((id) => `<@${id}>`).join(", ")}` : "No selected contributors.",
      "The owner and server administrators can always manage the project. In approval mode, selected contributors edit directly and other requests wait for review.",
      ...(isGame ? [`Relay state reset (arena world & scores): ${WIPE_POLICY_LABELS[settings.wipePolicy ?? "owner"]} — the owner and server administrators always.`] : []),
    ].join("\n"));
    if (manager && actor.canSend) {
      card.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
        .setCustomId(cardId("collabmode", project.threadId, settings.revision)).setPlaceholder("Editing mode")
        .addOptions(Object.entries(COLLABORATION_LABELS).map(([value, label]) => ({ label, value, default: value === settings.mode })))));
      card.addActionRowComponents(new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(new UserSelectMenuBuilder()
        .setCustomId(cardId("collabusers", project.threadId, settings.revision)).setPlaceholder("Choose contributors")
        .setMinValues(0).setMaxValues(25).setDefaultUsers(settings.userIds)));
      if (isGame) card.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
        .setCustomId(cardId("collabwipe", project.threadId, settings.revision)).setPlaceholder("Who can reset relay state")
        .addOptions(Object.entries(WIPE_POLICY_LABELS).map(([value, label]) => ({ label, value, default: value === (settings.wipePolicy ?? "owner") })))));
      const pending = this.services.store.listApprovals(project.threadId);
      const last = Math.max(0, Math.ceil(pending.length / PAGE_SIZE) - 1);
      page = Math.max(0, Math.min(page, last));
      for (const request of pending.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
        addCardField(card, `Request from <@${request.requesterId}>`, `${truncate(request.prompt, 260)}${request.attachmentCount ? `\n${request.attachmentCount} attachment(s)` : ""}`);
        addCardLinks(card, decisionButtons(project.threadId, request.id));
      }
      card.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${pending.length} pending approval(s) · page ${page + 1}/${last + 1}`));
      addCardLinks(card, [
        new ButtonBuilder().setCustomId(cardId("collaboration", project.threadId, Math.max(0, page - 1))).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(cardId("collaboration", project.threadId, page, "refresh")).setLabel("Refresh").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(cardId("collaboration", project.threadId, Math.min(last, page + 1), "next")).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(page === last),
      ]);
    }
    return cardMessage(card);
  }

  async handle(interaction: CardInteraction, project: ProjectRecord, actor: ProjectActor, route: CardRoute): Promise<void> {
    if (["collabmode", "collabusers", "collabwipe", "approve", "reject", "reviewrequest"].includes(route.action)) requireManager(project, actor);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (route.action === "reviewrequest") {
      const request = this.services.store.getApproval(project.threadId, route.args[0] ?? "");
      if (!request) throw new CollaborationError("That request was already handled.");
      const card = new ContainerBuilder().setAccentColor(0xf59e0b);
      addCardHeader(card, "REVIEW REQUEST", project.displayName, `Requested by <@${request.requesterId}>`);
      addCardField(card, "Requested change", truncate(request.prompt, 2600));
      addCardLinks(card, decisionButtons(project.threadId, request.id));
      const files = request.attachments.map((attachment, index) => new AttachmentBuilder(Buffer.from(attachment.dataUrl.slice(attachment.dataUrl.indexOf(",") + 1), "base64"), { name: `${index + 1}-${attachment.name}` }));
      if (request.prompt.length > 2600) files.push(new AttachmentBuilder(Buffer.from(request.prompt), { name: "complete-request.txt" }));
      await interaction.editReply({ ...cardEdit(cardMessage(card)), files });
      return;
    }
    if (route.action === "collabmode" || route.action === "collabusers" || route.action === "collabwipe") {
      const revision = Number(route.args[0]);
      if (!Number.isSafeInteger(revision) || revision < 0) throw new CollaborationError("Refresh the collaboration panel.");
      if (route.action === "collabmode" && interaction.isStringSelectMenu()) this.update(project.threadId, actor, revision, { mode: interaction.values[0] as CollaborationMode });
      else if (route.action === "collabwipe" && interaction.isStringSelectMenu()) {
        this.update(project.threadId, actor, revision, { wipePolicy: interaction.values[0] as WipePolicy });
      }
      else if (route.action === "collabusers" && interaction.isUserSelectMenu()) {
        if (interaction.users.some((user) => user.bot)) throw new CollaborationError("Choose people as contributors, not bots.");
        this.update(project.threadId, actor, revision, { userIds: interaction.values });
      } else throw new CollaborationError("Use the selectors on the collaboration panel.");
    } else if (route.action === "approve" || route.action === "reject") {
      const decided = await this.decide(project.threadId, actor, route.args[0] ?? "", route.action === "approve");
      await interaction.editReply({ content: decided ? (route.action === "approve" ? "Request approved and queued." : "Request rejected.") : "That request was already handled." });
      return;
    }
    const fresh = this.services.store.getProject(project.threadId);
    if (!fresh) throw new CollaborationError("This project is no longer available.");
    await interaction.editReply(cardEdit(this.panel(fresh, actor, route.action === "collaboration" ? Number(route.args[0]) || 0 : 0)));
  }
}

function decisionButtons(threadId: string, id: string): ButtonBuilder[] {
  return [new ButtonBuilder().setCustomId(cardId("reviewrequest", threadId, id)).setLabel("Review request").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cardId("approve", threadId, id)).setLabel("Approve").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(cardId("reject", threadId, id)).setLabel("Reject").setStyle(ButtonStyle.Danger)];
}
export function approvalCard(project: ProjectRecord, id: string, reviewerId = ownerId(project)): CardMessage {
  const card = new ContainerBuilder().setAccentColor(0xf59e0b);
  addCardHeader(card, "REQUEST", project.displayName, `Waiting for ${reviewerId ? `<@${reviewerId}>` : "the thread owner"} to approve this change. No agent work has started.`);
  addCardLinks(card, decisionButtons(project.threadId, id));
  return cardMessage(card);
}
