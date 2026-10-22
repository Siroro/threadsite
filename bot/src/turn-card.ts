import {
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  FileBuilder,
  escapeMarkdown,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
} from "discord.js";
import { addCardDivider, addCardField, addCardHeader, addCardTitle, addCardLinks, cardLink, cardMessage, cardTextLength, CARD_TEXT_LIMIT, KIND_COLORS, type CardMessage } from "./card-ui.js";
import { cardId } from "./card-actions.js";
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
  /** Stable technical message ID; all personal views refer to this turn's saved data. */
  resource?: string;
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
export interface TurnCardMessage extends CardMessage {
  files: AttachmentBuilder[];
}

/** Full-width Components V2 card with screenshot, project text and link buttons. */
export type PlayCardMessage = TurnCardMessage;

// The playable card's text ceilings, in characters. The documents prompt asks
// the agent for a sentence each; these caps are the backstop that keeps an
// over-eager document from flooding the card.
const PITCH_CHARS = 240;
const REQUEST_CHARS = 220;
const CHANGELOG_CHARS = 240;

// Matches the project card's palette: blurple for sites, green for 2D games,
// violet for 3D games. Both cards of a turn share one colour so the final
// post reads as a single presentation.
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
  const card = technicalCard(state);
  const files: AttachmentBuilder[] = [];
  const report = new TextDisplayBuilder().setContent("Report unavailable.");
  card.spliceComponents(1, 0, new SeparatorBuilder(), report, new SeparatorBuilder());
  const summary = state.summary ? stripSummaryPreamble(state.summary) : "";
  const fullReport = summary ? prose(summary) : "The agent did not provide a report for this turn.";
  const available = CARD_TEXT_LIMIT - cardTextLength(card) + report.data.content!.length;
  if (fullReport.length > available) {
    // The entire V2 message shares 4,000 characters. Keep the complete
    // report as a visible file component when its excerpt cannot fit.
    const name = "turn-report.md";
    files.push(new AttachmentBuilder(Buffer.from(state.summary ?? summary), { name }));
    card.addFileComponents(new FileBuilder().setURL(`attachment://${name}`));
    report.setContent(`${clip(fullReport, available - 80)}\n\n-# Full report attached below.`);
  } else report.setContent(fullReport);
  return { ...cardMessage(card), files };
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
  addCardTitle(container, `${isGame ? "🎮 Play" : "🛠️ Open"} ${state.name}`,
    state.published ? `● Live · ${isGame ? "ready to play" : "ready to explore"}` : "⚠️ This turn was not published · opens the previous live version");
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
  // better than a generic "What's new". The how-to-play stays behind the
  // card's How to play button: the card keeps only the headline.
  const title = state.changelog?.title?.trim();
  const entry = state.changelog?.body ? clip(prose(state.changelog.body), CHANGELOG_CHARS) : undefined;
  const details: string[] = [];
  if (entry) details.push(`**${title ? clip(title, 60) : "What's new"}** — ${entry}`);
  else if (title) details.push(`**What's new** — ${clip(title, 200)}`);
  if (details.length) {
    if (blurb) container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(details.join("\n")));
  }
  addCardDivider(container);
  addCardLinks(container, [cardLink(isGame ? "▶ Play game" : "▶ Open site", state.siteUrl), cardLink("Source", state.repoUrl)]);
  if (state.resource) addCardLinks(container, [
    new ButtonBuilder().setCustomId(cardId("doc", state.resource, "description")).setLabel(isGame ? "How to play" : "About this site").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cardId("doc", state.resource, "changelog")).setLabel("Changelog").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cardId("change", state.resource)).setLabel("Request a change").setStyle(ButtonStyle.Primary),
  ]);
  if (state.meta) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${escapeMarkdown(truncate(singleLine(state.meta), 200))}`));
  return { ...cardMessage(container), files };
}

/**
 * Card 1 — the technical report: what the agent did, what shipped, and what
 * it cost. This is the part the person who asked for the change reads.
 */
function technicalCard(state: TurnCardState): ContainerBuilder {
  const card = new ContainerBuilder().setAccentColor(cardColor(state));
  addCardHeader(card, "TURN COMPLETE", `${state.published ? "✅" : "⚠️"} ${state.name}`,
    state.published ? "Published · the new version is live" : "Not published · the live version is unchanged");

  const turn: string[] = [];
  if (state.commit) turn.push(`commit \`${state.commit.slice(0, 10)}\``);
  turn.push(`${state.commitFiles} file${state.commitFiles === 1 ? "" : "s"} changed (+${state.additions}/−${state.deletions})`);
  turn.push(`⏱️ ${formatShortDuration(state.durationMs)}`);
  addCardField(card, "Turn", turn.join(" · "));

  if (state.usage) {
    const usage: string[] = [];
    if (state.usage.inputTokens || state.usage.outputTokens) {
      usage.push(`${formatTokens(state.usage.inputTokens)} in · ${formatTokens(state.usage.outputTokens)} out`);
    }
    if (state.usage.steps) usage.push(`${state.usage.steps} model step${state.usage.steps === 1 ? "" : "s"}`);
    if (state.usage.compactions) usage.push(`context compacted ${state.usage.compactions}×`);
    if (!state.usage.inputTokens && !state.usage.outputTokens) usage.push("Token counts unavailable");
    if (state.usage.cacheTokens) usage.push(`${formatTokens(state.usage.cacheTokens)} cached`);
    addCardField(card, "Usage", usage.join(" · "));
  } else {
    addCardField(card, "Usage", "Token counts unavailable");
  }

  if (state.findings?.length) {
    addCardField(card, "Browser QA", `Advisory · ${state.findings.length} finding${state.findings.length === 1 ? "" : "s"} — ${truncate(state.findings[0], 220)}`);
  }

  if (state.note) addCardField(card, "Note", truncate(state.note, 900));
  addCardLinks(card, [
    cardLink(state.kind === "site" ? "Open site" : "Play game", state.siteUrl),
    cardLink("Source", state.repoUrl),
    state.commit ? cardLink("View commit", `${state.repoUrl.replace(/\/$/, "")}/commit/${encodeURIComponent(state.commit)}`) : undefined,
  ]);
  if (state.resource) addCardLinks(card, [
    new ButtonBuilder().setCustomId(cardId("details", state.resource)).setLabel("Turn details").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cardId("details", state.resource, "files")).setLabel("Changed files").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cardId("details", state.resource, "qa")).setLabel("Browser findings").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cardId("change", state.resource)).setLabel("Follow up").setStyle(ButtonStyle.Primary),
  ]);
  return card;
}

/** Keep names and media descriptions on one line. */
function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Render authored markdown the way a reader expects it. The agent writes
 * with hard line breaks, and Discord shows every one of them: wrapped lines
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
