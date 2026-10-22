import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, ContainerBuilder, escapeMarkdown,
  MessageFlags, SectionBuilder, SeparatorBuilder, TextDisplayBuilder, ThumbnailBuilder,
  type APIComponentInContainer, type AttachmentBuilder, type Message, type MessageEditOptions,
} from "discord.js";
import type { ProjectKind } from "./types.js";
import { truncate } from "./util.js";

export const CARD_TEXT_LIMIT = 4000;
export const KIND_COLORS: Record<ProjectKind, number> = { site: 0x5865f2, "game-2d": 0x22c55e, "game-3d": 0x8b5cf6 };

export interface CardMessage {
  components: [ContainerBuilder];
  flags: typeof MessageFlags.IsComponentsV2;
  allowedMentions: { parse: [] };
  files?: AttachmentBuilder[];
}

export function cardTitle(value: string): string {
  return escapeMarkdown(truncate(value.replace(/\s+/g, " ").trim(), 180));
}

export function addCardHeader(card: ContainerBuilder, label: string, title: string, status: string, accessory?: ButtonBuilder | ThumbnailBuilder): void {
  const text = new TextDisplayBuilder().setContent(`-# THREADSITE · ${label}\n## ${cardTitle(title)}\n${status}`);
  if (accessory instanceof ButtonBuilder) card.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text).setButtonAccessory(accessory));
  else if (accessory) card.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text).setThumbnailAccessory(accessory));
  else card.addTextDisplayComponents(text);
}

/**
 * A title-led header for cards whose own name is the brand: the project title
 * (emoji included) leads the card in the small line, with no THREADSITE label
 * and no big heading below it.
 */
export function addCardTitle(card: ContainerBuilder, title: string, status: string, accessory?: ButtonBuilder | ThumbnailBuilder): void {
  const text = new TextDisplayBuilder().setContent(`-# ${cardTitle(title)}\n${status}`);
  if (accessory instanceof ButtonBuilder) card.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text).setButtonAccessory(accessory));
  else if (accessory) card.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text).setThumbnailAccessory(accessory));
  else card.addTextDisplayComponents(text);
}

export function addCardField(card: ContainerBuilder, name: string, value: string): void {
  card.addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${name}\n${value}`));
}

export function addCardDivider(card: ContainerBuilder): void {
  card.addSeparatorComponents(new SeparatorBuilder());
}

/** Button URLs must use http(s), without credentials, within Discord's limit. */
export function safeCardUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.href.length > 512) return undefined;
    return url.href;
  } catch { return undefined; }
}

export function cardLink(label: string, raw?: string): ButtonBuilder | undefined {
  const url = safeCardUrl(raw);
  return url ? new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url) : undefined;
}

export function addCardLinks(card: ContainerBuilder, links: Array<ButtonBuilder | undefined>): void {
  const buttons = links.filter((button): button is ButtonBuilder => Boolean(button));
  if (buttons.length) card.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
}

function textDisplays(card: ContainerBuilder): TextDisplayBuilder[] {
  return card.components.flatMap((component) => component instanceof TextDisplayBuilder ? [component]
    : component instanceof SectionBuilder ? component.components.filter((text): text is TextDisplayBuilder => text instanceof TextDisplayBuilder) : []);
}

export function cardTextLength(card: ContainerBuilder): number {
  return textDisplays(card).reduce((sum, text) => sum + (text.data.content?.length ?? 0), 0);
}

/** Bound the combined text, including section accessories' neighbouring text. Keep every control. */
export function cardMessage(card: ContainerBuilder): CardMessage {
  const displays = textDisplays(card);
  let excess = cardTextLength(card) - CARD_TEXT_LIMIT;
  while (excess > 0) {
    const longest = displays.reduce((a, b) => (a.data.content?.length ?? 0) >= (b.data.content?.length ?? 0) ? a : b);
    const text = longest.data.content!;
    const removed = Math.min(excess, Math.max(1, Math.floor(text.length / 3)));
    longest.setContent(truncate(text, text.length - removed));
    excess -= removed;
  }
  return { components: [card], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

/** Clear legacy content/embeds when upgrading an existing message; replace all old controls. */
export function cardEdit(message: CardMessage): MessageEditOptions {
  return { ...message, content: null, embeds: [], attachments: [] };
}

/** Acknowledging a click must preserve V2 text/media, which live inside components too. */
export function disableMessageControls(message: Pick<Message, "components">): MessageEditOptions {
  // Both stop generations stay usable: a stopped turn is the one ack that
  // must never be locked out by a disabled control.
  const keepEnabled = (customId?: string) => customId === "threadsite:stop" || customId?.startsWith("ts2:stop:");
  const disable = (component: APIComponentInContainer): APIComponentInContainer => {
    if (component.type === ComponentType.ActionRow) return {
      ...component, components: component.components.map((control) => "custom_id" in control && !keepEnabled(control.custom_id) ? { ...control, disabled: true } : control),
    };
    if (component.type === ComponentType.Section && "custom_id" in component.accessory && !keepEnabled(component.accessory.custom_id)) return {
      ...component, accessory: { ...component.accessory, disabled: true },
    };
    return component;
  };
  return { components: message.components.map((component) => {
    const data = component.toJSON();
    return data.type === ComponentType.Container ? { ...data, components: data.components.map(disable) } : disable(data);
  }) };
}

/** Terminal outcomes also stay V2: Discord does not allow reverting a V2 message to content. */
export function renderStatusCard(content: string, rows: ActionRowBuilder<ButtonBuilder>[] = []): CardMessage {
  const color = /❌|🚫|failed/i.test(content) ? 0xef4444 : /⚠️|🛑|stopped/i.test(content) ? 0xf59e0b : 0x64748b;
  const card = new ContainerBuilder().setAccentColor(color);
  card.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# THREADSITE · TURN UPDATE\n${truncate(content || "Turn finished.", 3900)}`));
  if (rows.length) { addCardDivider(card); card.addActionRowComponents(...rows); }
  return cardMessage(card);
}
