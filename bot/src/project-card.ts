import { EmbedBuilder } from "discord.js";
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

// Matches the tracking card's per-phase palette: blurple for sites, green for
// 2D games, violet for 3D games; amber while the first build runs, red on error.
const KIND_COLORS: Record<string, number> = { site: 0x5865f2, "game-2d": 0x22c55e, "game-3d": 0x8b5cf6 };

/**
 * Design version of the card. Bump when the layout changes materially: the
 * version is stored next to the pinned message id, and the next boot upgrades
 * every card still on an older design (see reconcileProjectCards in index.ts).
 */
export const PROJECT_CARD_VERSION = 3;

const PROMPT_CHARS = 900;

function relative(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const epoch = Date.parse(iso);
  return Number.isFinite(epoch) ? `<t:${Math.floor(epoch / 1000)}:R>` : undefined;
}

/** Collapse the request into one quote block line set; embeds render markdown, so keep it prose-only. */
function quoted(text: string | undefined, max: number): string {
  const flat = (text ?? "").replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
  if (!flat) return "*(not recorded)*";
  return truncate(flat, max);
}

/** Message payload shape shared by channel send and message edit. */
export interface ProjectCardMessage {
  content: string;
  embeds: [EmbedBuilder];
  allowedMentions: { parse: [] };
}

/** The configured architecture. Legacy games default to arena, like the build harness. */
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

  const embed = new EmbedBuilder()
    .setTitle(project.displayName)
    .setColor(color)
    .setDescription([statusLine, relative(project.createdAt) ? `Created ${relative(project.createdAt)}` : undefined].filter(Boolean).join("\n"));

  // Settings come before the long request so they are visible immediately.
  embed.addFields({ name: "Type", value: projectKindLabel(project.projectKind), inline: true });
  if (kind !== "site") {
    embed.addFields(
      { name: "Engine", value: kind === "game-3d" ? "Three.js" : "Phaser", inline: true },
      { name: "Multiplayer", value: multiplayerLine(project)!, inline: true },
    );
  }
  embed.addFields({ name: "Original request", value: `> ${quoted(project.initialPrompt, PROMPT_CHARS)}`, inline: false });

  if (project.browserQaFindings) {
    // Legacy records stored their findings under `errors`; count both shapes.
    const findings = project.browserQaFindings.findings?.length ?? project.browserQaFindings.errors?.length ?? 0;
    const checked = relative(project.browserQaFindings.checkedAt);
    embed.addFields({ name: "Browser QA", value: `Advisory · ${findings ? `${findings} finding${findings === 1 ? "" : "s"}` : "no findings"}${checked ? ` · checked ${checked}` : ""}`, inline: false });
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
    embed.addFields({
      name: "Lifetime usage",
      value: `${usage.turns} turn${usage.turns === 1 ? "" : "s"}${failed} · ${tokens}`,
      inline: false,
    });
    // Cost is deliberately absent, like the tracking card: token counts are
    // public, spend data is admin-only (/site info, /site-admin usage).
  }

  const links = [
    state.siteUrl ? `[Open the ${kind === "site" ? "site" : "game"}](${state.siteUrl})` : undefined,
    state.repoUrl ? `[Source](${state.repoUrl})` : undefined,
  ].filter(Boolean);
  if (links.length) embed.addFields({ name: "Links", value: links.join(" · "), inline: false });

  // No footer: every line must earn its place, and the design version lives in
  // the stored record (infoCardVersion), not on the card itself.
  return { content: "", embeds: [embed], allowedMentions: { parse: [] } };
}
