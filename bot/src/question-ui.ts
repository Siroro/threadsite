import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, CheckboxGroupBuilder, ContainerBuilder, LabelBuilder,
  ModalBuilder, RadioGroupBuilder, StringSelectMenuBuilder, TextDisplayBuilder, TextInputBuilder, TextInputStyle,
  type MessageActionRowComponentBuilder, type ModalSubmitInteraction,
} from "discord.js";
import { cardId } from "./card-actions.js";
import { addCardDivider, addCardHeader, cardMessage, type CardMessage } from "./card-ui.js";
import type { QuestionDelivery, QuestionDraft, QuestionStatus } from "./card-state.js";
import type { AgentQuestion } from "./progress.js";
import { truncate } from "./util.js";

export type QuestionRow = ActionRowBuilder<MessageActionRowComponentBuilder>;
const button = (id: string, label: string, primary = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(primary ? ButtonStyle.Primary : ButtonStyle.Secondary);

export function questionControls(resource: string, request: AgentQuestion, status: QuestionStatus = "ready"): QuestionRow[] {
  const revision = request.requestID;
  if (status === "submitting") return [new ActionRowBuilder<ButtonBuilder>().addComponents(button(cardId("retry", resource, revision), "Check answer delivery"))];
  if (status === "answered" || status === "skipped") return [];
  const question = request.questions[0];
  if (!question) return [];
  const rows: QuestionRow[] = [];
  if (request.questions.length === 1 && !question.multiple && question.options.length > 0 && question.options.length <= 4 && question.options.every((option) => option.label.length <= 80)) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(question.options.map((option, index) => button(cardId("answer", resource, revision, index), option.label))));
  } else if (request.questions.length === 1 && question.options.length > 0 && question.options.length <= 25) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(cardId("select", resource, revision, 0)).setPlaceholder(question.multiple ? "Choose one or more answers, then review" : "Choose an answer, then review")
        .setMinValues(1).setMaxValues(question.multiple ? question.options.length : 1)
        .addOptions(question.options.map((option, index) => ({ label: truncate(option.label, 100), value: String(index), description: option.description ? truncate(option.description, 100) : undefined }))),
    ));
  } else {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button(cardId("questions", resource, revision, 0), "Answer questions", true), button(cardId("review", resource, revision, 0), "Review answers")));
  }
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(cardId("other", resource, revision, 0), "Write another answer"),
    button(cardId("skip", resource, revision), "Skip — let the agent decide"),
  ));
  return rows;
}

function formKind(question: AgentQuestion["questions"][number]): "radio" | "checkbox" | "select" | "text" {
  if (!question.options.length || question.options.length > 25) return "text";
  if (question.multiple) return question.options.length < 10 ? "checkbox" : "select";
  return question.options.length < 10 ? "radio" : "select";
}

export function answerModal(resource: string, request: AgentQuestion, draft: QuestionDraft, page = 0): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(cardId("form", resource, request.requestID, page)).setTitle(`Answer questions · ${page + 1}/${Math.ceil(request.questions.length / 5)}`);
  for (let index = page * 5; index < Math.min(request.questions.length, page * 5 + 5); index++) {
    const question = request.questions[index];
    const label = new LabelBuilder().setLabel(truncate(question.header || `Question ${index + 1}`, 45)).setDescription(truncate(question.question, 100));
    const selected = draft.answers[index] ?? [];
    const kind = formKind(question);
    const options = question.options.map((option, optionIndex) => ({ label: truncate(option.label, 100), value: String(optionIndex), description: option.description ? truncate(option.description, 100) : undefined, default: selected.includes(option.label) }));
    if (options.length < (kind === "select" ? 25 : 10)) options.push({ label: "Write another answer…", value: "other", description: "Continue to enter a custom answer.", default: false });
    if (kind === "text") label.setTextInputComponent(new TextInputBuilder().setCustomId(`q${index}`).setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setValue(selected.join("\n")).setRequired(true));
    else if (kind === "radio") label.setRadioGroupComponent(new RadioGroupBuilder().setCustomId(`q${index}`).addOptions(options));
    else if (kind === "checkbox") label.setCheckboxGroupComponent(new CheckboxGroupBuilder().setCustomId(`q${index}`).setMinValues(1).setMaxValues(options.length).addOptions(options));
    else label.setStringSelectMenuComponent(new StringSelectMenuBuilder().setCustomId(`q${index}`).setMinValues(1).setMaxValues(question.multiple ? options.length : 1).addOptions(options));
    modal.addLabelComponents(label);
  }
  return modal;
}

export function customAnswerModal(resource: string, request: AgentQuestion, index: number, draft: QuestionDraft): ModalBuilder {
  const question = request.questions[index];
  if (!question) throw new Error("That question is no longer available.");
  return new ModalBuilder().setCustomId(cardId("custom", resource, request.requestID, index)).setTitle("Write another answer")
    .addLabelComponents(new LabelBuilder().setLabel(truncate(question.header || "Your answer", 45)).setDescription(truncate(question.question, 100))
      .setTextInputComponent(new TextInputBuilder().setCustomId("answer").setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(true).setValue((draft.answers[index] ?? []).join("\n"))));
}

/** Parse every field before touching a draft. Invalid modal data cannot partially replace saved answers. */
export function readAnswerForm(interaction: ModalSubmitInteraction, request: AgentQuestion, page: number): { answers: Map<number, string[]>; custom: number[] } {
  if (!Number.isSafeInteger(page) || page < 0 || page * 5 >= request.questions.length) throw new Error("That question page is no longer available.");
  const answers = new Map<number, string[]>();
  const custom: number[] = [];
  for (let index = page * 5; index < Math.min(request.questions.length, page * 5 + 5); index++) {
    const question = request.questions[index];
    const kind = formKind(question);
    if (kind === "text") { answers.set(index, [interaction.fields.getTextInputValue(`q${index}`).trim()]); continue; }
    const values = kind === "radio" ? [interaction.fields.getRadioGroup(`q${index}`, true)]
      : kind === "checkbox" ? [...interaction.fields.getCheckboxGroup(`q${index}`)] : interaction.fields.getStringSelectValues(`q${index}`);
    if (values.includes("other")) custom.push(index);
    const labels = values.filter((value) => value !== "other").map((value) => {
      if (!/^\d+$/.test(value) || !question.options[Number(value)]) throw new Error("An answer option is no longer available.");
      return question.options[Number(value)].label;
    });
    // Selecting only "Write another answer…" must keep the previous draft:
    // the custom modal pre-fills from it, so an "other" pass never erases it.
    if (labels.length) answers.set(index, labels);
  }
  return { answers, custom };
}

export function validateAnswers(request: AgentQuestion, answers: string[][]): void {
  if (answers.length !== request.questions.length) throw new Error("Answer every question before submitting.");
  request.questions.forEach((question, index) => {
    const answer = answers[index];
    if (!Array.isArray(answer) || !answer.length || answer.some((value) => typeof value !== "string" || !value.trim() || value.length > 4000)) throw new Error(`Question ${index + 1} still needs an answer.`);
    if (!question.multiple && answer.length !== 1) throw new Error(`Question ${index + 1} accepts one answer.`);
    if (new Set(answer).size !== answer.length) throw new Error("An answer was selected more than once.");
  });
}

export function renderQuestionReview(resource: string, request: AgentQuestion, draft: QuestionDraft, index = 0, delivery?: QuestionDelivery): CardMessage {
  index = Math.max(0, Math.min(request.questions.length - 1, index));
  const question = request.questions[index];
  const complete = draft.answers.filter((answer, i) => answer?.length && !draft.custom?.includes(i)).length;
  const card = new ContainerBuilder().setAccentColor(delivery?.status === "retry" ? 0xef4444 : 0xf59e0b);
  addCardHeader(card, "ANSWERS", question.header || "Your answers", `${complete}/${request.questions.length} answered · question ${index + 1}/${request.questions.length}`);
  card.addTextDisplayComponents(new TextDisplayBuilder().setContent(truncate(question.question, 1600)));
  const selected = draft.answers[index]?.length ? draft.answers[index].join(" · ") : "Not answered yet";
  card.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Your draft**\n${truncate(selected, 700)}${draft.custom?.includes(index) ? "\nWrite your custom answer before submitting." : ""}`));
  if (delivery?.error) card.addTextDisplayComponents(new TextDisplayBuilder().setContent(`⚠️ ${delivery.error}`));
  addCardDivider(card);
  card.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(cardId("questions", resource, request.requestID, Math.floor(index / 5)), "Edit answers", true),
    button(cardId("other", resource, request.requestID, index), "Write another answer"),
    button(cardId("send", resource, request.requestID), "Submit all answers").setDisabled(complete !== request.questions.length || delivery?.status === "submitting" || delivery?.status === "answered" || delivery?.status === "skipped"),
  ));
  card.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(cardId("review", resource, request.requestID, Math.max(0, index - 1)), "Previous question").setDisabled(index === 0),
    button(cardId("review", resource, request.requestID, index + 1), "Next question").setDisabled(index === request.questions.length - 1),
    button(cardId("skip", resource, request.requestID), "Skip request"),
  ));
  return cardMessage(card);
}
