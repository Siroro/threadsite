import { ButtonBuilder, ButtonStyle, ContainerBuilder, escapeMarkdown, TextDisplayBuilder } from "discord.js";
import { addCardDivider, addCardField, addCardHeader, addCardLinks, addCardTitle, cardLink, cardMessage, type CardMessage } from "./card-ui.js";
import { cardId } from "./card-actions.js";
import type { PanelSection } from "./card-panels.js";
import type { QuestionRow } from "./question-ui.js";
import type { QuestionStatus } from "./card-state.js";
import { modelDisplayName, modelNameSummary, type ModelUsage, type SessionUsage } from "./opencode-shared.js";
import { costsHidden, formatCost, formatTokens, formatTokensPerSecond } from "./util.js";

export type ProgressPhase = "queued" | "preparing" | "working" | "checking" | "publishing";
/**
 * `request` is the user's own words, set only when several messages were merged
 * into one turn. A single message is already visible in the thread, so echoing
 * it only pushed the plan further down the card.
 */
export interface ProgressContext { request?: string; siteUrl?: string; repoUrl?: string }
export interface ProgressPlanItem { content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }
export interface ProgressTool { id: string; name: string; status: "running" | "completed" | "error" }
/** One child session behind the subagent lines and the turn's saved details. */
export interface ProgressSubagent {
  /** OpenCode session id of the child. */
  id: string;
  /** Agent name the child runs as (general, explore, browser-qa…). */
  agent: string;
  model?: string;
  /** Completed model steps, deduped across retries. */
  steps: number;
  /** Running children drive the live card; finished ones stay in turn details. */
  status?: "running" | "finished";
  /** Newest known tool label, e.g. "📚 Reading · site/src/arena.ts". */
  activity?: string;
  /** When that activity was seen; ages the line when the child has gone quiet. */
  activityAt?: number;
  /** When the child session was first observed. */
  startedAt?: number;
  endedAt?: number;
  inputTokens?: number;
  cacheTokens?: number;
  outputTokens?: number;
}
export interface ProgressMetrics {
  currentModel?: string;
  cost?: number;
  catalogCost?: number;
  contextTokens?: number;
  contextLimit?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  steps?: number;
  compactions?: number;
  liveTokensPerSecond?: number;
  outputTokensPerSecond?: number;
  /** Generation window of the newest anchored root step. */
  lastRequestMs?: number;
  /** That step's start-to-first-token lag; undefined unless observed live. */
  firstTokenMs?: number;
  /** Per-model attribution, when steps carried their model; live turns may lack it. */
  models?: ModelUsage[];
}
/** One changed file with its line counts; binary files carry no counts. */
export interface ProgressFileEntry {
  path: string;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}
export interface ProgressFiles {
  files: number; added: number; modified: number; deleted: number; additions: number; deletions: number;
  /** Changed files with their line counts when available. */
  entries?: ProgressFileEntry[];
}
export interface ProgressActivity { text: string; detail?: string; at: number; key?: string; command?: boolean }
export interface ProgressSnapshot {
  title: string;
  phase: ProgressPhase;
  startedAt: number;
  now: number;
  latest: ProgressActivity;
  history: ProgressActivity[];
  context: ProgressContext;
  thought?: string;
  /** Public assistant messages only; streamed parts grow in place. */
  narration?: ProgressActivity[];
  /**
   * Raw model reasoning. Never rendered on any public card; it exists for the
   * owner-only Thinking trace tab in the personal details panel.
   */
  reasoning?: ProgressActivity[];
  stats?: string;
  changes?: string;
  files?: ProgressFiles;
  metrics?: ProgressMetrics;
  plan: ProgressPlanItem[];
  queuedRequests: number;
  actions: number;
  activeTools: number;
  /** Count of live child sessions. */
  activeSubagents?: number;
  /** Per-child detail for the active sessions. */
  subagents?: ProgressSubagent[];
  /** Every child seen during the turn, including finished ones; kept for turn details. */
  subagentHistory?: ProgressSubagent[];
  toolErrors: number;
  waiting?: boolean;
  /** Last OpenCode session-status poll reported a running or retrying turn. */
  agentReportedActive?: boolean;
  /** Why the card is amber while not waiting for an answer; shown with the warning. */
  waitingReason?: string;
  questionPin?: { requestID: string; question: string; resolution?: string };
  questions?: Array<{ header?: string; question: string; multiple?: boolean; options: Array<{ label: string; description?: string }> }>;
  questionStatus?: { status: QuestionStatus; error?: string };
  /** Time since the agent last emitted any event, once past the configured stall threshold. */
  stalledForMs?: number;
}

const PHASES: ProgressPhase[] = ["preparing", "working", "checking", "publishing"];
const LABELS: Record<ProgressPhase, string> = { queued: "Queued", preparing: "Prepare", working: "Build", checking: "Check", publishing: "Publish" };
const COLORS: Record<ProgressPhase, number> = { queued: 0x64748b, preparing: 0x818cf8, working: 0x5865f2, checking: 0x14b8a6, publishing: 0x22c55e };
// Keep the recent completion and the next useful tasks visible.
const PLAN_VISIBLE_ITEMS = 7;

export interface ProgressControls {
  questionRows?: QuestionRow[];
  stopCustomId?: string;
  resource?: string;
}

/** One live V2 panel; facts come from events rather than an invented completion estimate. */
export function renderProgressOverview(state: ProgressSnapshot, controls: ProgressControls = {}): CardMessage {
  // The stall warning is only meaningful while the model is expected to be
  // working: a queued thread and a pending question are both legitimately idle.
  const stalledForMs = state.phase !== "queued" && !state.questions?.length ? state.stalledForMs : undefined;
  const attention = Boolean(state.questions?.length || state.waiting || stalledForMs);
  const age = Math.max(0, state.now - state.latest.at);
  const current = PHASES.indexOf(state.phase);
  // "queued" is outside the rail, so it gets its own leading marker: without
  // one every step would render as pending and read as "nothing is happening".
  const rail = [...(state.phase === "queued" ? ["**● Queued**"] : []), ...PHASES.map((phase, index) =>
    index < current ? `✓ ${LABELS[phase]}` : index === current ? `**● ${LABELS[phase]}**` : `○ ${LABELS[phase]}`)].join("  ›  ");
  // No "Right now" label: the rail already names the phase, and for a queued
  // thread it would repeat the Queued marker directly above. The activity line
  // describes itself. A pending question is different — that is a state change
  // the reader must not miss, so it keeps its heading.
  const description = [rail, "", ...(state.questions?.length ? ["**Waiting for your answer**"] : []), ...activityLines(state, 300)];
  if (stalledForMs) {
    description.push(state.agentReportedActive
      ? `🔌 **OpenCode still reports this turn running** · no new agent event for ${elapsed(stalledForMs)}. Run \`/site stop\` to interrupt it.`
      : `⚠️ **No progress for ${elapsed(stalledForMs)}**: run \`/site stop\` to interrupt this turn.`);
  } else if (state.waitingReason && !state.questions?.length) {
    // Only the service wait needs its own line: a failed tool already headlines
    // the activity line with ⚠️, so a second generic line would just repeat it.
    description.push(`⚠️ **${plain(state.waitingReason, 160)}**`);
  } else if (age >= 15_000 && !state.waiting && state.phase !== "queued" && !state.questions?.length) {
    description.push(`${state.metrics?.liveTokensPerSecond ? "Generating" : state.activeTools ? "Running" : "Idle"} · ${elapsed(age)}`);
  }
  // Only a merged batch repeats the request: it is the one case where the
  // thread does not already show the user what this turn is applying.
  if (state.context.request) description.push("", `**Your requests**\n${plain(state.context.request, 220)}`);
  if (state.thought && !attention) description.push("", `**Agent update**\n> ${plain(state.thought, 280)}`);
  const fields: Array<{ name: string; value: string }> = [];
  if (state.activeSubagents) fields.push({ name: "Active subagents", value: subagentLines(state) });

  if (state.questions?.length) {
    state.questions.slice(0, 5).forEach((question, index) => fields.push({
      name: index ? `❓ Question ${index + 1}` : "❓ Your input is needed",
      value: `${plain(question.question, 180)}\n${question.options.slice(0, 4).map((option) => `**${plain(option.label, 55)}**${option.description ? `: ${plain(option.description, 90)}` : ""}`).join("\n")}`,
    }));
  } else if (state.questionPin) {
    fields.push({ name: "Decision", value: `${plain(state.questionPin.question, 200)}${state.questionPin.resolution ? `\n${plain(state.questionPin.resolution, 200)}` : ""}` });
  }

  // Put answer controls immediately below each question, including on a phone.
  if (state.questions?.length && (state.files || state.plan.length)) {
    const done = state.plan.filter((item) => item.status === "completed").length;
    fields.push({ name: "Progress so far", value: [state.plan.length ? `${done}/${state.plan.length} tasks completed` : "", state.files ? `${state.files.files} files changed` : ""].filter(Boolean).join(" · ") });
  }
  if (state.plan.length && !state.questions?.length) {
    const completed = state.plan.filter((item) => item.status === "completed").length;
    const skipped = state.plan.filter((item) => item.status === "cancelled").length;
    const remaining = state.plan.filter((item) => item.status !== "completed" && item.status !== "cancelled");
    const recent = state.plan.filter((item) => item.status === "completed").slice(-1);
    const visible = [...recent, ...remaining].slice(0, PLAN_VISIBLE_ITEMS);
    if (!visible.length) visible.push(...state.plan.slice(-3));
    const plan = visible.map((item) => `${item.status === "completed" ? "✓" : item.status === "in_progress" ? "●" : item.status === "cancelled" ? "↷" : "○"} ${item.status === "in_progress" ? `**${plain(item.content, 125)}**` : plain(item.content, 125)}`);
    if (remaining.length > visible.filter((item) => item.status === "pending" || item.status === "in_progress").length) plan.push(`… ${remaining.length - visible.filter((item) => item.status === "pending" || item.status === "in_progress").length} more planned`);
    const filled = Math.floor(8 * (completed + skipped) / state.plan.length);
    fields.push({ name: `Plan · ${completed}/${state.plan.length} done${skipped ? ` · ${skipped} skipped` : ""}`, value: `${"▰".repeat(filled)}${"▱".repeat(8 - filled)}\n${plan.join("\n")}` });
  }

  if (state.files && !state.questions?.length) {
    const files = state.files;
    const counts = [files.added ? `${files.added} new` : "", files.modified ? `${files.modified} modified` : "", files.deleted ? `${files.deleted} removed` : ""].filter(Boolean);
    const paths = (files.entries ?? []).slice(0, 3).map((entry) => `\`${clean(entry.path, 90).replaceAll("`", "")}\`${fileEntrySuffix(entry)}`);
    const rest = (files.entries ?? []).length - paths.length;
    fields.push({ name: "Changes this turn", value: [`**${files.files} file${files.files === 1 ? "" : "s"}** · **+${files.additions} / −${files.deletions}** lines`, counts.join(" · "), ...paths, rest > 0 ? `+${rest} more` : ""].filter(Boolean).join("\n") });
  } else if (state.changes && !state.questions?.length) {
    fields.push({ name: "Changes this turn", value: plain(state.changes, 500) });
  }

  const metrics = state.metrics;
  const usage: string[] = [];
  if (metrics) {
    if (metrics.inputTokens || metrics.outputTokens) usage.push(`${formatTokens(metrics.inputTokens ?? 0)} in · ${formatTokens(metrics.outputTokens ?? 0)} out`);
    if (metrics.cacheTokens && metrics.inputTokens) usage.push(`${Math.round(Math.min(1, metrics.cacheTokens / metrics.inputTokens) * 100)}% input cached`);
    if (metrics.contextTokens && metrics.contextLimit) {
      const filled = Math.min(8, Math.floor(8 * metrics.contextTokens / metrics.contextLimit));
      const percent = Math.round(metrics.contextTokens / metrics.contextLimit * 100);
      usage.push(`${"▰".repeat(filled)}${"▱".repeat(8 - filled)} ${formatTokens(metrics.contextTokens)} / ${formatTokens(metrics.contextLimit)} · ${percent}%`);
    } else if (metrics.contextTokens) usage.push(`${formatTokens(metrics.contextTokens)} context tokens`);
    const rate = metrics.liveTokensPerSecond ?? metrics.outputTokensPerSecond;
    if (rate && rate > 0) usage.push(`${metrics.liveTokensPerSecond ? "~" : "avg ~"}${formatTokensPerSecond(rate)} tok/s`);
    if (metrics.steps) usage.push(`${metrics.steps} model step${metrics.steps === 1 ? "" : "s"}`);
    if (metrics.compactions) usage.push(`Context compacted ${metrics.compactions}×`);
  } else if (state.stats) usage.push(plain(state.stats, 500));
  if (usage.length && !state.questions?.length) fields.push({ name: "Usage", value: usage.join("\n").slice(0, 1000) });

  const recent = distinctTail(state.history, 4);
  if (recent.length && !state.questions?.length) fields.push({ name: "Recent activity", value: recent.map((item) => `\`${elapsed(item.at - state.startedAt)}\` ${activity(item, 145)}`).join("\n") });
  if (state.queuedRequests > 0) fields.push({ name: "Next pass", value: `**${state.queuedRequests}** saved request${state.queuedRequests === 1 ? "" : "s"} waiting` });
  const footer = [`Elapsed ${elapsed(state.now - state.startedAt)}`, state.actions ? `${state.actions} action${state.actions === 1 ? "" : "s"}` : "", state.questions?.length ? "Waiting for your answer" : stalledForMs ? `No progress for ${elapsed(stalledForMs)}` : state.activeTools ? `${state.activeTools} running` : "", state.toolErrors ? `${state.toolErrors} tool error${state.toolErrors === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  const card = new ContainerBuilder().setAccentColor(attention ? 0xf59e0b : COLORS[state.phase]);
  const stop = controls.stopCustomId ? new ButtonBuilder().setCustomId(controls.stopCustomId).setLabel("Stop turn").setStyle(ButtonStyle.Secondary) : undefined;
  addCardHeader(card, "LIVE TURN", state.title, state.questions?.length ? "❓ Your answer is needed" : stalledForMs ? "⚠️ Waiting for progress" : state.phase === "queued" ? "Waiting for a build slot" : undefined, stop);
  card.addTextDisplayComponents(new TextDisplayBuilder().setContent(description.join("\n")));
  addCardDivider(card);
  let questionIndex = 0;
  for (const field of fields) {
    addCardField(card, field.name, cleanField(field.value));
    if (field.name.startsWith("❓")) {
      const row = controls.questionRows?.[questionIndex++];
      if (row) card.addActionRowComponents(row);
    }
  }
  if (!state.questions?.length) {
    addCardDivider(card);
    addCardLinks(card, [cardLink("Live site", state.context.siteUrl), cardLink("Source", state.context.repoUrl)]);
  }
  card.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footer}`));
  return cardMessage(card);
}

/** The public view spends its space on current work and a useful tail of public LLM updates. */
export function renderProgressCard(state: ProgressSnapshot, controls: ProgressControls = {}): CardMessage {
  const resource = controls.resource;
  const stalled = state.phase !== "queued" && !state.questions?.length ? state.stalledForMs : undefined;
  const waiting = Boolean(state.questions?.length || state.waiting || stalled);
  const card = new ContainerBuilder().setAccentColor(waiting ? 0xf59e0b : COLORS[state.phase]);
  // Turn details owns the header corner; Stop ends the turn-actions row in the
  // danger colour, and the site/source links ride the very bottom row.
  const details = resource ? new ButtonBuilder().setCustomId(cardId("details", resource)).setLabel("Turn details").setStyle(ButtonStyle.Primary) : undefined;
  addCardTitle(card, state.title, state.questions?.length ? "❓ Waiting for your answer" : state.phase === "queued" ? "Waiting for a build slot" : undefined, details);
  // The model identity rides a small line above the phase rail, keeping the
  // footer metrics-only; the line has room for further turn facts beside it.
  const model = state.metrics?.models ? modelNameSummary(state.metrics.models) : "";
  const current = PHASES.indexOf(state.phase);
  const rail = [...(state.phase === "queued" ? ["**● Queued**"] : []), ...PHASES.map((phase, index) => index < current ? `✓ ${LABELS[phase]}` : index === current ? `**● ${LABELS[phase]}**` : `○ ${LABELS[phase]}`)].join("  ›  ");
  const lines = [...(model ? [`-# 🧠 ${model}`] : []), rail, "", ...activityLines(state, 260)];
  if (stalled) lines.push(state.agentReportedActive
    ? `🔌 **OpenCode still reports this turn running** · no new agent event for ${elapsed(stalled)}. Run \`/site stop\` to interrupt it.`
    : `⚠️ **No progress for ${elapsed(stalled)}**: run \`/site stop\` to interrupt this turn.`);
  else if (state.waitingReason && !state.questions?.length) lines.push(`⚠️ ${plain(state.waitingReason, 180)}`);
  else if (!state.waiting && state.now - state.latest.at >= 15_000 && state.phase !== "queued" && !state.questions?.length) lines.push(`${state.metrics?.liveTokensPerSecond ? "Generating" : state.activeTools ? "Running" : "Idle"} · ${elapsed(state.now - state.latest.at)}`);
  card.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));
  if (state.context.request) addCardField(card, "Your requests", plain(state.context.request, 220));
  if (state.questions?.length) {
    addCardDivider(card);
    addCardField(card, state.questions.length === 1 ? "Your input is needed" : `${state.questions.length} questions need your input`, plain(state.questions[0].question, 550));
    const status = state.questionStatus;
    if (status?.status === "submitting") card.addTextDisplayComponents(new TextDisplayBuilder().setContent("⏳ Submitting your answer · keeping it saved until delivery is confirmed."));
    if (status?.error) card.addTextDisplayComponents(new TextDisplayBuilder().setContent(`⚠️ ${plain(status.error, 260)}`));
    if (controls.questionRows?.length) card.addActionRowComponents(...controls.questionRows);
  } else if (state.questionPin) {
    addCardField(card, "Decision", `${plain(state.questionPin.question, 180)}${state.questionPin.resolution ? `\n${plain(state.questionPin.resolution, 220)}` : ""}`);
  }
  const completed = state.plan.filter((item) => item.status === "completed").length;
  const skipped = state.plan.filter((item) => item.status === "cancelled").length;
  // A three-line plan window: the newest completion struck through, the task in
  // hand bolded, the one after it plain. The count line below carries the rest.
  const recentDone = state.plan.filter((item) => item.status === "completed").at(-1);
  let currentTaskIndex = state.plan.findIndex((item) => item.status === "in_progress");
  if (currentTaskIndex < 0) currentTaskIndex = state.plan.findIndex((item) => item.status === "pending");
  const currentTask = currentTaskIndex >= 0 ? state.plan[currentTaskIndex] : undefined;
  const nextTask = currentTaskIndex >= 0 ? state.plan.slice(currentTaskIndex + 1).find((item) => item.status === "pending") : undefined;
  const taskLines = [
    recentDone ? `✓ ~~${plain(recentDone.content, 125)}~~` : "",
    currentTask ? `${currentTask.status === "in_progress" ? "●" : "○"} **${plain(currentTask.content, 125)}**` : "",
    nextTask ? `○ ${plain(nextTask.content, 125)}` : "",
    [state.plan.length ? `${completed}/${state.plan.length} tasks complete${skipped ? ` · ${skipped} skipped` : ""}` : "", state.files ? `${state.files.files} files · +${state.files.additions} / −${state.files.deletions} lines` : ""].filter(Boolean).join(" · "),
  ].filter(Boolean).join("\n");
  if (taskLines) card.addTextDisplayComponents(new TextDisplayBuilder().setContent(taskLines));
  if (state.activeSubagents) addCardField(card, "Active subagents", subagentLines(state));
  const updates = state.narration?.length ? state.narration.slice(-4) : state.thought ? [{ text: state.thought, at: state.now }] : [];
  if (updates.length) {
    addCardDivider(card);
    addCardField(card, "Agent updates", updates.map((update) => `\`${elapsed(update.at - state.startedAt)}\` ${plain(update.text, 320)}`).join("\n\n"));
  }
  if (state.queuedRequests) card.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${state.queuedRequests}** saved request${state.queuedRequests === 1 ? "" : "s"} waiting for the next pass`));
  const stop = controls.stopCustomId ? new ButtonBuilder().setCustomId(resource ? cardId("stop", resource) : controls.stopCustomId).setLabel("Stop turn").setStyle(ButtonStyle.Danger) : undefined;
  if (resource) {
    const buttons: ButtonBuilder[] = [];
    if (!state.questions?.length) buttons.push(new ButtonBuilder().setCustomId(cardId("steer", resource)).setLabel("Add instruction").setStyle(ButtonStyle.Primary));
    buttons.push(new ButtonBuilder().setCustomId(cardId("queue", resource)).setLabel(`Queue${state.queuedRequests ? ` · ${state.queuedRequests}` : ""}`).setStyle(ButtonStyle.Secondary));
    if (stop) buttons.push(stop);
    addCardLinks(card, buttons);
  } else if (stop) addCardLinks(card, [stop]);
  addCardLinks(card, [cardLink("Live site", state.context.siteUrl), cardLink("Source", state.context.repoUrl)]);
  const metrics = state.metrics;
  const liveRate = metrics?.liveTokensPerSecond;
  const averageRate = metrics?.outputTokensPerSecond;
  // While a response streams, the ⚡ slot alternates with the turn average on a
  // six-second phase: the card already re-renders every few seconds, so the two
  // figures take turns instead of widening the footer. Outside a stream only
  // the average exists, and it keeps the avg prefix to name itself.
  const showAverage = !(liveRate && liveRate > 0)
    || (!!averageRate && averageRate > 0 && Math.floor(state.now / 6_000) % 2 === 1);
  const rate = showAverage ? averageRate : liveRate;
  const rateLabel = rate && rate > 0 ? `⚡${showAverage ? "avg" : ""}~${formatTokensPerSecond(rate)}t/s` : "";
  const steps = metrics?.steps ? `${metrics.steps} step${metrics.steps === 1 ? "" : "s"}` : "";
  // Billed tokens stand in for the tool-error count: input with its cache
  // share, then the total output — failures already headline the activity line.
  // The triangles are text-presentation glyphs, so they render at text size
  // next to the counts instead of the subtext-shrunken emoji.
  const cacheShare = metrics?.cacheTokens && metrics?.inputTokens ? ` (${Math.round(Math.min(1, metrics.cacheTokens / metrics.inputTokens) * 100)}%)` : "";
  const tokens = metrics && (metrics.inputTokens || metrics.outputTokens) ? `▼ ${formatTokens(metrics.inputTokens ?? 0)}${cacheShare} ▲ ${formatTokens(metrics.outputTokens ?? 0)}` : "";
  card.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${[
    `⏱️ ${elapsed(state.now - state.startedAt)}`,
    steps,
    metrics?.contextTokens ? metrics.contextLimit ? `${formatTokens(metrics.contextTokens)}/${formatTokens(metrics.contextLimit)} context` : `${formatTokens(metrics.contextTokens)} context` : "",
    rateLabel,
    state.activeTools ? `${state.activeTools} running` : "",
    tokens,
    stalled ? `No progress for ${elapsed(stalled)}` : "",
  ].filter(Boolean).join(" · ")}`));
  return cardMessage(card);
}

/**
 * The private usage tab: every provider figure formatted for reading, with the
 * same bar/budget visuals as the live card. Missing counts stay "unavailable"
 * rather than rendering as zeros.
 */
export function usageDetailText(metrics: ProgressMetrics): string {
  const tokens = [
    metrics.inputTokens ? `Input **${formatTokens(metrics.inputTokens)}**` : "",
    metrics.outputTokens ? `Output **${formatTokens(metrics.outputTokens)}**` : "",
    metrics.cacheTokens ? `Cached **${formatTokens(metrics.cacheTokens)}**${metrics.inputTokens ? ` (${Math.round(Math.min(1, metrics.cacheTokens / metrics.inputTokens) * 100)}% of input)` : ""}` : "",
  ].filter(Boolean).join(" · ");
  let context = "";
  if (metrics.contextTokens && metrics.contextLimit) {
    const filled = Math.min(8, Math.floor(8 * metrics.contextTokens / metrics.contextLimit));
    context = `Context **${formatTokens(metrics.contextTokens)} / ${formatTokens(metrics.contextLimit)}** (${Math.round(metrics.contextTokens / metrics.contextLimit * 100)}%)\n${"▰".repeat(filled)}${"▱".repeat(8 - filled)}`;
  } else if (metrics.contextTokens) {
    context = `Context **${formatTokens(metrics.contextTokens)}**`;
  }
  const counts = [
    metrics.steps ? `${metrics.steps} model step${metrics.steps === 1 ? "" : "s"}` : "",
    metrics.compactions ? `${metrics.compactions} compaction${metrics.compactions === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ");
  const rates = [
    metrics.liveTokensPerSecond ? `live ~${formatTokensPerSecond(metrics.liveTokensPerSecond)} tok/s` : "",
    metrics.outputTokensPerSecond ? `average ~${formatTokensPerSecond(metrics.outputTokensPerSecond)} tok/s` : "",
  ].filter(Boolean).join(" · ");
  // Request-scale timing: the newest root step's window and its first-token
  // lag. A restored turn times the request but never invents a first token —
  // the server persists none — so that half stays absent rather than zero.
  const timing = [
    metrics.lastRequestMs ? `last request ${requestDuration(metrics.lastRequestMs)}` : "",
    metrics.firstTokenMs ? `first token ${requestDuration(metrics.firstTokenMs)}` : "",
  ].filter(Boolean).join(" · ");
  return [tokens || "Token counts unavailable", context, counts, rates, timing ? `Timing **${timing}**` : ""]
    .filter(Boolean).join("\n");
}

/** Request-scale durations keep a decimal where tenths matter, then hand off to elapsed(). */
function requestDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return elapsed(ms);
}

const PLAN_MARKS: Record<ProgressPlanItem["status"], string> = { completed: "✓", in_progress: "●", cancelled: "↷", pending: "○" };

/**
 * Per-model figures for the final usage tab with each model's tokens. Names
 * are provider-stripped for members; admins see the full provider/model id,
 * since routing is the part they can act on. Spend joins a line only for
 * admins — model identities are fine to show any viewer — and a surplus
 * model's catalog-rate equivalent rides its billed figure.
 */
export function modelUsageLines(models: ModelUsage[], admin = false): string {
  return models
    .filter((entry) => entry.model && entry.model !== "unknown")
    .map((entry) => `\`${admin ? entry.model : modelDisplayName(entry.model)}\`: in ${formatTokens(entry.inputTokens)} · out ${formatTokens(entry.outputTokens)}`
      + (admin && !costsHidden() && entry.cost > 0 ? ` · ${formatCost(entry.cost)}` : "")
      + (admin && !costsHidden() && entry.catalogCost ? ` · ${formatCost(entry.catalogCost)} at catalog rates` : ""))
    .join("\n");
}

/**
 * The usage tab's root-versus-subagent split: which figures belong to the main
 * turn and which to each child, and the model(s) each part ran — a mid-session
 * model switch or failover shows as a second name. Spend and provider-qualified
 * ids join each line only for admins, like the model lines.
 */
export function sessionUsageLines(sessions: SessionUsage[], admin = false): string {
  return sessions
    .map((entry) => {
      const models = entry.models ? modelNameSummary(entry.models, 2, admin) : "";
      return `${entry.root ? "Root turn" : `🤖 ${entry.agent ?? "subagent"}`}${models ? ` (${models})` : ""}`
        + `: in ${formatTokens(entry.inputTokens)} · out ${formatTokens(entry.outputTokens)} · ${entry.steps} step${entry.steps === 1 ? "" : "s"}`
        + (admin && !costsHidden() && entry.cost > 0 ? ` · ${formatCost(entry.cost)}` : "");
    })
    .join("\n");
}

export function progressDetailSections(state: ProgressSnapshot, admin = false): PanelSection[] {
  const overview = renderProgressOverview(state).components[0].components
    .filter((component): component is TextDisplayBuilder => component instanceof TextDisplayBuilder).map((component) => component.data.content).join("\n\n");
  const metrics = state.metrics;
  const updates = state.narration?.length ? state.narration : state.thought ? [{ text: state.thought, at: state.now }] : [];
  const subagents = subagentHistory(state);
  const sections: Array<PanelSection | undefined> = [
    { key: "overview", label: "Overview", text: overview },
    detailSections.plan(state),
    detailSections.files(state),
    detailSections.usage(metrics, state.stats, state.toolErrors, admin),
    detailSections.updates(updates, state.startedAt),
    state.reasoning?.length ? { key: "thinking", label: "Thinking trace", text: state.reasoning.map((item) => `**${elapsed(item.at - state.startedAt)}**\n${item.text}`).join("\n\n") } : undefined,
    { key: "activity", label: "Activity history", text: [...state.history, state.latest].filter((item) => item.text.trim()).map((item) => `${elapsed(item.at - state.startedAt)} · ${item.text}${item.detail ? `\n${item.detail}` : ""}`).join("\n\n") },
    detailSections.questions(state),
    subagents.length ? { key: "subagents", label: "Subagents", text: subagentDetailText(subagents, state.now) } : undefined,
    state.context.request ? { key: "request", label: "Merged requests", text: state.context.request } : undefined,
  ];
  // A dropdown entry with nothing behind it makes the reader open a dead page.
  return sections.filter((entry): entry is PanelSection => Boolean(entry?.text.trim()));
}

/** Every child this turn used, preferring the durable roster over the live subset. */
export function subagentHistory(state: ProgressSnapshot): ProgressSubagent[] {
  if (state.subagentHistory?.length) return state.subagentHistory;
  return state.subagents ?? [];
}

/** Full subagent roster for the private details page: what ran, how far, and its last action. */
export function subagentDetailText(subagents: ProgressSubagent[], now?: number): string {
  return subagents.map((sub) => {
    const status = sub.status === "running" ? "active" : sub.status === "finished" ? "inactive" : "";
    const facts = [`${sub.steps} step${sub.steps === 1 ? "" : "s"}`, status, subagentSpan(sub, now)].filter(Boolean).join(" · ");
    return [
      `🤖 **${plain(sub.agent, 40)}** · ${facts}`,
      sub.model ? `Model: ${plain(modelDisplayName(sub.model), 100)}` : "",
      usageDetailText({ inputTokens: sub.inputTokens, cacheTokens: sub.cacheTokens, outputTokens: sub.outputTokens }),
      sub.activity ? `Last action: ${plain(sub.activity, 180)}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

/** How long a child ran, anchored to its first observed activity. */
function subagentSpan(sub: ProgressSubagent, now?: number): string {
  if (!sub.startedAt || !Number.isFinite(sub.startedAt)) return "";
  const end = sub.status === "running" ? now : sub.endedAt;
  if (!end || end <= sub.startedAt) return "";
  return `elapsed ${elapsed(end - sub.startedAt)}`;
}

/** A compact roster for the public technical card. */
export function subagentSummaryLines(subagents: ProgressSubagent[], limit = 4): string {
  return [...subagents.slice(0, limit).map((sub) => `🤖 **${plain(sub.agent, 24)}** · ${sub.steps} step${sub.steps === 1 ? "" : "s"}${sub.activity ? ` · ${plain(sub.activity, 90)}` : ""}`),
    ...(subagents.length > limit ? [`+${subagents.length - limit} more`] : [])].join("\n");
}

/** A metric object can exist while every provider count is still missing. */
export function hasUsageData(metrics: ProgressMetrics | undefined): boolean {
  if (!metrics) return false;
  return Boolean(metrics.inputTokens || metrics.outputTokens || metrics.cacheTokens || metrics.contextTokens
    || metrics.steps || metrics.compactions || metrics.liveTokensPerSecond || metrics.outputTokensPerSecond);
}

/** `+A/−D` beside a file; binary files say why there is nothing to count. */
function fileEntrySuffix(entry: ProgressFileEntry): string {
  const counts = [entry.additions === undefined ? "" : `+${entry.additions}`, entry.deletions === undefined ? "" : `−${entry.deletions}`].filter(Boolean).join("/");
  if (counts) return ` · ${counts}`;
  return entry.binary ? " · binary" : "";
}

const detailSections = {
  plan(state: ProgressSnapshot): PanelSection | undefined {
    const items = state.plan.filter((item) => item.content.trim());
    return items.length ? { key: "plan", label: "Complete plan", text: items.map((item, index) => `${PLAN_MARKS[item.status]} ${index + 1}. ${item.content}`).join("\n\n") } : undefined;
  },
  files(state: ProgressSnapshot): PanelSection | undefined {
    const files = state.files;
    const text = [
      files ? `**${files.files} file${files.files === 1 ? "" : "s"}** · ${files.added} added · ${files.modified} modified · ${files.deleted} removed · **+${files.additions} / −${files.deletions}** lines` : "",
      ...(files ? (files.entries ?? []) : []).map((entry) => `- \`${entry.path.replaceAll("`", "")}\`${fileEntrySuffix(entry)}`),
      state.changes ?? "",
    ].filter(Boolean).join("\n");
    return text.trim() ? { key: "files", label: "Changed files", text } : undefined;
  },
  usage(metrics: ProgressMetrics | undefined, stats: string | undefined, toolErrors = 0, admin = false): PanelSection | undefined {
    // The tool-error count left the public footer for concision; this private
    // page is its home, beside the turn's other figures. The finished turn's
    // panel reuses this text as its "last live reading" block.
    const text = [
      metrics?.currentModel ? `**Current model**
${plain(admin ? metrics.currentModel : modelDisplayName(metrics.currentModel), 120)}` : "",
      admin && !costsHidden() && metrics && (metrics.cost || metrics.catalogCost) ? `**Current cost**
${formatCost(metrics.cost || metrics.catalogCost!)}${metrics.cost ? "" : " at catalog rates"}` : "",
      hasUsageData(metrics) && metrics ? usageDetailText(metrics) : "",
      stats ?? "",
      toolErrors ? `⚠️ ${toolErrors} tool error${toolErrors === 1 ? "" : "s"}` : "",
    ].filter(Boolean).join("\n\n");
    return text.trim() ? { key: "usage", label: "Usage & context", text } : undefined;
  },
  updates(updates: Array<{ text: string; at: number }>, startedAt: number): PanelSection | undefined {
    const text = updates.filter((item) => item.text.trim()).map((item) => `**${elapsed(item.at - startedAt)}**\n${item.text}`).join("\n\n");
    return text.trim() ? { key: "updates", label: "Agent update history", text } : undefined;
  },
  questions(state: ProgressSnapshot): PanelSection | undefined {
    const text = [state.questionPin ? `${state.questionPin.question}\n${state.questionPin.resolution ?? ""}` : "",
      ...(state.questions ?? []).map((question) => `${question.question}\n${question.options.map((option) => `${option.label}${option.description ? `: ${option.description}` : ""}`).join("\n")}`),
    ].filter(Boolean).join("\n\n");
    return text.trim() ? { key: "questions", label: "Questions & decisions", text } : undefined;
  },
};

function activity(item: ProgressActivity, max: number): string {
  return `${plain(item.text, max)}${item.detail ? ` · ${plain(item.detail, Math.max(30, max - clean(item.text, max).length))}` : ""}`;
}
/**
 * One line per live child session: who it is, how much it has done and what
 * it is on right now.
 */
function subagentLines(state: ProgressSnapshot): string {
  const subs = state.subagents ?? [];
  return [...subs.slice(0, 4).map((sub) => [
    `🤖 **${plain(sub.agent, 24)}**`,
    `${sub.steps} step${sub.steps === 1 ? "" : "s"}`,
    sub.activity ? plain(sub.activity, 90) : "",
    sub.activityAt && state.now - sub.activityAt >= 10_000 ? `${elapsed(state.now - sub.activityAt)} ago` : "",
  ].filter(Boolean).join(" · ")), ...(subs.length > 4 ? [`+${subs.length - 4} more`] : [])].join("\n");
}
/**
 * The newest distinct actions, oldest first. Exact repeats — the same command
 * re-run by a later tool call — keep one slot, so a visible tail is several
 * different actions. Identity is text plus detail, so the same verb on another
 * file still counts as its own action.
 */
function distinctTail(items: ProgressActivity[], count: number): ProgressActivity[] {
  const tail: ProgressActivity[] = [];
  const seen = new Set<string>();
  for (let index = items.length - 1; index >= 0 && tail.length < count; index -= 1) {
    const item = items[index]!;
    const identity = JSON.stringify([item.text, item.detail]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    tail.unshift(item);
  }
  return tail;
}
/**
 * The activity area: the last three distinct actions, newest at the bottom.
 * The current one is prefixed and bold so it reads apart from the finished
 * ones above it.
 */
function activityLines(state: ProgressSnapshot, max: number): string[] {
  const tail = distinctTail([...state.history, state.latest], 3);
  return tail.map((item, index) => index === tail.length - 1 ? `▶ **${activity(item, max)}**` : activity(item, max));
}
function clean(value: string, max: number): string {
  const text = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
/** External text (user prompts, agent questions) rendered as markdown-safe prose. */
export function plain(value: string, max: number): string { return escapeMarkdown(clean(value, max), { maskedLink: true }); }
function cleanField(value: string): string { return value.length > 1000 ? `${value.slice(0, 999)}…` : value; }
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
