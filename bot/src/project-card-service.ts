import type { Client, Message } from "discord.js";
import { cardEdit } from "./card-ui.js";
import type { StoredTurnCard } from "./card-state.js";
import type { PanelSection } from "./card-panels.js";
import { readProjectCardDocument } from "./project-docs.js";
import { lifetimeModelLines, renderProjectCard, type ProjectCardMessage, type ProjectCardState } from "./project-card.js";
import { log, serializeError } from "./logger.js";
import type { Store } from "./store.js";
import type { UsageLog } from "./usage.js";
import type { ProjectRecord } from "./types.js";
import { multiplayerModeLabel, projectKindLabel } from "./templates.js";
import { costsHidden, formatCost, formatTokens } from "./util.js";

interface CardChannel { send(options: ProjectCardMessage): Promise<Message> }
interface ProjectLinks { siteLink(project: ProjectRecord): string; repoLink(project: ProjectRecord): string }

/** Owns pinned-card reads and Discord delivery independently of command routing. */
export class ProjectCardService {
  constructor(
    private readonly store: Pick<Store, "getCardState" | "getProject" | "patchProject">,
    private readonly client: Pick<Client, "channels" | "user">,
    private readonly usageLog: Pick<UsageLog, "threadTotal">,
    private readonly links: ProjectLinks,
  ) {}

  async state(project: ProjectRecord): Promise<ProjectCardState> {
    const last = project.lastCardMessageId ? this.store.getCardState<StoredTurnCard>(project.threadId, project.lastCardMessageId)?.result : undefined;
    const channel = project.previewMessageId ? await this.client.channels.fetch(project.threadId).catch(() => undefined) : undefined;
    const preview = project.previewMessageId && channel?.isTextBased() ? await channel.messages.fetch(project.previewMessageId).catch(() => undefined) : undefined;
    return {
      project,
      usage: await this.usageLog.threadTotal(project.threadId),
      siteUrl: project.status !== "creating" ? this.links.siteLink(project) : undefined,
      repoUrl: project.repoName ? this.links.repoLink(project) : undefined,
      description: last?.description,
      thumbnailUrl: preview?.attachments.find((attachment) => attachment.contentType?.startsWith("image/"))?.url,
    };
  }

  async details(project: ProjectRecord): Promise<PanelSection[]> {
    const state = await this.state(project);
    const last = project.lastCardMessageId ? this.store.getCardState<StoredTurnCard>(project.threadId, project.lastCardMessageId) : undefined;
    const [description, changelog] = await Promise.all([
      last?.documents?.description ?? readProjectCardDocument(project.workspacePath, "description"),
      last?.documents?.changelog ?? readProjectCardDocument(project.workspacePath, "changelog"),
    ]);
    const usage = state.usage;
    const stamp = (iso: string | undefined): string | undefined => {
      const epoch = iso ? Date.parse(iso) : NaN;
      return Number.isFinite(epoch) ? `<t:${Math.floor(epoch / 1000)}:f>` : undefined;
    };
    const status = project.status === "creating"
      ? "🛠️ Building the first version"
      : project.status === "error"
        ? "⚠️ The last turn failed: the published version is unchanged"
        : "✅ Live";
    return [
      { key: "overview", label: "Project overview", text: [
        `**${project.displayName}**`,
        projectKindLabel(project.projectKind),
        project.projectKind !== "site" ? multiplayerModeLabel(project.multiplayerMode ?? "arena") : "",
        status,
        state.siteUrl ? `[Live site](${state.siteUrl})` : "",
        state.repoUrl ? `[Source](${state.repoUrl})` : "",
        `Created ${stamp(project.createdAt) ?? "not recorded"}`,
        project.lastTurnAt ? `Last turn ${stamp(project.lastTurnAt)}` : "",
        project.lastCommit ? `Last commit \`${project.lastCommit}\`` : "",
      ].filter(Boolean).join("\n") },
      { key: "request", label: "Original request", text: project.initialPrompt
        ? project.initialPrompt.trim().split("\n").map((line) => `> ${line}`).join("\n")
        : "The original request was not recorded." },
      { key: "description", label: "Description & how to play", text: description || "The agent has not written a description yet." },
      { key: "changelog", label: "Changelog", text: changelog || "No changelog entry has been written yet." },
      { key: "usage", label: "Lifetime usage", text: usage ? [
        `**${usage.turns} turn${usage.turns === 1 ? "" : "s"}**${usage.failedTurns ? ` · ${usage.failedTurns} failed` : ""}`,
        usage.inputTokens || usage.outputTokens
          ? `Input **${formatTokens(usage.inputTokens)}** · Output **${formatTokens(usage.outputTokens)}** · Cached **${formatTokens(usage.cacheTokens)}**`
          : "Token counts unavailable",
        !costsHidden() && (usage.cost > 0 || usage.catalogCost > 0)
          ? `Spend **${formatCost(usage.cost)}**${usage.catalogCost > 0 ? ` · **${formatCost(usage.catalogCost)}** at catalog rates` : ""}`
          : "",
        ...lifetimeModelLines(usage, !costsHidden()),
        usage.lastTs ? `Last recorded ${usage.lastTs}` : "",
      ].filter(Boolean).join("\n") : "Provider usage counts unavailable." },
      { key: "qa", label: "Browser findings", text: project.browserQaFindings ? `Advisory · checked ${stamp(project.browserQaFindings.checkedAt) ?? project.browserQaFindings.checkedAt}\n\n${project.browserQaFindings.findings.map((finding) => `- ${finding}`).join("\n") || "No findings"}` : "No browser findings have been recorded." },
    ];
  }

  /** Send the card, pin it, and link it to the project record when one exists. */
  async post(thread: CardChannel, project: ProjectRecord): Promise<Message | undefined> {
    const message = await thread.send({ ...renderProjectCard(await this.state(project)) }).catch((error: unknown) => {
      log("warn", "discord.project_card_post_failed", { threadId: project.threadId, error: serializeError(error) });
      return undefined;
    });
    if (!message) return undefined;
    // Pinning needs Manage Messages; an unpinned card still works, it just does
    // not sit at the top of the thread.
    await message.pin().catch((error) => log("warn", "discord.project_card_pin_failed", { threadId: project.threadId, error: serializeError(error) }));
    if (this.store.getProject(project.threadId)) {
      await this.store.patchProject(project.threadId, { infoMessageId: message.id }).catch(() => undefined);
    }
    log("info", "discord.project_card_posted", { threadId: project.threadId, messageId: message.id });
    return message;
  }

  /** Edit the pinned card in place; (re)post and pin when missing or deleted. */
  async refresh(threadId: string): Promise<void> {
    try {
      const project = this.store.getProject(threadId);
      if (!project) return;
      const channel = await this.client.channels.fetch(threadId).catch(() => undefined);
      const thread = channel?.isTextBased() && "send" in channel ? channel : undefined;
      if (!thread) return;
      if (project.infoMessageId) {
        const card = await thread.messages.fetch(project.infoMessageId).catch(() => undefined);
        if (card && card.author.id === this.client.user?.id) {
          await card.edit(cardEdit(renderProjectCard(await this.state(project))));
          return;
        }
      }
      await this.post(thread, project);
    } catch (error) {
      log("warn", "discord.project_card_refresh_failed", { threadId, error: serializeError(error) });
    }
  }
}
