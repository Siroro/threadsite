import { ContainerBuilder, TextDisplayBuilder } from "discord.js";
import { addCardDivider, addCardField, addCardHeader, addCardLinks, cardLink, cardMessage, KIND_COLORS, type CardMessage } from "./card-ui.js";
import { projectKindLabel } from "./templates.js";
import type { ProjectRecord } from "./types.js";
import type { UsageTotal } from "./usage.js";
import { formatTokens, truncate } from "./util.js";

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
      ? "⚠️ The last turn failed — reply here to retry; the previously published version is unchanged."
      : `✅ Live${project.lastCommit ? ` · version \`${project.lastCommit}\`` : ""}${relative(project.lastTurnAt) ? ` · updated ${relative(project.lastTurnAt)}` : ""}`;

  const card = new ContainerBuilder().setAccentColor(color);
  addCardHeader(card, "PROJECT", project.displayName, statusLine);
  addCardLinks(card, [cardLink(kind === "site" ? "Open site" : "Play game", state.siteUrl), cardLink("Source", state.repoUrl)]);
  addCardDivider(card);

  // Settings come before the long request so they are visible immediately.
  const settings = [`**Type** · ${projectKindLabel(project.projectKind)}`];
  if (kind !== "site") {
    settings.push(`**Engine** · ${kind === "game-3d" ? "Three.js" : "Excalibur"}`, `**Multiplayer** · ${multiplayerLine(project)}`);
  }
  addCardField(card, "Project details", settings.join("\n"));
  addCardDivider(card);
  addCardField(card, "Original request", `> ${quoted(project.initialPrompt, PROMPT_CHARS)}`);

  if (project.browserQaFindings) {
    const findings = project.browserQaFindings.findings.length;
    const checked = relative(project.browserQaFindings.checkedAt);
    addCardField(card, "Browser QA", `Advisory · ${findings ? `${findings} finding${findings === 1 ? "" : "s"}` : "no findings"}${checked ? ` · checked ${checked}` : ""}`);
  }

  // Model, effort, and which models served the thread are deliberately absent:
  // model routing is operational detail, kept in the admin-only
  // /site-admin models view rather than on a public pinned card.

  if (usage && usage.turns > 0) {
    const cached = usage.cacheTokens > 0 ? ` (${formatTokens(usage.cacheTokens)} cached)` : "";
    const failed = usage.failedTurns > 0 ? ` · ${usage.failedTurns} failed` : "";
    const tokens = usage.inputTokens || usage.outputTokens
      ? `in ${formatTokens(usage.inputTokens)}${cached} · out ${formatTokens(usage.outputTokens)}`
      : "token counts unavailable";
    addCardField(card, "Lifetime usage", `${usage.turns} turn${usage.turns === 1 ? "" : "s"}${failed} · ${tokens}`);
    // Cost is deliberately absent, like the tracking card: token counts are
    // public, spend data is admin-only (/site info, /site-admin usage).
  }

  addCardDivider(card);
  card.addTextDisplayComponents(new TextDisplayBuilder().setContent([
    "-# Reply in this thread to shape the next version.",
    relative(project.createdAt) ? `-# Created ${relative(project.createdAt)}` : undefined,
  ].filter(Boolean).join("\n")));
  return cardMessage(card);
}
