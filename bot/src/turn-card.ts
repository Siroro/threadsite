import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  escapeMarkdown,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
} from "discord.js";
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
  /** The project's own description (DESCRIPTION.md): the pitch and how to play. */
  description?: { pitch?: string; play?: string };
  /** The newest changelog entry (CHANGELOG.md): what this turn added. */
  changelog?: { title?: string; body?: string };
  /** The project's own brief, used when no description could be read. */
  request?: string;
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

/** Full-width Components V2 card with screenshot, project text and link buttons. */
export interface PlayCardMessage {
  components: [ContainerBuilder];
  files: AttachmentBuilder[];
  flags: typeof MessageFlags.IsComponentsV2;
  allowedMentions: { parse: [] };
}

// The playable card's text ceilings, in characters. The documents prompt asks
// the agent for a sentence each; these caps are the backstop that keeps an
// over-eager document from flooding the card.
const PITCH_CHARS = 240;
const REQUEST_CHARS = 220;
const CHANGELOG_CHARS = 240;
const PLAY_CHARS = 200;

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
export function renderPlayCard(state: TurnCardState): PlayCardMessage {
  const files: AttachmentBuilder[] = [];
  if (state.screenshot?.length) files.push(new AttachmentBuilder(Buffer.from(state.screenshot), { name: SCREENSHOT_NAME }));
  const isGame = state.kind !== "site";
  const container = new ContainerBuilder().setAccentColor(cardColor(state));
  // The title and the screenshot lead the card. The gallery spans the
  // container's full width, so the opening frame keeps its room instead of
  // squeezing the text beside it.
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${escapeMarkdown(truncate(singleLine(`${isGame ? "🎮" : "🛠️"} ${isGame ? "Play" : "Open"} ${state.name}`), 250))}`),
  );
  if (files.length) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(`attachment://${SCREENSHOT_NAME}`).setDescription(truncate(singleLine(state.name), 100)),
      ),
    );
  }
  // The project's own description is the card's blurb; without one the
  // original brief still says what this is, so the card is never a bare link.
  const pitch = state.description?.pitch;
  const blurb = pitch ? clip(prose(pitch), PITCH_CHARS) : state.request ? clip(prose(state.request), REQUEST_CHARS) : undefined;
  if (blurb) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(blurb));
  // The changelog heading labels its own line: it says what changed far
  // better than a generic "What's new".
  const title = state.changelog?.title?.trim();
  const entry = state.changelog?.body ? clip(prose(state.changelog.body), CHANGELOG_CHARS) : undefined;
  const details: string[] = [];
  if (entry) details.push(`**${title ? clip(title, 60) : "What's new"}** — ${entry}`);
  else if (title) details.push(`**What's new** — ${clip(title, 200)}`);
  if (state.description?.play) {
    details.push(`**${isGame ? "How to play" : "What to look at"}** — ${clip(prose(state.description.play), PLAY_CHARS)}`);
  }
  if (details.length) {
    if (blurb) container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(details.join("\n")));
  }
  // Link buttons are the card's reason to exist; the play link must survive
  // even when no repository link can be rendered.
  const playUrl = safeUrl(state.siteUrl);
  const sourceUrl = safeUrl(state.repoUrl);
  if (playUrl) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setLabel(isGame ? "▶ Play game" : "▶ Open site").setStyle(ButtonStyle.Link).setURL(playUrl),
    );
    if (sourceUrl) row.addComponents(new ButtonBuilder().setLabel("Source").setStyle(ButtonStyle.Link).setURL(sourceUrl));
    container.addActionRowComponents(row);
  }
  if (state.meta) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${escapeMarkdown(truncate(singleLine(state.meta), 200))}`));
  return { components: [container], files, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
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
  // belongs here, not a shortened version of it. Its hard-wrapped lines are
  // joined, so it reads as the report it is instead of a staircase.
  if (summary) embed.setDescription(clip(prose(summary), 3900));

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
 * Servers without Embed Links permission keep the same information in a
 * compact text view: the technical report on the turn's own message, the
 * playable blurb on the message under it.
 */
export function renderTechnicalText(state: TurnCardState): { content: string; embeds: []; allowedMentions: { parse: [] } } {
  const summary = state.summary ? stripSummaryPreamble(state.summary) : "";
  const content = [
    `**${state.published ? "✅" : "⚠️"} ${state.name}**`,
    summary ? clip(prose(summary), 1400) : "",
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
  const pitch = state.description?.pitch;
  const blurb = pitch ? clip(prose(pitch), PITCH_CHARS) : state.request ? clip(prose(state.request), REQUEST_CHARS) : undefined;
  const title = state.changelog?.title?.trim();
  const entry = state.changelog?.body ? clip(prose(state.changelog.body), CHANGELOG_CHARS) : undefined;
  const content = [
    `**${isGame ? "🎮" : "🛠️"} ${isGame ? "Play" : "Open"} ${state.name}**`,
    blurb ?? "",
    entry ? `**${title ? clip(title, 60) : "What's new"}** — ${entry}` : title ? `**What's new** — ${clip(title, 200)}` : "",
    state.description?.play ? `**${isGame ? "How to play" : "What to look at"}** — ${clip(prose(state.description.play), PLAY_CHARS)}` : "",
    state.meta ? truncate(state.meta, 120) : "",
    [isGame ? link("▶ **PLAY GAME**", state.siteUrl) : link("▶ **OPEN SITE**", state.siteUrl), link("Source", state.repoUrl)]
      .filter(Boolean).join(" · "),
  ].filter(Boolean).join("\n");
  return { content: truncate(content, 1990), embeds: [], allowedMentions: { parse: [] } };
}

/** An http(s) URL safe to render as a link, or undefined for anything else. */
function safeUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** A markdown link to an http(s) URL, or an empty string for anything else. */
function link(label: string, raw?: string): string {
  const url = safeUrl(raw);
  if (!url) return "";
  return `[${label}](${url.replaceAll("(", "%28").replaceAll(")", "%29")})`;
}

/** Embed titles collapsed newlines silently; plain text components do not. */
function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Render authored markdown the way a reader expects it. The agent writes
 * with hard line breaks, and an embed shows every one of them: wrapped lines
 * would read as a staircase. So a soft-wrapped paragraph becomes one line,
 * blank lines stay paragraph breaks, list items keep their own line, and
 * fenced code keeps its line breaks.
 */
function prose(text: string): string {
  const blocks: string[] = [];
  for (const part of text.replace(/\r\n/g, "\n").split(/(```[\s\S]*?```)/g)) {
    if (!part) continue;
    if (part.startsWith("```")) { blocks.push(part.trim()); continue; }
    for (const paragraph of part.split(/\n{2,}/)) {
      let run: string[] = [];
      const flush = () => { if (run.length) { blocks.push(run.join(" ")); run = []; } };
      for (const line of paragraph.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
        if (/^[-*+•]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
          flush();
          blocks.push(line);
          continue;
        }
        run.push(line);
      }
      flush();
    }
  }
  return blocks.join("\n\n");
}

/** Cut at a sentence if one is near the end, otherwise at a word. */
function clip(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (sentence > max * 0.5) return `${head.slice(0, sentence + 1).trimEnd()}…`;
  const space = head.lastIndexOf(" ");
  return `${(space > max * 0.6 ? head.slice(0, space) : head).trimEnd()}…`;
}
