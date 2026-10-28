import { ButtonBuilder, ButtonStyle, ContainerBuilder, TextDisplayBuilder, ThumbnailBuilder } from "discord.js";
import { addCardDivider, addCardField, addCardHeader, addCardLinks, cardLink, cardMessage, KIND_COLORS, safeCardUrl, type CardMessage } from "./card-ui.js";
import { cardId } from "./card-actions.js";
import { COLLABORATION_LABELS, WIPE_POLICY_LABELS } from "./collaboration-service.js";
import { modelDisplayName, SURPLUS_PROVIDER_ID } from "./opencode.js";
import type { ProjectDescription } from "./project-docs.js";
import { projectKindLabel } from "./templates.js";
import type { ContributionTally, ProjectRecord } from "./types.js";
import type { UsageTotal } from "./usage.js";
import { formatCost, formatTokens, truncate } from "./util.js";

/**
 * State rendered into the pinned project card. The card is posted when a
 * project thread is created, pinned to the thread, and edited in place after
 * every turn outcome — a durable front page for the project, in contrast to
 * the per-turn progress card that lives and dies with each request.
 */
export interface ProjectCardState {
  project: ProjectRecord;
  /** Lifetime model usage for the thread, from the usage ledger. */
  usage?: UsageTotal & { lastTs?: string };
  siteUrl?: string;
  repoUrl?: string;
  description?: ProjectDescription;
  thumbnailUrl?: string;
}

const PROMPT_CHARS = 900;

function relative(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const epoch = Date.parse(iso);
  return Number.isFinite(epoch) ? `<t:${Math.floor(epoch / 1000)}:R>` : undefined;
}

/** Collapse the request into one quote block line set. */
function quoted(text: string | undefined, max: number): string {
  const flat = (text ?? "").replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
  if (!flat) return "*(not recorded)*";
  return truncate(flat, max);
}

/** Message payload shape shared by channel send and message edit. */
export type ProjectCardMessage = CardMessage;

/** The configured multiplayer architecture. */
function multiplayerLine(project: ProjectRecord): string | undefined {
  if (!project.projectKind || project.projectKind === "site") return undefined;
  const mode = project.multiplayerMode ?? "arena";
  if (mode === "singleplayer") return "Singleplayer only";
  if (mode === "rooms") return "Invite-code rooms";
  return "Shared arena multiplayer";
}

// The contributor list stops here; a busy thread summarizes the rest in one line.
const CONTRIBUTOR_ROWS = 8;

function contributionTotal(tally: ContributionTally): number {
  return tally.turns + tally.steers + tally.answers;
}

/** One user's counts as display text, e.g. "2 turns · 1 steer · 3 answers". */
function contributionList(tally: ContributionTally): string {
  const labels = { turns: "turn", steers: "steer", answers: "answer" } as const;
  return (Object.keys(labels) as Array<keyof typeof labels>)
    .filter((kind) => tally[kind] > 0)
    .map((kind) => `${tally[kind]} ${labels[kind]}${tally[kind] === 1 ? "" : "s"}`)
    .join(" · ");
}

/**
 * The people behind the project: the founder as a profile link, then each
 * contributor's lifetime counts, busiest first. Mentions render as profile
 * links; the card's allowedMentions keeps them from notifying anyone.
 */
function contributorSection(project: ProjectRecord): string | undefined {
  const entries = Object.entries(project.contributors ?? {})
    .filter(([, tally]) => contributionTotal(tally) > 0)
    .sort(([, a], [, b]) => contributionTotal(b) - contributionTotal(a) || b.turns - a.turns);
  if (!project.starterId && !entries.length) return undefined;
  const rows = entries.slice(0, CONTRIBUTOR_ROWS).map(([userId, tally]) => `<@${userId}> · ${contributionList(tally)}`);
  const more = entries.length - CONTRIBUTOR_ROWS;
  return [
    project.starterId ? `**Started by** <@${project.starterId}>` : undefined,
    ...rows,
    more > 0 ? `+${more} more contributor${more === 1 ? "" : "s"}` : undefined,
  ].filter(Boolean).join("\n");
}

// The cost roster stops here; a long-lived thread summarizes the rest in one line.
const COST_MODEL_ROWS = 4;

/**
 * The project's lifetime spend: the ledgered total, then one line per model
 * that billed anything — its tokens, then its cost — provider-stripped like
 * every public model name. A model served through the surplus provider quotes
 * its billed figure plus, when another provider's catalog lists the same
 * model, what those tokens would have cost at its list rates. A project with
 * nothing priced returns nothing rather than a $0 field.
 */
function lifetimeCostLines(usage: UsageTotal): string | undefined {
  if (!(usage.cost > 0 || usage.catalogCost > 0)) return undefined;
  const rows = [...usage.models.values()]
    .filter((entry) => entry.cost > 0 || (entry.catalogCost ?? 0) > 0)
    .sort((a, b) => b.cost - a.cost || (b.catalogCost ?? 0) - (a.catalogCost ?? 0));
  const lines = rows.slice(0, COST_MODEL_ROWS).map((entry) => {
    const tokens = entry.inputTokens || entry.outputTokens
      ? `in ${formatTokens(entry.inputTokens)} · out ${formatTokens(entry.outputTokens)} · ` : "";
    const spend = formatCost(entry.cost);
    if (!entry.model.startsWith(`${SURPLUS_PROVIDER_ID}/`)) return `\`${modelDisplayName(entry.model)}\`: ${tokens}${spend}`;
    const catalog = entry.catalogCost && entry.catalogCost > 0 ? ` · ${formatCost(entry.catalogCost)} at catalog rates` : "";
    return `\`${modelDisplayName(entry.model)}\`: ${tokens}${spend} on surplus${catalog}`;
  });
  const more = rows.length - lines.length;
  return [
    `**Total ${formatCost(usage.cost)}**${usage.catalogCost > 0 ? ` · ${formatCost(usage.catalogCost)} at catalog rates` : ""}`,
    ...lines,
    more > 0 ? `+${more} more model${more === 1 ? "" : "s"}` : undefined,
  ].filter(Boolean).join("\n");
}

/** The pinned, self-updating front page of a project thread. */
export function renderProjectCard(state: ProjectCardState): ProjectCardMessage {
  const { project, usage } = state;
  const kind = project.projectKind ?? "site";
  const color = project.status === "error"
    ? 0xef4444
    : project.status === "creating"
      ? 0xf59e0b
      : KIND_COLORS[kind] ?? KIND_COLORS.site;

  const statusLine = project.status === "creating"
    ? "🛠️ Building the first version…"
    : project.status === "error"
      ? "⚠️ The last turn failed: reply here to retry; the previously published version is unchanged."
      : `✅ Live${project.lastCommit ? ` · version \`${project.lastCommit}\`` : ""}${relative(project.lastTurnAt) ? ` · updated ${relative(project.lastTurnAt)}` : ""}`;

  const card = new ContainerBuilder().setAccentColor(color);
  // A signed or otherwise unusable URL would fail the whole card send, so the
  // thumbnail is dropped rather than risking the pinned card.
  const thumbnailUrl = safeCardUrl(state.thumbnailUrl);
  const thumbnail = thumbnailUrl ? new ThumbnailBuilder().setURL(thumbnailUrl).setDescription(`Preview of ${project.displayName}`) : undefined;
  addCardHeader(card, "PROJECT", project.displayName, statusLine, thumbnail);
  if (state.description?.pitch) card.addTextDisplayComponents(new TextDisplayBuilder().setContent(truncate(state.description.pitch, 300)));
  addCardLinks(card, [cardLink(kind === "site" ? "Open site" : "Play game", state.siteUrl)?.setEmoji("▶️"), cardLink("Source", state.repoUrl)]);
  if (project.workspacePath) addCardLinks(card, [
    new ButtonBuilder().setCustomId(cardId("change", project.threadId)).setLabel("Make a change").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(cardId("project", project.threadId)).setLabel("Project details").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cardId("queue", project.threadId)).setLabel(`Queue${project.pendingQueue?.length ? ` · ${project.pendingQueue.length}` : ""}`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cardId("collaboration", project.threadId)).setLabel("Collaboration").setStyle(ButtonStyle.Secondary),
    ...(kind !== "site"
      ? [new ButtonBuilder().setCustomId(cardId("wipe", project.threadId)).setLabel("Wipe state").setEmoji("🧹").setStyle(ButtonStyle.Danger)]
      : []),
  ]);
  addCardDivider(card);

  // Settings come before the long request so they are visible immediately.
  const settings = [`**Type** · ${projectKindLabel(project.projectKind)}`];
  settings.push(`**Editing** · ${COLLABORATION_LABELS[project.collaboration?.mode ?? "open"]}`);
  if (kind !== "site") {
    settings.push(`**Engine** · ${kind === "game-3d" ? "Three.js" : "Excalibur"}`, `**Multiplayer** · ${multiplayerLine(project)}`,
      `**Reset state** · ${WIPE_POLICY_LABELS[project.collaboration?.wipePolicy ?? "owner"]}`);
  }
  addCardField(card, "Project details", settings.join("\n"));
  const contributors = contributorSection(project);
  if (contributors) {
    addCardDivider(card);
    addCardField(card, "Contributors", contributors);
  }
  addCardDivider(card);
  addCardField(card, "Original request", `> ${quoted(project.initialPrompt, PROMPT_CHARS)}`);

  if (project.browserQaFindings) {
    const findings = project.browserQaFindings.findings.length;
    const checked = relative(project.browserQaFindings.checkedAt);
    addCardField(card, "Browser QA", `Advisory · ${findings ? `${findings} finding${findings === 1 ? "" : "s"}` : "no findings"}${checked ? ` · checked ${checked}` : ""}`);
  }

  // Model routing (provider-qualified ids) is operational detail, kept in the
  // admin-only /site-admin models view; the model names that billed the thread
  // appear with their spend in the lifetime cost field.

  if (usage && usage.turns > 0) {
    const cached = usage.cacheTokens > 0 ? ` (${formatTokens(usage.cacheTokens)} cached)` : "";
    const failed = usage.failedTurns > 0 ? ` · ${usage.failedTurns} failed` : "";
    const tokens = usage.inputTokens || usage.outputTokens
      ? `in ${formatTokens(usage.inputTokens)}${cached} · out ${formatTokens(usage.outputTokens)}`
      : "token counts unavailable";
    addCardField(card, "Lifetime usage", `${usage.turns} turn${usage.turns === 1 ? "" : "s"}${failed} · ${tokens}`);
    const cost = lifetimeCostLines(usage);
    if (cost) addCardField(card, "Lifetime cost", cost);
  }

  addCardDivider(card);
  card.addTextDisplayComponents(new TextDisplayBuilder().setContent([
    "-# Reply in this thread to shape the next version.",
    relative(project.createdAt) ? `-# Created ${relative(project.createdAt)}` : undefined,
  ].filter(Boolean).join("\n")));
  return cardMessage(card);
}
