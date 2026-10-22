import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, ComponentType,
  MessageFlags, MessagePayload, type Message, type ModalSubmitInteraction, type TextBasedChannel,
} from "discord.js";
import { cardEdit, disableMessageControls, renderStatusCard, safeCardUrl } from "../src/card-ui.js";
import { cardId, parseCardId } from "../src/card-actions.js";
import { renderDetailPanel, renderQueuePanel, requestModal, textPages } from "../src/card-panels.js";
import { renderProgressCard, progressDetailSections } from "../src/progress-view.js";
import { answerModal, questionControls, readAnswerForm, renderQuestionReview } from "../src/question-ui.js";
import type { QuestionDraft } from "../src/card-state.js";
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

test("five full questions fit V2 limits, offer the answer form, and keep a scoped Stop", async () => {
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
    const render = () => renderProgressCard(state, { questionRows: progress.questionComponents(), stopCustomId: "threadsite:stop", resource: "questions" });
    const card = render();
    assertV2(card);
    const view = cardView(card);
    const questionButtons = view.buttons.filter((button) => button.custom_id?.startsWith("ts2:") && button.custom_id !== "ts2:stop:questions");
    assert.deepEqual(questionButtons.map((button) => button.label), [
      "Turn details", "Answer questions", "Review answers", "Write another answer", "Skip — let the agent decide", "Queue · 2",
    ], "multi-question requests offer the form instead of twenty buttons");
    const styles = Object.fromEntries(questionButtons.map((button) => [button.label, button.style]));
    assert.equal(styles["Answer questions"], ButtonStyle.Primary, "the answer form is a primary call to action");
    assert.equal(styles["Turn details"], ButtonStyle.Primary, "details matches Stop's neighbour slot in a different colour");
    for (const label of ["Review answers", "Write another answer", "Skip — let the agent decide", "Queue · 2"]) {
      assert.equal(styles[label], ButtonStyle.Secondary, `${label} stays secondary`);
    }
    const headRow = view.buttons.filter((button) => ["ts2:details:questions", "ts2:stop:questions"].includes(button.custom_id!));
    assert.deepEqual(headRow.map((button) => button.label), ["Turn details", "Stop turn"], "details sits directly beside Stop");
    assert.equal(headRow[0].style, ButtonStyle.Primary);
    assert.equal(headRow[1].style, ButtonStyle.Secondary, "Stop keeps the quieter colour so it is never the misclick");
    assert.ok(view.buttons.some((button) => button.custom_id === "ts2:stop:questions"), "the live card keeps a turn-scoped Stop");
    const answered = disableMessageControls(card as unknown as Pick<Message, "components">);
    assert.equal(cardView(answered).text, view.text, "acknowledging a control keeps every text section");
    assert.equal(cardView(answered).buttons.find((button) => button.custom_id === "ts2:stop:questions")?.disabled, undefined);
    assert.ok(cardView(answered).buttons.filter((button) => button.custom_id?.startsWith("ts2:") && button.custom_id !== "ts2:stop:questions").every((button) => button.disabled));
    progress.recordAnswer("q1", "Shane", "Option 1");
    progress.clearQuestion("q1");
    state.questions = undefined;
    state.questionPin = { requestID: "q1", question: "Pick an option", resolution: "Shane chose Option 1" };
    const resolved = render();
    assertV2(resolved);
    assert.equal(cardView(resolved).buttons.some((button) => button.label === "Answer questions"), false);
    assert.match(cardView(resolved).text, /Shane chose Option 1/);
  } finally { await progress.close(); }
});

test("simple questions answer with quick secondary buttons; long lists use a select", () => {
  const request = (options: number, multiple = false): import("../src/progress.js").AgentQuestion => ({
    requestID: "q2",
    questions: [{ header: "Pick", question: "Which one?", multiple, options: Array.from({ length: options }, (_, index) => ({ label: `Option ${index + 1}` })) }],
  });
  const quick = questionControls("turn", request(3));
  assert.equal(quick.length, 2);
  assert.deepEqual(quick[0].components.map((button) => button.toJSON().label), ["Option 1", "Option 2", "Option 3"]);
  assert.ok(quick[0].components.every((button) => button.toJSON().style === ButtonStyle.Secondary), "peer answers never compete for primary styling");
  const selected = quick[0].components.map((button) => button.toJSON().custom_id);
  assert.deepEqual(selected.map((id) => parseCardId(id!)?.action), ["answer", "answer", "answer"]);
  const listed = questionControls("turn", request(9));
  assert.equal(listed.length, 2);
  const menu = listed[0].components[0];
  assert.equal(menu.toJSON().type, ComponentType.StringSelect);
  assert.equal(menu.toJSON().max_values, 1);
  const multi = questionControls("turn", request(9, true));
  assert.equal(multi[0].components[0].toJSON().max_values, 9);
  const huge = questionControls("turn", request(30));
  assert.deepEqual(huge[0].components.map((button) => button.toJSON().label), ["Answer questions", "Review answers"]);
  const submitting = questionControls("turn", request(3), "submitting");
  assert.deepEqual(submitting[0].components.map((button) => button.toJSON().label), ["Check answer delivery"]);
  assert.deepEqual(questionControls("turn", request(3), "answered"), []);
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

test("the compact live card shows recent public narration; the private panel keeps all of it", () => {
  const state = buildingSnapshot();
  state.thought = undefined;
  state.narration = Array.from({ length: 7 }, (_, index) => ({ text: `Public update ${index + 1} — the part everyone may read.`, at: state.startedAt + (index + 1) * 1000, key: `n${index}` }));
  const message = renderProgressCard(state, { resource: "turn" });
  assertV2(message);
  const text = cardView(message).text;
  for (const update of state.narration.slice(-4)) assert.match(text, new RegExp(update.text.slice(0, 20).replaceAll("—", "—")), "recent updates stay public");
  assert.equal(text.includes("Public update 1 —"), false, "older updates move to the details panel instead of growing the card");
  const sections = progressDetailSections(state);
  const updates = sections.find((section) => section.key === "updates")!;
  for (const update of state.narration) assert.ok(updates.text.includes(update.text), "no public update is lost");
  const plan = sections.find((section) => section.key === "plan")!;
  assert.equal(plan.text.split("\n\n").length, state.plan.length, "the complete plan stays reachable");
  assert.equal(cardComponents(message).length <= 40, true);
});

test("detail panels paginate every character and keep section choice stable", () => {
  const sections = [
    { key: "report", label: "Full agent report", text: Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1} ${"content ".repeat(80)}`).join("\n\n") },
    { key: "usage", label: "Usage", text: "Input: 1\nOutput: 2" },
  ];
  const first = renderDetailPanel("Turn details", "turn", "turn", sections, "report", 0);
  assertV2(first);
  const firstView = cardView(first);
  assert.match(firstView.text, /Paragraph 1 /);
  assert.match(firstView.text, /page 1\//);
  const pageButtons = firstView.buttons.filter((button) => parseCardId(button.custom_id!)?.action === "page");
  assert.equal(pageButtons[0].disabled, true, "no previous page exists");
  const nextPage = parseCardId(pageButtons[2].custom_id!)!;
  assert.deepEqual(nextPage.args, ["turn", "report", "1"]);
  const second = renderDetailPanel("Turn details", "turn", "turn", sections, "report", 1);
  assertV2(second);
  assert.match(cardView(second).text, /page 2\//);
  assert.equal(cardView(second).buttons.find((button) => button.label === "Next")?.disabled, false, "long reports keep paging");
  const last = renderDetailPanel("Turn details", "turn", "turn", sections, "report", 99);
  assert.equal(cardView(last).buttons.find((button) => button.label === "Next")?.disabled, true, "an out-of-range page clamps to the last");
  assert.equal(cardView(last).buttons.find((button) => button.label === "Previous")?.disabled, false);
  const pageIds = [...cardView(first).buttons, ...cardView(second).buttons]
    .filter((button) => parseCardId(button.custom_id!)?.action === "page").map((button) => button.custom_id);
  assert.deepEqual([...new Set(pageIds)].sort(), [
    "ts2:page:turn:turn:report:0", "ts2:page:turn:turn:report:0:again", "ts2:page:turn:turn:report:1", "ts2:page:turn:turn:report:1:again", "ts2:page:turn:turn:report:2",
  ], "the refresh marker keeps every id in a row unique, even with a disabled Previous");
  const firstIds = cardView(first).buttons.map((button) => button.custom_id!);
  assert.equal(new Set(firstIds).size, firstIds.length, "page 0 never repeats a custom id");
  const whole = textPages(sections[0].text).join("");
  assert.equal(whole.includes("Paragraph 40 "), true, "pagination drops nothing");
  assert.ok(textPages(sections[0].text).every((page) => page.length <= 2800));
  const fallback = renderDetailPanel("Turn details", "turn", "turn", sections, "missing");
  assert.match(cardView(fallback).text, /Paragraph 1 /, "an unknown section falls back to the first");
});

test("the queue panel lists cancellable requests with working pagination", () => {
  const queue = Array.from({ length: 7 }, (_, index) => ({
    prompt: `Request number ${index + 1} `.repeat(10), statusMessageId: `1100000000000000${index}`, author: { name: `User ${index}`, id: String(index) },
  }));
  const page = renderQueuePanel("turn", queue as never, 1, 0);
  assertV2(page);
  const view = cardView(page);
  assert.match(view.text, /7 saved requests · 1 already being prepared/);
  const cancelIds = view.buttons.filter((button) => parseCardId(button.custom_id!)?.action === "cancel").map((button) => parseCardId(button.custom_id!)!.args[0]);
  assert.deepEqual(cancelIds, queue.slice(0, 5).map((entry) => entry.statusMessageId));
  const last = renderQueuePanel("turn", queue as never, 0, 1);
  const lastIds = cardView(last).buttons.filter((button) => parseCardId(button.custom_id!)?.action === "cancel").map((button) => parseCardId(button.custom_id!)!.args[0]);
  assert.deepEqual(lastIds, queue.slice(5).map((entry) => entry.statusMessageId));
  assert.match(cardView(last).text, /Request number 7/);
});

test("the request modal carries the nonce route, prompt field, and bounded image uploads", () => {
  const modal = requestModal("turn", "nonce123");
  assert.equal(modal.toJSON().custom_id, "ts2:request:turn:nonce123");
  const labels = modal.toJSON().components.map((label) => label.label);
  assert.deepEqual(labels, ["What would you like to change?", "Reference images (optional)"]);
  const upload = modal.toJSON().components[1].component;
  assert.equal(upload.type, ComponentType.FileUpload);
  assert.equal(upload.max_values, 4);
  assert.equal(upload.required, false);
});

test("answer modals mix radio, checkbox, select and text controls per question", () => {
  const request = {
    requestID: "q9",
    questions: [
      { header: "Pick one", question: "Single choice?", options: Array.from({ length: 3 }, (_, index) => ({ label: `Option ${index + 1}` })) },
      { header: "Pick many", question: "Multiple choice?", multiple: true, options: Array.from({ length: 4 }, (_, index) => ({ label: `Option ${index + 1}` })) },
      { header: "Pick from many", question: "Long list?", options: Array.from({ length: 12 }, (_, index) => ({ label: `Option ${index + 1}` })) },
      { header: "Write it", question: "Free text?", options: [] },
    ],
  };
  const draft: QuestionDraft = { requestID: "q9", answers: [[], [], [], ["Typed earlier"]] };
  const modal = answerModal("turn", request as never, draft, 0);
  const data = modal.toJSON();
  assert.equal(data.custom_id, "ts2:form:turn:q9:0");
  const kinds = data.components.map((label) => label.component.type);
  assert.deepEqual(kinds, [ComponentType.RadioGroup, ComponentType.CheckboxGroup, ComponentType.StringSelect, ComponentType.TextInput], "each question gets its native control");
  const radio = data.components[0].component;
  assert.equal(radio.options.length, 4, "three choices plus the custom-answer escape");
  assert.equal(radio.options.at(-1).value, "other");
  const text = data.components[3].component;
  assert.equal(text.value, "Typed earlier", "an existing draft pre-fills the text input");
  assert.equal(data.components.length, 4, "a second page exists for the fifth question");
});

test("reading the form keeps a draft when only the custom escape is selected", () => {
  const request = {
    requestID: "q10",
    questions: [
      { header: "Pick many", question: "Multiple choice?", multiple: true, options: [{ label: "Alpha" }, { label: "Beta" }] },
    ],
  };
  const fields = {
    getCheckboxGroup: () => new Set(["other"]),
    getRadioGroup: () => "0",
    getStringSelectValues: () => ["1"],
    getTextInputValue: () => "  My own words  ",
  };
  const read = readAnswerForm({ fields } as unknown as ModalSubmitInteraction, request as never, 0);
  assert.deepEqual([...read.answers.keys()], [], "an other-only pass clears nothing");
  assert.deepEqual(read.custom, [0]);
  const replaced = readAnswerForm({ fields: { ...fields, getCheckboxGroup: () => new Set(["0", "other"]) } } as unknown as ModalSubmitInteraction, request as never, 0);
  assert.deepEqual(replaced.answers.get(0), ["Alpha"]);
  assert.deepEqual(replaced.custom, [0]);
  const textOnly = readAnswerForm({ fields } as unknown as ModalSubmitInteraction, { requestID: "q11", questions: [{ header: "Write", question: "Free text?", options: [] }] } as never, 0);
  assert.deepEqual(textOnly.answers.get(0), ["My own words"]);
});

test("the review card reflects draft progress and disables submission until complete", () => {
  const request = {
    requestID: "q12",
    questions: [
      { header: "One", question: "First?", options: [{ label: "A" }] },
      { header: "Two", question: "Second?", options: [{ label: "B" }] },
    ],
  };
  const partial: QuestionDraft = { requestID: "q12", answers: [["A"], []] };
  const partialView = cardView(renderQuestionReview("turn", request as never, partial, 1));
  assert.equal(partialView.buttons.find((button) => button.label === "Submit all answers")?.disabled, true);
  assert.match(partialView.text, /1\/2 answered/);
  const complete: QuestionDraft = { requestID: "q12", answers: [["A"], ["B"]] };
  const completeView = cardView(renderQuestionReview("turn", request as never, complete, 0));
  assert.notEqual(completeView.buttons.find((button) => button.label === "Submit all answers")?.disabled, true);
  assert.match(completeView.text, /2\/2 answered/);
  const retry: QuestionDraft = { requestID: "q12", answers: [["A"], ["B"]] };
  const retryView = cardView(renderQuestionReview("turn", request as never, retry, 0, { requestID: "q12", status: "retry", error: "The agent is still waiting." }));
  assert.notEqual(retryView.buttons.find((button) => button.label === "Submit all answers")?.disabled, true, "a failed delivery offers submit again");
  assert.match(retryView.text, /The agent is still waiting/);
  const busy: QuestionDraft = { requestID: "q12", answers: [["A"], ["B"]] };
  const busyView = cardView(renderQuestionReview("turn", request as never, busy, 0, { requestID: "q12", status: "submitting" }));
  assert.equal(busyView.buttons.find((button) => button.label === "Submit all answers")?.disabled, true, "delivery in flight cannot double-submit");
});

test("the live card keeps turn details beside Stop and metrics in the footer", () => {
  const message = renderProgressCard(buildingSnapshot(), { resource: "turn", stopCustomId: "threadsite:stop" });
  assertV2(message);
  const view = cardView(message);
  const headRow = view.buttons.filter((button) => ["ts2:details:turn", "ts2:stop:turn"].includes(button.custom_id!));
  assert.deepEqual(headRow.map((button) => button.label), ["Turn details", "Stop turn"], "details sits directly beside Stop at the top");
  assert.equal(headRow[0].style, ButtonStyle.Primary, "details is the primary colour");
  assert.equal(headRow[1].style, ButtonStyle.Secondary, "Stop stays grey so the pair can't be confused");
  assert.match(view.footer.text, /Elapsed 2m 14s · 12 model steps · 28\.4k\/100k context · avg ~54 tok\/s/);
  assert.doesNotMatch(view.footer.text, /actions/, "the footer counts model steps, not actions");
  const controls = view.buttons.filter((button) => button.custom_id?.startsWith("ts2:") && button.custom_id !== "ts2:stop:turn" && button.custom_id !== "ts2:details:turn").map((button) => button.label);
  assert.deepEqual(controls, ["Add instruction", "Queue · 2"], "the lower row stays actions and links only");
});

test("the thinking trail stays off the public card and pages into the private details", async () => {
  const progress = new DiscordProgress({ id: "thinking", edit: async () => {} } as unknown as Message, "Updating");
  try {
    progress.callback({ kind: "thinking", text: "SECRET DELIBERATION", narrationId: "r1" });
    progress.callback({ kind: "thinking", text: "SECRET DELIBERATION — now weighing the shove physics", narrationId: "r1" });
    progress.callback({ kind: "thought", text: "PUBLIC NARRATION LINE about the arena", narrationId: "t1" });
    const state = progress.readSnapshot();
    assert.equal(state.reasoning?.length, 1, "a growing reasoning part replaces its draft in place");
    assert.match(state.reasoning![0].text, /shove physics/);
    const card = renderProgressCard(state, { resource: "thinking" });
    assertV2(card);
    const text = cardView(card).text;
    assert.doesNotMatch(text, /SECRET DELIBERATION/, "raw reasoning never renders on the public card");
    assert.match(text, /PUBLIC NARRATION LINE/);
    const sections = progressDetailSections(state);
    assert.match(sections.find((section) => section.key === "thinking")!.text, /SECRET DELIBERATION/);
    const panel = renderDetailPanel("Turn details", "thinking", "turn", sections, "thinking");
    assertV2(panel);
    assert.match(cardView(panel).text, /shove physics/, "the private panel pages the full trail");
  } finally { await progress.close(); }
});

test("card action ids round-trip and reject hostile or oversized parts", () => {
  const id = cardId("answer", "123456789012345678", "req-1", 3);
  assert.equal(id, "ts2:answer:123456789012345678:req-1:3");
  assert.deepEqual(parseCardId(id), { action: "answer", resource: "123456789012345678", args: ["req-1", "3"] });
  assert.equal(parseCardId("ts1:answer:resource"), undefined, "old versions are not routed");
  assert.equal(parseCardId("ts2:unknown:resource"), undefined);
  assert.equal(parseCardId("ts2:answer:resource/../../etc"), undefined);
  assert.throws(() => cardId("answer", "with spaces"), /Invalid card action identifier/);
  assert.throws(() => cardId("answer", "x".repeat(120)), /too long/);
});
