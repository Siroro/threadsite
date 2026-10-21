import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import type { TurnUsage } from "./opencode.js";
import type { ProjectKind } from "./types.js";
import { formatShortDuration, formatTokens, stripSummaryPreamble, truncate } from "./util.js";

/**
 * The final presentation of a finished turn, in two messages:
 *
 * 1. the turn's own message becomes the technical card — the agent's full
 *    report of what it did, the commit, the usage;
 * 2. a new message under it carries the playable card — the screenshot, the
 *    model-written preview of the project, and the link that opens it.
 *
 * The two answer two different questions. "What did this turn do?" is for the
 * person who asked for it; "what is it, and can I play it?" is for anyone who
 * opens the thread later.
 */
export interface TurnCardState {
  /** Display name of the project. */
  name: string;
  /** Site or game kind; decides the wording and the card colour. */
  kind: ProjectKind;
  /** Whether this turn is live on the web server. */
  published: boolean;
  /** Commit created by the turn, when it created one. */
  commit?: string;
  /** Files changed by the commit. */
  commitFiles: number;
  /** Lines added and removed by the commit. */
  additions: number;
  deletions: number;
  /** Wall-clock duration of the turn. */
  durationMs: number;
  /** Token/context usage of the turn, when the agent service reported it. */
  usage?: TurnUsage;
  /** The agent's own account of the turn (OpenCode's summary). */
  summary?: string;
  /** A note worth showing under the technical card (e.g. how the thread works). */
  note?: string;
  /** Confirmed browser-QA findings; advisory, never blocking. */
  findings?: string[];
  /** Model-written preview of the project: pitch, change and how to play. */
  preview?: { pitch: string; added?: string; play?: string };
  /** Project meta for the playable card's footer: type, engine, multiplayer. */
  meta?: string;
  /** Public URL of the published project. */
  siteUrl: string;
  /** Public URL of the project's source repository. */
  repoUrl: string;
  /** PNG screenshot of the finished result, when browser QA captured one. */
  screenshot?: Uint8Array;
}

/** Message payload shape shared by channel send and message edit. */
export interface TurnCardMessage {
  content: string;
  embeds: EmbedBuilder[];
  files: AttachmentBuilder[];
  allowedMentions: { parse: [] };
}

// Matches the project card's palette: blurple for sites, green for 2D games,
// violet for 3D games. Both cards of a turn share one colour so the final
// post reads as a single presentation.
const KIND_COLORS: Record<string, number> = { site: 0x5865f2, "game-2d": 0x22c55e, "game-3d": 0x8b5cf6 };
const UNPUBLISHED_COLOR = 0xf59e0b;
const SCREENSHOT_NAME = "preview.png";

/** The colour both cards of a turn share. */
function cardColor(state: TurnCardState): number {
  return state.published ? KIND_COLORS[state.kind] ?? KIND_COLORS.site : UNPUBLISHED_COLOR;
}

/**
 * Message 1 — the turn's own message becomes the technical report. The
 * agent's report is the point of this card: it keeps the full account of the
 * turn, not a summary of one.
 */
export function renderTechnicalCard(state: TurnCardState): TurnCardMessage {
  return { content: "", embeds: [technicalCard(state)], files: [], allowedMentions: { parse: [] } };
}

/** Message 2 — the new message that presents the project and opens it. */
export function renderPlayCard(state: TurnCardState): TurnCardMessage {
  const files: AttachmentBuilder[] = [];
  if (state.screenshot?.length) files.push(new AttachmentBuilder(Buffer.from(state.screenshot), { name: SCREENSHOT_NAME }));
  return { content: "", embeds: [playableCard(state, files.length > 0)], files, allowedMentions: { parse: [] } };
}

/**
 * Card 1 — the technical report: what the agent did, what shipped, and what
 * it cost. This is the part the person who asked for the change reads.
 */
export function technicalCard(state: TurnCardState): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`${state.published ? "✅" : "⚠️"} ${truncate(state.name, 180)}`)
    .setColor(cardColor(state));
  const summary = state.summary ? stripSummaryPreamble(state.summary) : "";
  // Discord allows a 4096-character description: the agent's full report
  // belongs here, not a shortened version of it.
  if (summary) embed.setDescription(truncate(summary, 3900));

  const turn: string[] = [];
  if (state.commit) turn.push(`commit \`${state.commit.slice(0, 10)}\``);
  turn.push(`${state.commitFiles} file${state.commitFiles === 1 ? "" : "s"} changed (+${state.additions}/−${state.deletions})`);
  turn.push(`⏱️ ${formatShortDuration(state.durationMs)}`);
  embed.addFields({ name: "Turn", value: turn.join("\n"), inline: true });

  if (state.usage) {
    const usage: string[] = [];
    if (state.usage.inputTokens || state.usage.outputTokens) {
      usage.push(`${formatTokens(state.usage.inputTokens)} in · ${formatTokens(state.usage.outputTokens)} out`);
    }
    if (state.usage.steps) usage.push(`${state.usage.steps} model step${state.usage.steps === 1 ? "" : "s"}`);
    if (state.usage.compactions) usage.push(`context compacted ${state.usage.compactions}×`);
    if (usage.length) embed.addFields({ name: "Usage", value: usage.join("\n"), inline: true });
  }

  if (state.findings?.length) {
    embed.addFields({
      name: "Browser QA",
      value: `Advisory · ${state.findings.length} finding${state.findings.length === 1 ? "" : "s"} — ${truncate(state.findings[0], 220)}`,
      inline: true,
    });
  }

  if (state.note) embed.addFields({ name: "Note", value: truncate(state.note, 900), inline: false });
  return embed;
}

/**
 * Card 2 — the playable one: the screenshot, what the project is, what this
 * turn changed, how to play it, and the link that opens it.
 */
export function playableCard(state: TurnCardState, hasScreenshot: boolean): EmbedBuilder {
  const isGame = state.kind !== "site";
  const embed = new EmbedBuilder()
    .setTitle(`${isGame ? "🎮" : "🛠️"} ${isGame ? "Play" : "Open"} ${truncate(state.name, 180)}`)
    .setColor(cardColor(state));
  if (hasScreenshot) embed.setImage(`attachment://${SCREENSHOT_NAME}`);
  if (state.preview?.pitch) embed.setDescription(truncate(state.preview.pitch, 1500));
  if (state.preview?.added) {
    embed.addFields({ name: "What's new", value: truncate(state.preview.added, 1000), inline: false });
  }
  if (state.preview?.play) {
    embed.addFields({ name: isGame ? "How to play" : "What to look at", value: truncate(state.preview.play, 1000), inline: false });
  }
  const links = [isGame ? link("▶ **PLAY GAME**", state.siteUrl) : link("▶ **OPEN SITE**", state.siteUrl), link("Source", state.repoUrl)]
    .filter(Boolean)
    .join("\n");
  if (links) embed.addFields({ name: "Links", value: links, inline: false });
  if (state.meta) embed.setFooter({ text: truncate(state.meta, 200) });
  return embed;
}

/**
 * Servers without Embed Links permission keep the same information in a
 * compact text view: the technical report on the turn's own message, the
 * playable blurb on the message under it.
 */
export function renderTechnicalText(state: TurnCardState): { content: string; embeds: []; allowedMentions: { parse: [] } } {
  const summary = state.summary ? stripSummaryPreamble(state.summary) : "";
  const content = [
    `**${state.published ? "✅" : "⚠️"} ${state.name}**`,
    summary ? truncate(summary, 1400) : "",
    [
      state.commit ? `commit \`${state.commit.slice(0, 10)}\`` : "",
      `${state.commitFiles} file${state.commitFiles === 1 ? "" : "s"} changed (+${state.additions}/−${state.deletions})`,
      `⏱️ ${formatShortDuration(state.durationMs)}`,
    ].filter(Boolean).join(" · "),
    state.findings?.length ? `⚠️ Browser QA: ${truncate(state.findings[0], 200)}` : "",
    state.note ? truncate(state.note, 300) : "",
  ].filter(Boolean).join("\n");
  return { content: truncate(content, 1990), embeds: [], allowedMentions: { parse: [] } };
}

export function renderPlayText(state: TurnCardState): { content: string; embeds: []; allowedMentions: { parse: [] } } {
  const isGame = state.kind !== "site";
  const content = [
    `**${isGame ? "🎮" : "🛠️"} ${isGame ? "Play" : "Open"} ${state.name}**`,
    state.preview?.pitch ? truncate(state.preview.pitch, 600) : "",
    state.preview?.added ? `**What's new** — ${truncate(state.preview.added, 400)}` : "",
    state.preview?.play ? `**${isGame ? "How to play" : "What to look at"}** — ${truncate(state.preview.play, 500)}` : "",
    state.meta ? truncate(state.meta, 120) : "",
    [isGame ? link("▶ **PLAY GAME**", state.siteUrl) : link("▶ **OPEN SITE**", state.siteUrl), link("Source", state.repoUrl)]
      .filter(Boolean).join(" · "),
  ].filter(Boolean).join("\n");
  return { content: truncate(content, 1990), embeds: [], allowedMentions: { parse: [] } };
}

/** A markdown link to an http(s) URL, or an empty string for anything else. */
function link(label: string, raw?: string): string {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return "";
    return `[${label}](${url.href.replaceAll("(", "%28").replaceAll(")", "%29")})`;
  } catch {
    return "";
  }
}
