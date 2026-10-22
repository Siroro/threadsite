import assert from "node:assert/strict";
import { ComponentType, MessageFlags, type MessageEditOptions } from "discord.js";

export interface CardComponent {
  type: number;
  content?: string;
  accent_color?: number;
  components?: CardComponent[];
  accessory?: CardComponent;
  custom_id?: string;
  disabled?: boolean;
  label?: string;
  url?: string;
  style?: number;
}

export function cardComponents(message: Pick<MessageEditOptions, "components">): CardComponent[] {
  const flatten = (component: CardComponent): CardComponent[] => [component,
    ...(component.components ?? []).flatMap(flatten), ...(component.accessory ? flatten(component.accessory) : []),
  ];
  return (message.components ?? []).flatMap((component) => flatten(("toJSON" in component ? component.toJSON() : component) as CardComponent));
}

/** A reading view of the actual V2 tree, useful for asserting the facts visible to a user. */
export function cardView(message: Pick<MessageEditOptions, "components">) {
  const components = cardComponents(message);
  const texts = components.filter((component) => component.type === ComponentType.TextDisplay).map((component) => component.content!);
  const header = texts[0] ?? "";
  return {
    color: components.find((component) => component.type === ComponentType.Container)?.accent_color,
    title: header.match(/^## (.+)$/m)?.[1],
    description: texts.filter((text) => !text.startsWith("### ")).join("\n\n"),
    fields: texts.filter((text) => text.startsWith("### ")).map((text) => {
      const newline = text.indexOf("\n");
      return { name: text.slice(4, newline), value: text.slice(newline + 1) };
    }),
    footer: { text: texts.filter((text) => text.startsWith("-# ") && !text.includes("THREADSITE")).join("\n") },
    text: texts.join("\n\n"),
    components,
    buttons: components.filter((component) => component.type === ComponentType.Button),
  };
}

export function assertV2(message: MessageEditOptions): void {
  assert.ok(Number(message.flags) & MessageFlags.IsComponentsV2);
  assert.ok(!message.content, "V2 has no legacy message content");
  assert.ok(!message.embeds?.length, "V2 has no legacy embeds");
  assert.deepEqual(message.allowedMentions, { parse: [] });
  const components = cardComponents(message);
  assert.equal(components[0].type, ComponentType.Container);
  assert.ok(components.length <= 40, `${components.length} components exceeds Discord's limit`);
  const texts = components.filter((component) => component.type === ComponentType.TextDisplay);
  assert.ok(texts.every((text) => text.content!.length > 0));
  assert.ok(texts.reduce((sum, text) => sum + text.content!.length, 0) <= 4000);
  for (const row of components.filter((component) => component.type === ComponentType.ActionRow)) {
    assert.ok(row.components!.length > 0 && row.components!.length <= 5);
  }
}
