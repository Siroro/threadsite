import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType,
  type Message, type ModalSubmitInteraction,
} from "discord.js";
import { cardEdit, disableMessageControls, renderStatusCard, safeCardUrl } from "../src/card-ui.js";
import { cardId, parseCardId } from "../src/card-actions.js";
import { renderDetailPanel, renderQueuePanel, requestModal, textPages } from "../src/card-panels.js";
import { renderProgressCard, progressDetailSections, usageDetailText } from "../src/progress-view.js";
import { answerModal, questionControls, readAnswerForm, renderQuestionReview } from "../src/question-ui.js";
import type { QuestionDraft } from "../src/card-state.js";
import { buildingSnapshot } from "./fixtures/progress.js";
import { assertV2, cardComponents, cardView } from "./fixtures/cards.js";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const { DiscordProgress } = await import("../src/progress.js");
const { turnPanelSections } = await import("../src/card-interactions.js");

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
    new ButtonBuilder().setCustomId(cardId("rollback", "turn")).setLabel("Rollback edits").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cardId("keep", "turn")).setLabel("Keep edits").setStyle(ButtonStyle.Success),
  );
  for (const text of ["❌ Turn failed", "🛑 Stopped by reset", "🔗 Merged into the update above", "🚫 Cancelled"]) {
    const message = cardEdit(renderStatusCard(text, text.includes("failed") ? [choices] : []));
    assertV2(message);
    assert.equal(message.content, null);
    assert.equal(cardView(message).buttons.some((button) => button.custom_id === cardId("stop", "turn")), false);
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
    state.files!.entries = Array.from({ length: 10 }, () => ({ path: long }));
    const message = renderProgressCard(state, { stopCustomId: cardId("stop", "turn") });
    assertV2(message);
    assert.ok(cardView(message).buttons.some((button) => button.custom_id === cardId("stop", "turn")));
    assert.doesNotMatch(cardView(message).text, /^## /m, "the title leads in the small line; no big heading");
  }
});

test("changed files carry per-file line counts", () => {
  const state = buildingSnapshot();
  state.files = { files: 4, added: 3, modified: 1, deleted: 0, additions: 120, deletions: 8,
    entries: [
      { path: "site/src/main.ts", additions: 64 },
      { path: "site/src/sim.ts", additions: 30, deletions: 8 },
      { path: "site/assets/fonts/space-grotesk-500.woff2", binary: true },
      { path: "site/index.html", additions: 26, deletions: 0 },
    ] };
  const panel = progressDetailSections(state).find((section) => section.key === "files")!;
  assert.match(panel.text, /\*\*4 files\*\* · 3 added · 1 modified · 0 removed · \*\*\+120 \/ −8\*\* lines/);
  assert.match(panel.text, /- `site\/src\/main\.ts` · \+64$/m);
  assert.match(panel.text, /- `site\/src\/sim\.ts` · \+30\/−8$/m);
  assert.match(panel.text, /- `site\/assets\/fonts\/space-grotesk-500\.woff2` · binary$/m);
  // The overview panel previews the same counts on its first three paths.
  const overview = progressDetailSections(state).find((section) => section.key === "overview")!;
  assert.match(overview.text, /`site\/src\/main\.ts` · \+64/);
  assert.match(overview.text, /`site\/assets\/fonts\/space-grotesk-500\.woff2` · binary/);
  assert.match(overview.text, /\+1 more/);
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

test("detail sections without recorded information stay out of the dropdown and subagents survive their finish", () => {
  const state = buildingSnapshot();
  state.plan = [];
  state.files = undefined;
  state.metrics = undefined;
  state.thought = undefined;
  state.narration = [];
  state.history = [];
  state.latest = { text: "", at: state.now };
  state.context = {};
  state.subagentHistory = [
    { id: "ses_child", agent: "explore", steps: 3, status: "finished", activity: "📚 Reading · site/src/arena.ts", activityAt: state.now - 5_000 },
  ];
  const sections = progressDetailSections(state);
  assert.deepEqual(sections.map((section) => section.key), ["overview", "subagents"],
    "empty plan, files, usage, updates, questions and request pages are not offered");
  const subagents = sections.find((section) => section.key === "subagents")!;
  assert.match(subagents.text, /\*\*explore\*\* · 3 steps · inactive/);
  assert.match(subagents.text, /Last action: 📚 Reading · site\/src\/arena\.ts/);
});

test("subagent details freeze finished durations and show reconciled per-session usage", () => {
  const state = buildingSnapshot();
  state.now = 120_000;
  state.subagentHistory = [
    { id: "a", agent: "general", status: "running", steps: 1, startedAt: 60_000, inputTokens: 1000, cacheTokens: 500, outputTokens: 200 },
    { id: "b", agent: "explore", status: "finished", steps: 2, startedAt: 60_000, endedAt: 90_000, inputTokens: 2, outputTokens: 3 },
  ];
  const live = turnPanelSections(undefined, state, "turn").find((entry) => entry.key === "subagents")!.text;
  assert.match(live, /active · elapsed 1m/);
  assert.match(live, /Input \*\*1k\*\* · Output \*\*200\*\* · Cached \*\*500\*\*/);
  assert.match(live, /inactive · elapsed 30s/);
  state.now = 180_000;
  const later = turnPanelSections(undefined, state, "turn").find((entry) => entry.key === "subagents")!.text;
  assert.match(later, /active · elapsed 2m/);
  assert.match(later, /inactive · elapsed 30s/);
  const result = { usage: { inputTokens: 5000, outputTokens: 500, cacheTokens: 1000, contextTokens: 0, compactions: 0, steps: 3, cost: 0, models: [],
    sessions: [{ sessionID: "b", inputTokens: 5000, outputTokens: 500, cacheTokens: 1000, cost: 0, steps: 2 }] } };
  const final = turnPanelSections({ result } as any, state, "turn").find((entry) => entry.key === "subagents")!.text;
  assert.match(final, /Input \*\*5k\*\* · Output \*\*500\*\* · Cached \*\*1k\*\*/);
});

test("finished turns only list pages the turn actually recorded", () => {
  const result = {
    name: "Koi Pond Arcade", kind: "site" as const, published: false, commitFiles: 0, additions: 0, deletions: 0,
    durationMs: 90_000, usage: { inputTokens: 0, outputTokens: 0, cacheTokens: 0, contextTokens: 0, compactions: 0, steps: 0, cost: 0 },
    siteUrl: "https://sites.example.invalid/koi/", repoUrl: "https://git.example.invalid/site-koi",
    subagents: [{ id: "ses_child", agent: "general", steps: 4, status: "finished" as const }],
  };
  const sections = turnPanelSections({ result }, undefined, "turn");
  assert.deepEqual(sections.map((section) => section.key), ["outcome", "subagents"],
    "no report, findings, documents, file paths or counts become dead dropdown entries");
  const docs = turnPanelSections({ result }, undefined, "doc");
  assert.deepEqual(docs.map((section) => section.key), ["description"], "a doc view without documents falls back to one honest page");
  const panel = renderDetailPanel("Turn details", "turn", "turn", sections, "subagents");
  assertV2(panel);
  assert.match(cardView(panel).text, /general/);
});

test("turn details show every viewer the models it used, but spend only to site admins", () => {
  const result = {
    name: "Koi Pond Arcade", kind: "site" as const, published: true, commitFiles: 2, additions: 10, deletions: 2,
    durationMs: 90_000,
    usage: {
      inputTokens: 1_200_000, outputTokens: 45_000, cacheTokens: 980_000, contextTokens: 1_100_000,
      contextLimit: 2_000_000, compactions: 0, steps: 18, cost: 3.42, catalogCost: 16.4,
      models: [
        { model: "surplus/deepseek-4.1", inputTokens: 1_000_000, outputTokens: 40_000, cacheTokens: 900_000, cost: 2.1, catalogCost: 16.4 },
        { model: "opencode/glm-5.3", inputTokens: 200_000, outputTokens: 5_000, cacheTokens: 80_000, cost: 1.32 },
      ],
      sessions: [
        { sessionID: "ses_root", root: true as const, inputTokens: 900_000, outputTokens: 38_000, cacheTokens: 800_000, cost: 1.9, steps: 14,
          models: [
            { model: "surplus/deepseek-4.1", inputTokens: 700_000, outputTokens: 30_000, cacheTokens: 600_000, cost: 1.4 },
            { model: "surplus/glm-5.3", inputTokens: 200_000, outputTokens: 8_000, cacheTokens: 200_000, cost: 0.5 },
          ] },
        { sessionID: "ses_explore", agent: "explore", inputTokens: 200_000, outputTokens: 5_000, cacheTokens: 100_000, cost: 1.0, steps: 3,
          models: [{ model: "surplus/glm-5.3", inputTokens: 200_000, outputTokens: 5_000, cacheTokens: 100_000, cost: 1.0 }] },
        { sessionID: "ses_qa", agent: "browser-qa", inputTokens: 100_000, outputTokens: 2_000, cacheTokens: 80_000, cost: 0.52, steps: 1,
          models: [{ model: "opencode/glm-5.3-flash", inputTokens: 100_000, outputTokens: 2_000, cacheTokens: 80_000, cost: 0.52 }] },
      ],
    },
    siteUrl: "https://sites.example.invalid/koi/", repoUrl: "https://git.example.invalid/site-koi",
  };
  const member = turnPanelSections({ result }, undefined, "turn").find((section) => section.key === "usage")!;
  assert.ok(member, "a turn with provider counts has a usage page");
  assert.match(member.text, /`deepseek-4\.1`: in 1M · out 40k/);
  assert.match(member.text, /`glm-5\.3`: in 200k · out 5k/);
  assert.match(member.text, /Root turn \(deepseek-4\.1, glm-5\.3\): in 900k · out 38k · 14 steps/, "a mid-session failover names both models");
  assert.match(member.text, /🤖 explore \(glm-5\.3\): in 200k · out 5k · 3 steps/);
  assert.match(member.text, /🤖 browser-qa \(glm-5\.3-flash\): in 100k · out 2k · 1 step/);
  assert.doesNotMatch(member.text, /surplus|opencode\//, "a non-admin viewer sees model names without their providers");
  assert.doesNotMatch(member.text, /\$/, "a non-admin viewer never sees spend figures");

  const admin = turnPanelSections({ result }, undefined, "turn", true).find((section) => section.key === "usage")!;
  assert.match(admin.text, /Turn spend \*\*\$3\.42\*\* · \*\*\$16\.40\*\* at catalog rates/);
  assert.match(admin.text, /`surplus\/deepseek-4\.1`: in 1M · out 40k · \$2\.10 · \$16\.40 at catalog rates/,
    "admins see the provider routing, per-model spend and its catalog equivalent");
  assert.match(admin.text, /Root turn \(surplus\/deepseek-4\.1, surplus\/glm-5\.3\): in 900k · out 38k · 14 steps · \$1\.90/, "the split carries per-session models and spend for admins");
  assert.match(admin.text, /🤖 browser-qa \(opencode\/glm-5\.3-flash\): in 100k · out 2k · 1 step · \$0\.52/);

  const previousHideCosts = process.env.HIDE_COSTS;
  try {
    process.env.HIDE_COSTS = "true";
    const hidden = turnPanelSections({ result }, undefined, "turn", true).find((section) => section.key === "usage")!;
    assert.doesNotMatch(hidden.text, /\$|\*\*Cost\*\*/);
    assert.match(hidden.text, /surplus\/deepseek-4\.1/);
    assert.match(hidden.text, /in 1M/);
    const snapshot = buildingSnapshot();
    snapshot.metrics = { currentModel: "test/model", inputTokens: 100, cost: 2 };
    const live = turnPanelSections(undefined, snapshot, "turn", true).find((section) => section.key === "usage")!;
    assert.doesNotMatch(live.text, /\$|Current cost/);
    assert.match(live.text, /test\/model/);
  } finally {
    if (previousHideCosts === undefined) delete process.env.HIDE_COSTS;
    else process.env.HIDE_COSTS = previousHideCosts;
  }

  const unpriced = { ...result, usage: { ...result.usage, cost: 0, models: result.usage.models.map((entry) => ({ ...entry, cost: 0 })) } };
  const explained = turnPanelSections({ result: unpriced }, undefined, "turn", true).find((section) => section.key === "usage")!;
  assert.match(explained.text, /pricing is not reported/, "a $0 spend says why instead of reading as free");
});

test("a turn without subagent spend shows no root/subagent split", () => {
  const result = {
    name: "Koi Pond Arcade", kind: "site" as const, published: true, commitFiles: 2, additions: 10, deletions: 2,
    durationMs: 90_000,
    usage: {
      inputTokens: 900_000, outputTokens: 38_000, cacheTokens: 800_000, contextTokens: 900_000,
      contextLimit: 2_000_000, compactions: 0, steps: 14, cost: 1.9,
      models: [{ model: "surplus/deepseek-4.1", inputTokens: 900_000, outputTokens: 38_000, cacheTokens: 800_000, cost: 1.9 }],
      sessions: [{ sessionID: "ses_root", root: true as const, inputTokens: 900_000, outputTokens: 38_000, cacheTokens: 800_000, cost: 1.9, steps: 14 }],
    },
    siteUrl: "https://sites.example.invalid/koi/", repoUrl: "https://git.example.invalid/site-koi",
  };
  const sections = turnPanelSections({ result }, undefined, "turn");
  const usage = sections.find((section) => section.key === "usage")!;
  assert.doesNotMatch(usage.text, /Root & subagents/, "a lone root session adds no split: the totals already say it");
  assert.doesNotMatch(usage.text, /Root turn/, "no root line without children to split from");
});

test("the live public card names the running model without provider or spend; admin figures stay in the private details", () => {
  const state = buildingSnapshot();
  state.metrics = { ...state.metrics, models: [
    { model: "surplus/deepseek-4.1", inputTokens: 70_000, outputTokens: 5_400, cacheTokens: 60_000, cost: 0.4 },
    { model: "surplus/glm-5.3", inputTokens: 12_300, outputTokens: 800, cacheTokens: 5_840, cost: 0.02 },
  ] };
  const live = cardView(renderProgressCard(state));
  assert.match(live.text, /-# 🧠 deepseek-4\.1, glm-5\.3/, "the model identity rides the small line above the phase rail");
  assert.match(live.text, /12 steps\b/, "the footer's step count stays bare, without the model parenthetical");
  assert.doesNotMatch(live.text, /surplus\//, "the public live card never shows provider routing");
  assert.doesNotMatch(live.text, /\$/, "the public live card never shows spend");

  const bare = cardView(renderProgressCard({ ...state, metrics: { contextTokens: 28_400, contextLimit: 100_000, steps: 12 } }));
  assert.match(bare.text, /12 steps\b/, "a snapshot without per-model attribution keeps the bare step count");
  assert.doesNotMatch(bare.text, /🧠/, "no per-model attribution adds no model line");
});

test("tool errors leave the public footer for the private usage page", () => {
  const state = buildingSnapshot();
  state.toolErrors = 2;
  const footer = cardView(renderProgressCard(state)).text.split("\n").at(-1)!;
  assert.doesNotMatch(footer, /tool error/, "the public footer stays compact: tokens replaced the error count");
  const usage = progressDetailSections(state).find((section) => section.key === "usage")!;
  assert.match(usage.text, /2 tool errors/, "the count keeps a home on the private details page");
});

test("while both rates exist the live footer swaps the streaming rate with the turn average", () => {
  const state = buildingSnapshot();
  state.metrics = { ...state.metrics, liveTokensPerSecond: 62 };
  const footer = (now: number) => cardView(renderProgressCard({ ...state, now })).text.split("\n").at(-1)!;
  // The two timestamps sit in adjacent six-second alternation windows.
  assert.match(footer(1_128_000), /⚡~62t\/s/, "one window gives the slot to the streaming rate");
  assert.match(footer(1_134_000), /⚡avg~54t\/s/, "the next swaps in the turn average");
  assert.doesNotMatch(footer(1_134_000), /⚡~62/, "the slot holds one figure at a time");

  const streaming = buildingSnapshot();
  streaming.metrics = { contextTokens: 28_400, contextLimit: 100_000, steps: 1, liveTokensPerSecond: 18 };
  assert.match(cardView(renderProgressCard(streaming)).text.split("\n").at(-1)!, /⚡~18t\/s/,
    "before the first step completes only the streaming rate exists");
  assert.match(cardView(renderProgressCard(buildingSnapshot())).text.split("\n").at(-1)!, /⚡avg~54t\/s/,
    "outside a stream the average keeps its avg prefix");
});

test("usage details time the last root request and its first token", () => {
  const timed = usageDetailText({ inputTokens: 82_300, outputTokens: 6_200, cacheTokens: 65_840, steps: 12,
    lastRequestMs: 34_500, firstTokenMs: 17_300 });
  assert.match(timed, /Timing \*\*last request 34\.5s · first token 17\.3s\*\*/);

  const restored = usageDetailText({ inputTokens: 82_300, outputTokens: 6_200, steps: 12, lastRequestMs: 34_500 });
  assert.match(restored, /Timing \*\*last request 34\.5s\*\*/, "a window still times the request");
  assert.doesNotMatch(restored, /first token/, "a first token never seen streaming stays absent, never zero");

  const bare = usageDetailText({ inputTokens: 82_300, outputTokens: 6_200, steps: 12 });
  assert.doesNotMatch(bare, /Timing/, "no anchored step adds no timing row");
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
  const upload = modal.toJSON().components[1].component;
  assert.equal(upload.type, ComponentType.FileUpload);
  assert.equal(upload.max_values, 4);
  assert.equal(upload.required, false);
  assert.equal(modal.toJSON().components.length, 2, "the queue form offers no restart checkbox");
});

test("the steer form adds an unchecked stop-and-restart checkbox", () => {
  const modal = requestModal("turn", "nonce123", true);
  const checkbox = modal.toJSON().components[2].component;
  assert.equal(checkbox.type, ComponentType.Checkbox);
  assert.equal(checkbox.custom_id, "restart");
  assert.equal(checkbox.default, false, "a plain steer stays the default");
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
  const complete: QuestionDraft = { requestID: "q12", answers: [["A"], ["B"]] };
  const completeView = cardView(renderQuestionReview("turn", request as never, complete, 0));
  assert.notEqual(completeView.buttons.find((button) => button.label === "Submit all answers")?.disabled, true);
  const retry: QuestionDraft = { requestID: "q12", answers: [["A"], ["B"]] };
  const retryView = cardView(renderQuestionReview("turn", request as never, retry, 0, { requestID: "q12", status: "retry", error: "The agent is still waiting." }));
  assert.notEqual(retryView.buttons.find((button) => button.label === "Submit all answers")?.disabled, true, "a failed delivery offers submit again");
  const busy: QuestionDraft = { requestID: "q12", answers: [["A"], ["B"]] };
  const busyView = cardView(renderQuestionReview("turn", request as never, busy, 0, { requestID: "q12", status: "submitting" }));
  assert.equal(busyView.buttons.find((button) => button.label === "Submit all answers")?.disabled, true, "delivery in flight cannot double-submit");
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
