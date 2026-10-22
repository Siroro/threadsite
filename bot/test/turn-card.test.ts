import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ButtonStyle, ComponentType, MessageFlags } from "discord.js";
import { assertV2, cardView } from "./fixtures/cards.js";
import type { TurnCardState } from "../src/turn-card.js";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const { renderTechnicalCard, renderPlayCard } = await import("../src/turn-card.js");
const { changelogTemplate, descriptionTemplate, readProjectChangelog, readProjectDescription } = await import("../src/project-docs.js");

/** The text-display content of the playable card, joined in render order. */
function playCardText(message: ReturnType<typeof renderPlayCard>): string {
  const card = message.components[0].toJSON() as { components: Array<{ type: number; content?: string }> };
  return card.components
    .filter((component) => component.type === ComponentType.TextDisplay)
    .map((component) => component.content ?? "")
    .join("\n");
}

/** The link buttons of the playable card's single action row. */
function playCardButtons(message: ReturnType<typeof renderPlayCard>): Array<{ label?: string; url?: string; style: number }> {
  const card = message.components[0].toJSON() as { components: Array<{ type: number; components?: Array<{ label?: string; url?: string; style: number }> }> };
  return card.components.find((component) => component.type === ComponentType.ActionRow)?.components ?? [];
}

function state(overrides: Partial<TurnCardState> = {}): TurnCardState {
  return {
    name: "Koi Pond Arcade",
    kind: "game-2d",
    published: true,
    commit: "abc1234def5678",
    commitFiles: 4,
    additions: 220,
    deletions: 18,
    durationMs: 96_000,
    usage: { inputTokens: 12_000, outputTokens: 4_000, cacheTokens: 0, contextTokens: 16_000, contextLimit: 200_000, compactions: 0, steps: 18, cost: 0, models: [] },
    summary: "Added a persistent leaderboard that keeps the top ten scores between sessions.",
    findings: [],
    description: {
      pitch: "A calm pond where you feed koi and race them across lily pads.",
      play: "Click the water to drop food, then steer your koi with the arrow keys.",
    },
    changelog: { title: "Leaderboard", body: "Added a leaderboard for the top ten koi." },
    meta: "2D · shared arena multiplayer",
    siteUrl: "https://games.example.co.uk/koi-pond-arcade/",
    repoUrl: "https://git.example.co.uk/shane/site-koi-pond-arcade",
    screenshot: Buffer.from("89504e470d0a1a0a", "hex"),
    ...overrides,
  };
}

test("the turn's own message carries the technical report and nothing else", () => {
  const message = renderTechnicalCard(state());
  assertV2(message);
  assert.equal(message.files.length, 0, "the technical card carries no screenshot");
  const card = cardView(message);
  assert.match(card.title!, /Koi Pond Arcade/);
  assert.match(card.description!, /Added a persistent leaderboard/);
  const turn = card.fields!.find((field) => field.name === "Turn")!;
  assert.match(turn.value, /abc1234def/);
  assert.match(turn.value, /4 files changed \(\+220\/−18\)/);
  assert.match(turn.value, /⏱️ 1m/);
  const usage = card.fields!.find((field) => field.name === "Usage")!;
  assert.match(usage.value, /12k in · 4k out/);
  assert.match(usage.value, /18 model steps/);
  assert.equal(card.buttons.find((button) => button.label === "View commit")?.url,
    "https://git.example.co.uk/shane/site-koi-pond-arcade/commit/abc1234def5678");
});

test("the technical card keeps the agent's whole report", () => {
  const report = "x".repeat(3500);
  const card = cardView(renderTechnicalCard(state({ summary: report })));
  assert.ok(card.description!.includes(report), "a long report is not cut for the card");
});

test("the new message carries the playable card, the screenshot and the play link", () => {
  const message = renderPlayCard(state());
  assert.equal(message.flags & MessageFlags.IsComponentsV2, MessageFlags.IsComponentsV2, "the playable card is a Components V2 message");
  assert.equal(message.files.length, 1);
  const card = message.components[0].toJSON() as { type: number; accent_color?: number; components: Array<{ type: number; items?: Array<{ media: { url: string } }> }> };
  assert.equal(card.type, ComponentType.Container);
  assert.equal(card.accent_color, 0x22c55e, "the playable card shares the turn's colour");
  const text = playCardText(message);
  assert.match(text, /## 🎮 Play Koi Pond Arcade/);
  assert.match(text, /feed koi and race them/);
  // The changelog heading labels its own line: it says what changed far
  // better than a generic "What's new".
  assert.match(text, /\*\*Leaderboard\*\* — Added a leaderboard for the top ten koi\./);
  assert.match(text, /\*\*How to play\*\* — Click the water to drop food, then steer your koi/);
  assert.match(text, /-# 2D · shared arena multiplayer/);
  const gallery = card.components.find((component) => component.type === ComponentType.MediaGallery)!;
  assert.equal(gallery.items![0].media.url, "attachment://preview.png");
  // Real link buttons, not a links field.
  const buttons = playCardButtons(message);
  assert.equal(buttons[0].style, ButtonStyle.Link);
  assert.equal(buttons[0].label, "▶ Play game");
  assert.equal(buttons[0].url, "https://games.example.co.uk/koi-pond-arcade/");
  assert.equal(buttons[1].label, "Source");
  assert.equal(buttons[1].url, "https://git.example.co.uk/shane/site-koi-pond-arcade");
});

test("authored markdown is rendered as prose, not as the agent's hard-wrapped lines", () => {
  const message = renderPlayCard(state({
    description: { pitch: "A calm pond where you feed koi\nand race them across\nlily pads.", play: "Drop food with a click.\nSteer with the arrow keys." },
    changelog: { title: "Leaderboard", body: "Added a leaderboard\nfor the top ten koi." },
  }));
  const text = playCardText(message);
  assert.match(text, /A calm pond where you feed koi and race them across lily pads\./);
  assert.match(text, /Drop food with a click\. Steer with the arrow keys\./);
  assert.match(text, /Added a leaderboard for the top ten koi\./);
});

test("the playable card still renders without a screenshot, a description or a changelog", () => {
  const message = renderPlayCard(state({ screenshot: undefined, description: undefined, changelog: undefined }));
  assert.equal(message.files.length, 0);
  const card = message.components[0].toJSON() as { components: Array<{ type: number }> };
  assert.equal(card.components.some((component) => component.type === ComponentType.MediaGallery), false);
  const text = playCardText(message);
  assert.doesNotMatch(text, /feed koi/);
  assert.doesNotMatch(text, /How to play/);
  assert.doesNotMatch(text, /Leaderboard/);
  assert.match(text, /## 🎮 Play Koi Pond Arcade/);
  // The play link is the one thing the card must never lose.
  assert.equal(playCardButtons(message)[0].url, "https://games.example.co.uk/koi-pond-arcade/");
});

test("a project without a description still shows the original brief", () => {
  const message = renderPlayCard(state({ description: undefined, request: "Build a koi pond arcade game" }));
  assert.match(playCardText(message), /Build a koi pond arcade game/);
});

test("a turn that did not publish is marked and its findings are shown", () => {
  const card = cardView(renderTechnicalCard(state({ published: false, findings: ["preview rendered a blank page"] })));
  assert.match(card.title!, /^⚠️/);
  const qa = card.fields!.find((field) => field.name === "Browser QA")!;
  assert.match(qa.value, /1 finding/);
  assert.match(qa.value, /blank page/);
});

test("a site says open site, and a note is kept as its own field", () => {
  const technical = cardView(renderTechnicalCard(state({ kind: "site", note: "Every message in this thread edits this site." })));
  assert.match(technical.fields!.find((field) => field.name === "Note")!.value, /edits this site/);
  const play = renderPlayCard(state({ kind: "site" }));
  const text = playCardText(play);
  assert.match(text, /## 🛠️ Open Koi Pond Arcade/);
  assert.match(text, /\*\*What to look at\*\* — Click the water/);
  assert.equal(playCardButtons(play)[0].label, "▶ Open site");
});

test("oversized reports keep their full text in an explicit V2 file component", () => {
  const report = "A detailed report. ".repeat(800);
  const message = renderTechnicalCard(state({ summary: report, note: "note ".repeat(200), findings: ["advisory finding"] }));
  assertV2(message);
  assert.equal(message.files.length, 1);
  assert.equal(message.files[0].name, "turn-report.md");
  assert.equal(Buffer.from(message.files[0].attachment as Uint8Array).toString(), report);
  assert.match(cardView(message).text, /Full report attached/);
  const card = message.components[0].toJSON();
  assert.ok(card.components.some((component) => component.type === ComponentType.File && component.file.url === "attachment://turn-report.md"));
});

test("cards keep useful source buttons when the play URL is absent or invalid", () => {
  for (const siteUrl of ["", "javascript:alert(1)", "https://user:password@example.invalid/"]) {
    const message = renderPlayCard(state({ siteUrl }));
    assertV2(message);
    assert.deepEqual(playCardButtons(message).map((button) => button.label), ["Source"]);
  }
});

test("unpublished cards say which version opens and missing usage is unavailable", () => {
  const turn = renderTechnicalCard(state({ published: false, usage: undefined, summary: undefined }));
  const play = renderPlayCard(state({ published: false, screenshot: undefined }));
  assertV2(turn);
  assertV2(play);
  assert.match(cardView(turn).text, /Not published/);
  assert.match(cardView(turn).text, /Token counts unavailable/);
  assert.match(cardView(turn).text, /did not provide a report/);
  assert.match(cardView(play).text, /opens the previous live version/);
});

test("the project's own documents are read back as the card's blurb and its newest entry", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-docs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // A fresh project starts with the harness templates, placeholders and all.
  await fs.writeFile(path.join(root, "DESCRIPTION.md"), descriptionTemplate("Koi Pond Arcade"), "utf8");
  await fs.writeFile(path.join(root, "CHANGELOG.md"), changelogTemplate(), "utf8");
  assert.equal(await readProjectDescription(root), undefined, "an untouched template says nothing");
  assert.equal(await readProjectChangelog(root), undefined);

  await fs.writeFile(path.join(root, "DESCRIPTION.md"),
    "# Koi Pond Arcade\n\nA calm pond where you feed koi and race them across lily pads.\n\n## How to play\n\nClick the water to drop food, then steer with the arrow keys.\n", "utf8");
  await fs.writeFile(path.join(root, "CHANGELOG.md"),
    "# Changelog\n\n## Leaderboard\n\nAdded a leaderboard for the top ten koi.\n\n## First build\n\nThe pond opens.\n", "utf8");
  assert.deepEqual(await readProjectDescription(root), {
    pitch: "A calm pond where you feed koi and race them across lily pads.",
    play: "Click the water to drop food, then steer with the arrow keys.",
  });
  assert.deepEqual(await readProjectChangelog(root), {
    title: "Leaderboard",
    body: "Added a leaderboard for the top ten koi.",
  });
});
