import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, ComponentType,
  MessageFlags, MessagePayload, type Message, type TextBasedChannel,
} from "discord.js";
import { cardEdit, disableMessageControls, renderStatusCard, safeCardUrl } from "../src/card-ui.js";
import { renderProgressCard } from "../src/progress-view.js";
import { buildingSnapshot } from "./fixtures/progress.js";
import { assertV2, cardComponents, cardView } from "./fixtures/cards.js";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const { DiscordProgress } = await import("../src/progress.js");

test("the Discord wire payload clears legacy content and embeds when a status becomes V2", () => {
  const client = new Client({ intents: [] });
  const target = { client } as TextBasedChannel;
  const card = renderProgressCard(buildingSnapshot(), { stopCustomId: "threadsite:stop" });
  const create = MessagePayload.create(target, card).resolveBody().body!;
  assert.equal(create.flags, MessageFlags.IsComponentsV2);
  assert.equal(create.content, undefined);
  assert.equal(create.embeds, undefined);
  const edit = MessagePayload.create(target, cardEdit(card)).resolveBody().body!;
  assert.equal(edit.flags, MessageFlags.IsComponentsV2);
  assert.equal(edit.content, "");
  assert.deepEqual(edit.embeds, []);
  assert.equal(edit.components![0].type, ComponentType.Container);
  assert.deepEqual(edit.allowed_mentions, { parse: [] });
});

test("five full questions fit V2 limits, keep Stop, and place each answer row below its question", async () => {
  const progress = new DiscordProgress({ id: "questions", edit: async () => {} } as unknown as Message, "Updating");
  try {
    progress.callback({ kind: "question", text: "Choose an option", question: {
      requestID: "q1",
      questions: Array.from({ length: 5 }, (_, index) => ({ header: `Decision ${index + 1}`,
        question: "Pick an option ".repeat(100), options: Array.from({ length: 4 }, (_, option) => ({
          label: `Option ${option + 1}`, description: "A long explanation ".repeat(100),
        })),
      })),
    } });
    const state = buildingSnapshot();
    state.questions = progress.pendingQuestion("q1")!.questions;
    const render = () => renderProgressCard(state, { questionRows: progress.questionComponents(), stopCustomId: "threadsite:stop" });
    const card = render();
    assertV2(card);
    const view = cardView(card);
    assert.equal(view.buttons.length, 22, "twenty answers, one Skip, and Stop");
    const children = card.components[0].toJSON().components;
    for (const [index, child] of children.entries()) {
      if (child.type === ComponentType.TextDisplay && child.content.startsWith("### ❓")) {
        assert.equal(children[index + 1].type, ComponentType.ActionRow);
      }
    }
    const answered = disableMessageControls(card as unknown as Pick<Message, "components">);
    assert.equal(cardView(answered).text, view.text, "acknowledging a button keeps every text section");
    assert.equal(cardView(answered).buttons.find((button) => button.custom_id === "threadsite:stop")?.disabled, undefined);
    assert.ok(cardView(answered).buttons.filter((button) => button.custom_id?.startsWith("q")).every((button) => button.disabled));
    progress.recordAnswer("q1", "Shane", "Option 1");
    progress.clearQuestion("q1");
    state.questions = undefined;
    state.questionPin = { question: "Pick an option", resolution: "Shane chose Option 1" };
    const resolved = render();
    assertV2(resolved);
    assert.equal(cardView(resolved).buttons.some((button) => button.custom_id?.startsWith("q")), false);
    assert.match(cardView(resolved).text, /Shane chose Option 1/);
  } finally { await progress.close(); }
});

test("failure, reset, merge and cancellation outcomes replace live controls without leaving V2", () => {
  const choices = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("threadsite:rollback").setLabel("Rollback edits").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("threadsite:keep").setLabel("Keep edits").setStyle(ButtonStyle.Success),
  );
  for (const text of ["❌ Turn failed", "🛑 Stopped by reset", "🔗 Merged into the update above", "🚫 Cancelled"]) {
    const message = cardEdit(renderStatusCard(text, text.includes("failed") ? [choices] : []));
    assertV2(message);
    assert.equal(message.content, null);
    assert.match(cardView(message).text, new RegExp(text));
    assert.equal(cardView(message).buttons.some((button) => button.custom_id === "threadsite:stop"), false);
    const disabled = disableMessageControls(message as unknown as Pick<Message, "components">);
    assert.equal(cardView(disabled).text, cardView(message).text);
    assert.ok(cardView(disabled).buttons.every((button) => button.disabled));
  }
});

test("button acknowledgements preserve a media gallery and leave navigation links active", () => {
  const message = { components: [{ toJSON: () => ({ type: ComponentType.Container, components: [
    { type: ComponentType.MediaGallery, items: [{ media: { url: "https://example.invalid/preview.png" } }] },
    { type: ComponentType.ActionRow, components: [
      { type: ComponentType.Button, style: ButtonStyle.Primary, custom_id: "choose", label: "Choose" },
      { type: ComponentType.Button, style: ButtonStyle.Link, url: "https://example.invalid/", label: "Open site" },
    ] },
  ] }) }] } as unknown as Pick<Message, "components">;
  const disabled = disableMessageControls(message);
  assert.ok(cardComponents(disabled).some((component) => component.type === ComponentType.MediaGallery));
  const buttons = cardView(disabled).buttons;
  assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[1].disabled, undefined);
});

test("invalid and oversized URLs never become Discord buttons", () => {
  for (const raw of ["javascript:alert(1)", "ftp://example.invalid/", "https://user:password@example.invalid/", `https://example.invalid/${"x".repeat(512)}`]) {
    assert.equal(safeCardUrl(raw), undefined);
  }
});

test("every phase keeps a valid V2 payload with long plans, paths, history and public narration", () => {
  for (const phase of ["queued", "preparing", "working", "checking", "publishing"] as const) {
    const state = buildingSnapshot();
    const long = "[@everyone](https://example.invalid) *** ".repeat(100);
    state.phase = phase;
    state.context.request = long;
    state.title = long;
    state.thought = long;
    state.latest = { ...state.latest, text: long, detail: long };
    state.plan = Array.from({ length: 100 }, () => ({ content: long, status: "pending" }));
    state.history = Array.from({ length: 10 }, () => ({ text: long, detail: long, at: state.startedAt }));
    state.files!.paths = Array.from({ length: 10 }, () => long);
    const message = renderProgressCard(state, { stopCustomId: "threadsite:stop" });
    assertV2(message);
    assert.ok(cardView(message).buttons.some((button) => button.custom_id === "threadsite:stop"));
    assert.equal((cardView(message).title!.match(/\n/g) ?? []).length, 0);
  }
});
