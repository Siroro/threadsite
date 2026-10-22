import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TurnCardState } from "../src/turn-card.js";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const { renderTechnicalCard, renderPlayCard, renderTechnicalText, renderPlayText } = await import("../src/turn-card.js");
const { changelogTemplate, descriptionTemplate, readProjectChangelog, readProjectDescription } = await import("../src/project-docs.js");

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
  assert.equal(message.embeds.length, 1);
  assert.equal(message.files.length, 0, "the technical card carries no screenshot");
  const card = message.embeds[0].toJSON();
  assert.match(card.title!, /Koi Pond Arcade/);
  assert.match(card.description!, /Added a persistent leaderboard/);
  const turn = card.fields!.find((field) => field.name === "Turn")!;
  assert.match(turn.value, /abc1234def/);
  assert.match(turn.value, /4 files changed \(\+220\/−18\)/);
  assert.match(turn.value, /⏱️ 1m/);
  const usage = card.fields!.find((field) => field.name === "Usage")!;
  assert.match(usage.value, /12\.0k in · 4\.0k out/);
  assert.match(usage.value, /18 model steps/);
});

test("the technical card keeps the agent's whole report", () => {
  const report = "x".repeat(3500);
  const card = renderTechnicalCard(state({ summary: report })).embeds[0].toJSON();
  assert.equal(card.description!.length, 3500, "a long report is not cut for the card");
});

test("the new message carries the playable card, the screenshot and the play link", () => {
  const message = renderPlayCard(state());
  assert.equal(message.embeds.length, 1);
  assert.equal(message.files.length, 1);
  const card = message.embeds[0].toJSON();
  assert.match(card.title!, /Play Koi Pond Arcade/);
  assert.match(card.description!, /feed koi and race them/);
  // The changelog heading names its own field: it says what changed far
  // better than a generic "What's new".
  const whatsNew = card.fields!.find((field) => field.name === "Leaderboard")!;
  assert.match(whatsNew.value, /top ten koi/);
  assert.match(card.fields!.find((field) => field.name === "How to play")!.value, /steer your koi/);
  assert.match(card.fields!.find((field) => field.name === "Links")!.value, /PLAY GAME/);
  assert.match(card.footer!.text, /shared arena multiplayer/);
  assert.equal(card.image?.url, "attachment://preview.png");
});

test("authored markdown is rendered as prose, not as the agent's hard-wrapped lines", () => {
  const card = renderPlayCard(state({
    description: { pitch: "A calm pond where you feed koi\nand race them across\nlily pads.", play: "Drop food with a click.\nSteer with the arrow keys." },
    changelog: { title: "Leaderboard", body: "Added a leaderboard\nfor the top ten koi." },
  })).embeds[0].toJSON();
  assert.equal(card.description, "A calm pond where you feed koi and race them across lily pads.");
  assert.equal(card.fields!.find((field) => field.name === "How to play")!.value, "Drop food with a click. Steer with the arrow keys.");
  assert.equal(card.fields!.find((field) => field.name === "Leaderboard")!.value, "Added a leaderboard for the top ten koi.");
});

test("the playable card still renders without a screenshot, a description or a changelog", () => {
  const message = renderPlayCard(state({ screenshot: undefined, description: undefined, changelog: undefined }));
  assert.equal(message.files.length, 0);
  const card = message.embeds[0].toJSON();
  assert.equal(card.image, undefined);
  assert.equal(card.description, undefined);
  assert.equal(card.fields!.find((field) => field.name === "Leaderboard"), undefined);
  assert.equal(card.fields!.find((field) => field.name === "How to play"), undefined);
  // The play link is the one thing the card must never lose.
  assert.match(card.fields!.find((field) => field.name === "Links")!.value, /PLAY GAME/);
});

test("a project without a description still shows the original brief", () => {
  const card = renderPlayCard(state({ description: undefined, request: "Build a koi pond arcade game" })).embeds[0].toJSON();
  assert.match(card.description!, /Build a koi pond arcade game/);
});

test("a turn that did not publish is marked and its findings are shown", () => {
  const card = renderTechnicalCard(state({ published: false, findings: ["preview rendered a blank page"] })).embeds[0].toJSON();
  assert.match(card.title!, /^⚠️/);
  const qa = card.fields!.find((field) => field.name === "Browser QA")!;
  assert.match(qa.value, /1 finding/);
  assert.match(qa.value, /blank page/);
});

test("a site says open site, and a note is kept as its own field", () => {
  const technical = renderTechnicalCard(state({ kind: "site", note: "Every message in this thread edits this site." })).embeds[0].toJSON();
  assert.match(technical.fields!.find((field) => field.name === "Note")!.value, /edits this site/);
  const play = renderPlayCard(state({ kind: "site" })).embeds[0].toJSON();
  assert.match(play.title!, /Open Koi Pond Arcade/);
  assert.match(play.fields!.find((field) => field.name === "Links")!.value, /OPEN SITE/);
  assert.match(play.fields!.find((field) => field.name === "What to look at")!.value, /steer your koi/);
});

test("the text fallback keeps the same facts for servers without embed links", () => {
  const technical = renderTechnicalText(state()).content;
  assert.match(technical, /Koi Pond Arcade/);
  assert.match(technical, /Added a persistent leaderboard/);
  assert.match(technical, /abc1234def/);
  assert.ok(technical.length <= 1990);
  const play = renderPlayText(state()).content;
  assert.match(play, /feed koi and race them/);
  assert.match(play, /How to play/);
  assert.match(play, /PLAY GAME/);
  assert.ok(play.length <= 1990);
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
