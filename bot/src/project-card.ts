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
  /** Store-wide model override at render time; undefined means the agent service default. */
  model?: string;
  /** Store-wide reasoning-effort override; undefined means the model default ("auto"). */
  effort?: string;
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
export const PROJECT_CARD_VERSION = 1;

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

/** The game's connectivity in one phrase; sites have none. Legacy games (no stored mode) default to arena. */
function multiplayerLine(project: ProjectRecord): string | undefined {
  if (!project.projectKind || project.projectKind === "site") return undefined;
  const mode = project.multiplayerMode ?? (project.multiplayerGameId ? "arena" : undefined);
  if (mode === "singleplayer") return "singleplayer only";
  if (mode === "rooms") return "invite-code rooms via the shared relay";
  if (mode === "arena") return "arena multiplayer via the shared relay";
  return undefined;
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
    .setDescription([statusLine, "", "**Original request**", `> ${quoted(project.initialPrompt, PROMPT_CHARS)}`].join("\n"));

  const projectBits = [
    projectKindLabel(project.projectKind),
    multiplayerLine(project),
    project.createdAt ? `created ${relative(project.createdAt)}` : undefined,
  ].filter(Boolean);
  embed.addFields({ name: "Project", value: projectBits.join(" · "), inline: false });

  const modelBits = [
    `\`${state.model || "the service default model"}\``,
    `effort \`${state.effort || "auto"}\``,
  ];
  const context = project.lastTurnUsage;
  if (context?.contextTokens) {
    const limit = context.contextLimit ? ` of ${formatTokens(context.contextLimit)}` : "";
    const percent = context.contextLimit ? ` (${Math.round((context.contextTokens / context.contextLimit) * 100)}%)` : "";
    modelBits.push(`session context ${formatTokens(context.contextTokens)}${limit}${percent}`);
  }
  embed.addFields({ name: "Model", value: modelBits.join(" · "), inline: false });

  if (usage && usage.turns > 0) {
    const cached = usage.cacheTokens > 0 ? ` (${formatTokens(usage.cacheTokens)} cached)` : "";
    const failed = usage.failedTurns > 0 ? ` · ${usage.failedTurns} failed` : "";
    const models = [...usage.models.entries()]
      .sort((a, b) => (b[1].inputTokens + b[1].outputTokens) - (a[1].inputTokens + a[1].outputTokens))
      .slice(0, 3)
      .map(([model, total]) => `\`${model}\``);
    embed.addFields({
      name: "Lifetime usage",
      value: `${usage.turns} turn${usage.turns === 1 ? "" : "s"}${failed} · in ${formatTokens(usage.inputTokens)}${cached} · out ${formatTokens(usage.outputTokens)}`
        + (models.length ? `\nmodels: ${models.join(", ")}` : ""),
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
