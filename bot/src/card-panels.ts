import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, FileUploadBuilder, LabelBuilder,
  ModalBuilder, StringSelectMenuBuilder, TextDisplayBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";
import { cardId } from "./card-actions.js";
import { addCardDivider, addCardHeader, cardMessage, type CardMessage } from "./card-ui.js";
import type { QueuedRequest } from "./types.js";
import { truncate } from "./util.js";

export interface PanelSection { key: string; label: string; text: string }
export type PanelScope = "turn" | "project" | "doc";

/** Pagination preserves every character; public cards can be concise without losing their data. */
export function textPages(text: string, limit = 2800): string[] {
  const pages: string[] = [];
  while (text.length > limit) {
    const newline = text.lastIndexOf("\n", limit);
    const end = newline > limit / 2 ? newline + 1 : limit;
    pages.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text || !pages.length) pages.push(text || "No information has been recorded yet.");
  return pages;
}

export function renderDetailPanel(title: string, resource: string, scope: PanelScope, sections: PanelSection[], selected?: string, page = 0): CardMessage {
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
  return new ModalBuilder().setCustomId(cardId("request", resource, nonce)).setTitle(steer ? "Add an instruction to this turn" : "Request a project change")
    .addLabelComponents(
      new LabelBuilder().setLabel(steer ? "What should the agent change?" : "What would you like to change?")
        .setDescription(steer ? "If this turn has finished, your request will be queued." : "Your request uses this project's normal update queue.")
        .setTextInputComponent(new TextInputBuilder().setCustomId("prompt").setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(true)),
      new LabelBuilder().setLabel("Reference images (optional)").setDescription("Images are sent only when the project's model supports them.")
        .setFileUploadComponent(new FileUploadBuilder().setCustomId("images").setMinValues(0).setMaxValues(4).setRequired(false)),
    );
}

export function renderQueuePanel(resource: string, queue: QueuedRequest[], preparing: number, page = 0): CardMessage {
  const pageCount = Math.max(1, Math.ceil(queue.length / 5));
  page = Math.max(0, Math.min(pageCount - 1, Number.isSafeInteger(page) ? page : 0));
  const card = new ContainerBuilder().setAccentColor(0x64748b);
  addCardHeader(card, "QUEUE", "Next update pass", `${queue.length} saved request${queue.length === 1 ? "" : "s"} · ${preparing} already being prepared`);
  const listed = queue.slice(page * 5, page * 5 + 5);
  if (!listed.length) card.addTextDisplayComponents(new TextDisplayBuilder().setContent("Nothing else is queued. Requests already being prepared can be interrupted with Stop."));
  for (const [index, request] of listed.entries()) {
    addCardDivider(card);
    card.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${page * 5 + index + 1}. ${truncate(request.author?.name ?? "Saved request", 60)}**${request.images?.length ? ` · ${request.images.length} image(s)` : ""}\n${truncate(request.prompt, 420)}`));
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
