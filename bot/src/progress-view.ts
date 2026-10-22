import { EmbedBuilder, escapeMarkdown, type MessageEditOptions } from "discord.js";
import { formatTokens, formatTokensPerSecond } from "./util.js";

export type ProgressPhase = "queued" | "preparing" | "working" | "checking" | "publishing";
/**
 * `request` is the user's own words, set only when several messages were merged
 * into one turn. A single message is already visible in the thread, so echoing
 * it only pushed the plan further down the card.
 */
export interface ProgressContext { request?: string; siteUrl?: string; repoUrl?: string }
export interface ProgressPlanItem { content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }
export interface ProgressTool { id: string; name: string; status: "running" | "completed" | "error" }
export interface ProgressMetrics {
  contextTokens?: number;
  contextLimit?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  steps?: number;
  compactions?: number;
  liveTokensPerSecond?: number;
  outputTokensPerSecond?: number;
}
export interface ProgressFiles {
  files: number; added: number; modified: number; deleted: number; additions: number; deletions: number;
  paths?: string[];
}
export interface ProgressActivity { text: string; detail?: string; at: number; key?: string }
export interface ProgressSnapshot {
  title: string;
  phase: ProgressPhase;
  startedAt: number;
  now: number;
  latest: ProgressActivity;
  history: ProgressActivity[];
  context: ProgressContext;
  thought?: string;
  stats?: string;
  changes?: string;
  files?: ProgressFiles;
  metrics?: ProgressMetrics;
  plan: ProgressPlanItem[];
  queuedRequests: number;
  actions: number;
  activeTools: number;
  toolErrors: number;
  waiting?: boolean;
  /** Last OpenCode session-status poll reported a running or retrying turn. */
  agentReportedActive?: boolean;
  /** Why the card is amber while not waiting for an answer; shown with the warning. */
  waitingReason?: string;
  questionPin?: { question: string; resolution?: string };
  questions?: Array<{ question: string; options: Array<{ label: string; description?: string }> }>;
  /** Time since the agent last emitted any event, once past the configured stall threshold. */
  stalledForMs?: number;
}

const PHASES: ProgressPhase[] = ["preparing", "working", "checking", "publishing"];
const LABELS: Record<ProgressPhase, string> = { queued: "Queued", preparing: "Prepare", working: "Build", checking: "Check", publishing: "Publish" };
const COLORS: Record<ProgressPhase, number> = { queued: 0x64748b, preparing: 0x818cf8, working: 0x5865f2, checking: 0x14b8a6, publishing: 0x22c55e };
// Seven 125-character items fit Discord's 1024-character field cap.
const PLAN_VISIBLE_ITEMS = 7;

/** One bounded Discord embed; facts come from events rather than an invented completion estimate. */
export function renderProgressCard(state: ProgressSnapshot): MessageEditOptions {
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
  const description = [rail, "", ...(state.questions?.length ? ["**Waiting for your answer**"] : []), activity(state.latest, 300)];
  if (stalledForMs) {
    description.push(state.agentReportedActive
      ? `🔌 **OpenCode still reports this turn running** · no new agent event for ${elapsed(stalledForMs)}. Run \`/site stop\` to interrupt it.`
      : `⚠️ **No progress for ${elapsed(stalledForMs)}** — run \`/site stop\` to interrupt this turn.`);
  } else if (state.waiting && !state.questions?.length) {
    // The amber colour is driven by `waiting` too, so it needs its own label.
    description.push(`⚠️ **${plain(state.waitingReason ?? "Waiting on the agent — it will retry automatically", 160)}**`);
  } else if (age >= 15_000 && state.phase !== "queued" && !state.questions?.length) {
    description.push(`${state.metrics?.liveTokensPerSecond ? "Generating" : state.activeTools ? "Running" : "Idle"} · ${elapsed(age)}`);
  }
  // Only a merged batch repeats the request: it is the one case where the
  // thread does not already show the user what this turn is applying.
  if (state.context.request) description.push("", `**Your requests**\n${plain(state.context.request, 220)}`);
  if (state.thought && !attention) description.push("", `**Agent update**\n> ${plain(state.thought, 280)}`);
  const embed = new EmbedBuilder()
    .setTitle(clean(state.title, 180))
    .setColor(attention ? 0xf59e0b : COLORS[state.phase])
    .setDescription(description.join("\n"));

  if (state.questions?.length) {
    embed.addFields({ name: "❓ Your input is needed", value: state.questions.slice(0, 3).map((question) =>
      `${plain(question.question, 180)}\n${question.options.slice(0, 4).map((option) => `**${plain(option.label, 55)}**${option.description ? ` — ${plain(option.description, 90)}` : ""}`).join("\n")}`,
    ).join("\n\n").slice(0, 900), inline: false });
  } else if (state.questionPin) {
    embed.addFields({ name: "Decision", value: `${plain(state.questionPin.question, 200)}${state.questionPin.resolution ? `\n${plain(state.questionPin.resolution, 200)}` : ""}`, inline: false });
  }

  // Discord places buttons below embeds: keep the question view short enough
  // that its actions remain easy to reach on a phone.
  if (state.questions?.length && (state.files || state.plan.length)) {
    const done = state.plan.filter((item) => item.status === "completed").length;
    embed.addFields({ name: "Progress so far", value: [state.plan.length ? `${done}/${state.plan.length} tasks completed` : "", state.files ? `${state.files.files} files changed` : ""].filter(Boolean).join(" · ") });
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
    embed.addFields({ name: `Plan · ${completed}/${state.plan.length} done${skipped ? ` · ${skipped} skipped` : ""}`, value: plan.join("\n"), inline: false });
  }

  if (state.files && !state.questions?.length) {
    const files = state.files;
    const counts = [files.added ? `${files.added} new` : "", files.modified ? `${files.modified} modified` : "", files.deleted ? `${files.deleted} removed` : ""].filter(Boolean);
    const paths = (files.paths ?? []).slice(0, 3).map((file) => `\`${clean(file, 90).replaceAll("`", "") }\``);
    const rest = (files.paths?.length ?? 0) - paths.length;
    embed.addFields({ name: "Changes this turn", value: [`**${files.files} file${files.files === 1 ? "" : "s"}** · **+${files.additions} / −${files.deletions}** lines`, counts.join(" · "), ...paths, rest > 0 ? `+${rest} more` : ""].filter(Boolean).join("\n"), inline: true });
  } else if (state.changes && !state.questions?.length) {
    embed.addFields({ name: "Changes this turn", value: plain(state.changes, 500), inline: true });
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
  if (usage.length && !state.questions?.length) embed.addFields({ name: "Usage", value: usage.join("\n").slice(0, 1000), inline: true });

  const recent = state.history.slice(-4);
  if (recent.length && !state.questions?.length) embed.addFields({ name: "Recent activity", value: recent.map((item) => `\`${elapsed(item.at - state.startedAt)}\` ${activity(item, 145)}`).join("\n"), inline: false });
  if (state.queuedRequests > 0) embed.addFields({ name: "Next pass", value: `**${state.queuedRequests}** saved request${state.queuedRequests === 1 ? "" : "s"} waiting`, inline: false });
  const links = [link("Live site ↗", state.context.siteUrl), link("Source ↗", state.context.repoUrl)].filter(Boolean);
  if (links.length) embed.addFields({ name: "Project", value: links.join(" · "), inline: false });
  embed.setFooter({ text: [`Elapsed ${elapsed(state.now - state.startedAt)}`, state.actions ? `${state.actions} action${state.actions === 1 ? "" : "s"}` : "", state.questions?.length ? "Waiting for your answer" : stalledForMs ? `No progress for ${elapsed(stalledForMs)}` : state.activeTools ? `${state.activeTools} running` : "", state.toolErrors ? `${state.toolErrors} tool error${state.toolErrors === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") });
  embed.setFields((embed.data.fields ?? []).map((field) => ({ ...field, value: cleanField(field.value) })));
  // Limit the total text independently of Discord's individual field limits.
  while (embed.length > 5800 && embed.data.fields?.length) embed.spliceFields(embed.data.fields.length - 1, 1);
  return { content: "", embeds: [embed], allowedMentions: { parse: [] } };
}

/** Servers without Embed Links permission retain the same information in a compact text view. */
export function renderProgressText(state: ProgressSnapshot): MessageEditOptions {
  const card = (renderProgressCard(state).embeds![0] as EmbedBuilder).toJSON();
  const footer = card.footer?.text ?? "";
  const body = [`**${card.title}**`, card.description, ...(card.fields ?? []).map((field) => `**${field.name}**\n${field.value}`)].filter(Boolean).join("\n\n");
  return { content: `${body.slice(0, 1988 - footer.length)}\n${footer}`, embeds: [], allowedMentions: { parse: [] } };
}

function activity(item: ProgressActivity, max: number): string {
  return `${plain(item.text, max)}${item.detail ? ` · ${plain(item.detail, Math.max(30, max - clean(item.text, max).length))}` : ""}`;
}
function clean(value: string, max: number): string {
  const text = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function plain(value: string, max: number): string { return escapeMarkdown(clean(value, max), { maskedLink: true }); }
function cleanField(value: string): string { return value.length > 1000 ? `${value.slice(0, 999)}…` : value; }
function link(label: string, raw?: string): string {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return "";
    return `[${label}](${url.href.replaceAll("(", "%28").replaceAll(")", "%29")})`;
  } catch { return ""; }
}
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
