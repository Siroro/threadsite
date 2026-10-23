import { PermissionFlagsBits, type BaseInteraction } from "discord.js";
import type { CardAction } from "./card-actions.js";
import type { ProjectRecord } from "./types.js";

export interface ProjectActor { userId: string; admin: boolean; canSend: boolean; threadOwnerId?: string }
export class CollaborationError extends Error {}

export function ownerId(project: ProjectRecord, actor?: ProjectActor): string | undefined {
  return project.ownerId ?? actor?.threadOwnerId ?? project.starterId;
}
export function managesProject(project: ProjectRecord, actor: ProjectActor): boolean {
  return actor.admin || actor.userId === ownerId(project, actor);
}
export function contributionAccess(project: ProjectRecord, actor: ProjectActor): "direct" | "approval" | "denied" {
  if (project.pendingDeletion || !actor.canSend) return "denied";
  if (managesProject(project, actor)) return "direct";
  const settings = project.collaboration;
  if (!settings || settings.mode === "open" || settings.userIds.includes(actor.userId)) return "direct";
  return settings.mode === "approval" ? "approval" : "denied";
}
export function requireContributor(project: ProjectRecord, actor: ProjectActor): void {
  if (contributionAccess(project, actor) !== "direct") throw new CollaborationError("The thread owner has restricted project edits. Use Make a change to submit a request, or ask the owner to add you as a contributor.");
}
export function requireManager(project: ProjectRecord, actor: ProjectActor): void {
  if (!actor.canSend || !managesProject(project, actor) || project.pendingDeletion) throw new CollaborationError("Only the thread owner or a server administrator can manage collaboration and approve requests.");
}

export function interactionActor(interaction: BaseInteraction, extraAdmin = false): ProjectActor {
  const channel = interaction.channel;
  const threadOwner = channel?.isThread() && channel.ownerId !== interaction.client?.user?.id ? channel.ownerId : undefined;
  return { userId: interaction.user.id,
    admin: extraAdmin || (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false),
    canSend: interaction.memberPermissions?.has(PermissionFlagsBits.SendMessagesInThreads) ?? false,
    ...(threadOwner ? { threadOwnerId: threadOwner } : {}),
  };
}

const READ_ACTIONS: readonly CardAction[] = ["details", "tab", "page", "project", "queue", "doc", "review", "retry", "collaboration"];
const REQUEST_ACTIONS: readonly CardAction[] = ["change", "steer", "request"];
const QUESTION_ACTIONS: readonly CardAction[] = ["answer", "select", "questions", "form", "other", "custom", "skip", "send"];
export function authorizeCard(project: ProjectRecord, actor: ProjectActor, action: CardAction): void {
  if (READ_ACTIONS.includes(action)) return;
  if (["collabmode", "collabusers", "approve", "reject", "reviewrequest"].includes(action)) { requireManager(project, actor); return; }
  if (REQUEST_ACTIONS.includes(action) && contributionAccess(project, actor) === "approval") return;
  // An approved request's author can answer that turn's questions without
  // receiving permission to steer or control unrelated work.
  if (project.collaboration?.mode === "approval" && actor.canSend && project.pendingTurn?.requesterId === actor.userId && QUESTION_ACTIONS.includes(action)) return;
  requireContributor(project, actor);
}
