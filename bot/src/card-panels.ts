import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, CheckboxBuilder, ContainerBuilder, FileUploadBuilder, LabelBuilder,
  ModalBuilder, StringSelectMenuBuilder, TextDisplayBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";
import { cardId } from "./card-actions.js";
import { addCardDivider, addCardHeader, cardMessage, type CardMessage } from "./card-ui.js";
import { plain } from "./progress-view.js";
import type { QueuedRequest } from "./types.js";

export interface PanelSection { key: string; label: string; text: string }
export type PanelScope = "turn" | "project" | "doc";

/** Pagination preserves every character; public cards can be concise without losing their data. */
export function textPages(text: string, limit = 2800): string[] {
  const pages: string[] = [];
  while (text.length > limit) {
    const newline = text.lastIndexOf("\n", limit);
    let end = newline > limit / 2 ? newline + 1 : limit;
    const before = text.slice(0, end);
    if ((before.match(/```/g)?.length ?? 0) % 2 === 1) {
      // The cut lands inside a fenced code block: an unclosed fence would
      // swallow the rest of the page into code rendering, so back the cut up
      // to the opening fence's line and let the block start fresh on the next
      // page. A fence at the very top (or longer than a page) cannot move and
      // is cut as before.
      const opener = before.lastIndexOf("```");
      const lineStart = before.lastIndexOf("\n", opener) + 1;
      if (lineStart > 0) end = lineStart;
    }
    if (end <= 0) end = limit;
    pages.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text || !pages.length) pages.push(text || "No information has been recorded yet.");
  return pages;
}

export function renderDetailPanel(title: string, resource: string, scope: PanelScope, sections: PanelSection[], selected?: string, page = 0): CardMessage {
  if (!sections.length) sections = [{ key: "empty", label: "Details", text: "No information was recorded for this view." }];
  const section = sections.find((entry) => entry.key === selected) ?? sections[0];
  const pages = textPages(section.text);
  page = Math.min(pages.length - 1, Math.max(0, Number.isSafeInteger(page) ? page : 0));
  const card = new ContainerBuilder().setAccentColor(0x5865f2);
  addCardHeader(card, "DETAILS", title, `${section.label} · page ${page + 1}/${pages.length}`);
  card.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(cardId("tab", resource, scope)).setPlaceholder("Choose what to inspect")
      .addOptions(sections.map((entry) => ({ label: entry.label, value: entry.key, default: entry.key === section.key }))),
  ));
  addCardDivider(card);
  card.addTextDisplayComponents(new TextDisplayBuilder().setContent(pages[page]));
  card.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(cardId("page", resource, scope, section.key, Math.max(0, page - 1))).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    // The extra marker keeps Refresh's id unique: on page 0 it would otherwise
    // equal the disabled Previous id, which Discord rejects as a duplicate.
    new ButtonBuilder().setCustomId(cardId("page", resource, scope, section.key, page, "again")).setLabel("Refresh").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cardId("page", resource, scope, section.key, page + 1)).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(page === pages.length - 1),
  ));
  return cardMessage(card);
}

export function requestModal(resource: string, nonce: string, steer = false): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(cardId("request", resource, nonce)).setTitle(steer ? "Add an instruction to this turn" : "Request a project change")
    .addLabelComponents(
      new LabelBuilder().setLabel(steer ? "What should the agent change?" : "What would you like to change?")
        .setDescription(steer ? "If this turn has finished, your request will be queued." : "Your request uses this project's normal update queue.")
        .setTextInputComponent(new TextInputBuilder().setCustomId("prompt").setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(true)),
      new LabelBuilder().setLabel("Attachments (optional)").setDescription("Images reach the model when it supports them; other files are saved into the project workspace.")
        .setFileUploadComponent(new FileUploadBuilder().setCustomId("images").setMinValues(0).setMaxValues(4).setRequired(false)),
    );
  if (steer) {
    modal.addLabelComponents(
      new LabelBuilder().setLabel("Stop and restart this turn")
        .setDescription("Stop the turn instead (partial edits kept) and continue it in this card with your instruction.")
        .setCheckboxComponent(new CheckboxBuilder().setCustomId("restart").setDefault(false)),
    );
  }
  return modal;
}

export function renderQueuePanel(resource: string, queue: QueuedRequest[], preparing: number, page = 0): CardMessage {
  const pageCount = Math.max(1, Math.ceil(queue.length / 5));
  page = Math.max(0, Math.min(pageCount - 1, Number.isSafeInteger(page) ? page : 0));
  const card = new ContainerBuilder().setAccentColor(0x64748b);
  addCardHeader(card, "QUEUE", "Next update pass", `${queue.length} saved request${queue.length === 1 ? "" : "s"} · ${preparing} already being prepared`);
  const listed = queue.slice(page * 5, page * 5 + 5);
  if (!listed.length) card.addTextDisplayComponents(new TextDisplayBuilder().setContent("Nothing else is queued. Requests already being prepared can be interrupted with Stop."));
  for (const [index, request] of listed.entries()) {
    const attached = [
      request.images?.length ? `${request.images.length} image${request.images.length === 1 ? "" : "s"}` : "",
      request.files?.length ? `${request.files.length} file${request.files.length === 1 ? "" : "s"}` : "",
    ].filter(Boolean).join(" + ");
    addCardDivider(card);
    card.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${page * 5 + index + 1}. ${plain(request.author?.name ?? "Saved request", 60)}**${attached ? ` · ${attached}` : ""}\n${plain(request.prompt, 420)}`));
    card.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(cardId("cancel", resource, request.statusMessageId)).setLabel(`Cancel request ${page * 5 + index + 1}`).setStyle(ButtonStyle.Secondary),
    ));
  }
  card.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(cardId("queue", resource, Math.max(0, page - 1))).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(cardId("queue", resource, page, "again")).setLabel("Refresh queue").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cardId("queue", resource, page + 1)).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(page === pageCount - 1),
  ));
  return cardMessage(card);
}
