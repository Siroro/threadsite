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
const { changelogTemplate, descriptionTemplate, readmeAgentTemplate, readProjectChangelog, readProjectDescription, readProjectReadmeSection, readProjectTitle, setProjectTitle, README_SECTION_MAX_BYTES } = await import("../src/project-docs.js");

/** The text-display content of the playable card, joined in render order. */
function playCardText(message: ReturnType<typeof renderPlayCard>): string {
  const card = message.components[0].toJSON() as { components: Array<{ type: number; content?: string }> };
  return card.components
    .filter((component) => component.type === ComponentType.TextDisplay)
    .map((component) => component.content ?? "")
    .join("\n");
}

/** Every button on the playable card, across its action rows. */
function playCardButtons(message: ReturnType<typeof renderPlayCard>): Array<{ label?: string; url?: string; style: number }> {
  const card = message.components[0].toJSON() as { components: Array<{ type: number; components?: Array<{ label?: string; url?: string; style: number }> }> };
  return card.components.filter((component) => component.type === ComponentType.ActionRow).flatMap((row) => row.components ?? []);
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
    resource: "status-1",
    siteUrl: "https://games.example.co.uk/koi-pond-arcade/",
    repoUrl: "https://git.example.co.uk/shane/site-koi-pond-arcade",
    screenshot: Buffer.from("89504e470d0a1a0a", "hex"),
    ...overrides,
  };
}

test("the technical card keeps the agent's whole report", () => {
  const report = "x".repeat(3500);
  const card = cardView(renderTechnicalCard(state({ summary: report })));
  assert.ok(card.description!.includes(report), "a long report is not cut for the card");
});

test("the technical card lists the turn's subagents and only offers shortcuts with details behind them", () => {
  const subagents = [
    { id: "ses_child", agent: "explore", steps: 4, status: "finished" as const, activity: "📚 Reading · site/src/arena.ts" },
    { id: "ses_qa", agent: "browser-qa", steps: 2, status: "finished" as const },
  ];
  const populated = cardView(renderTechnicalCard(state({ subagents, hasFileDetails: true, findings: ["advisory finding"] })));
  const roster = populated.fields!.find((field) => field.name === "Subagents")!;
  assert.match(roster.value, /\*\*explore\*\* · 4 steps/);
  assert.match(roster.value, /\*\*browser-qa\*\* · 2 steps/);
  for (const label of ["Changed files", "Browser findings", "Subagents"]) {
    assert.ok(populated.buttons.some((button) => button.label === label), `${label} stays one click away`);
  }
  const bare = cardView(renderTechnicalCard(state({ findings: [], hasFileDetails: undefined })));
  assert.equal(bare.fields!.some((field) => field.name === "Subagents"), false);
  for (const label of ["Changed files", "Browser findings", "Subagents"]) {
    assert.equal(bare.buttons.some((button) => button.label === label), false, `${label} has no recorded detail to show`);
  }
  assert.ok(bare.buttons.some((button) => button.label === "Turn details"), "the general details view always remains");
});

test("the new message carries the playable card, the screenshot and the play link", () => {
  const message = renderPlayCard(state());
  assert.equal(message.flags & MessageFlags.IsComponentsV2, MessageFlags.IsComponentsV2, "the playable card is a Components V2 message");
  assert.equal(message.files.length, 1);
  const card = message.components[0].toJSON() as { type: number; accent_color?: number; components: Array<{ type: number; items?: Array<{ media: { url: string } }> }> };
  assert.equal(card.type, ComponentType.Container);
  assert.equal(card.accent_color, 0x22c55e, "the playable card shares the turn's colour");
  const text = playCardText(message);
  assert.match(text, /-# 🎮 Play Koi Pond Arcade/);
  assert.match(text, /feed koi and race them/);
  // The changelog heading labels its own line: it says what changed far
  // better than a generic "What's new".
  assert.match(text, /\*\*Leaderboard\*\* — Added a leaderboard for the top ten koi\./);
  assert.doesNotMatch(text, /How to play/, "the how-to-play lives behind the card's button, not inline");
  assert.match(text, /-# 2D · shared arena multiplayer/);
  const gallery = card.components.find((component) => component.type === ComponentType.MediaGallery)!;
  assert.equal(gallery.items![0].media.url, "attachment://preview.png");
  // Real link buttons, not a links field. The expanded how-to-play is one
  // click away on the card itself.
  const buttons = playCardButtons(message);
  const howTo = buttons.find((button) => button.label === "How to play");
  assert.equal(howTo?.style, ButtonStyle.Secondary);
  assert.equal(buttons[0].style, ButtonStyle.Link);
  assert.equal(buttons[0].url, "https://games.example.co.uk/koi-pond-arcade/");
  assert.equal(buttons[1].url, "https://git.example.co.uk/shane/site-koi-pond-arcade");
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
  assert.match(text, /-# 🎮 Play Koi Pond Arcade/);
  // The play link is the one thing the card must never lose.
  assert.equal(playCardButtons(message)[0].url, "https://games.example.co.uk/koi-pond-arcade/");
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

test("the description title heading is readable and a rename rewrites only that heading", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-docs-title-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(await readProjectTitle(root), undefined, "a missing document has no title");
  await fs.writeFile(path.join(root, "DESCRIPTION.md"), descriptionTemplate("game-placeholder"), "utf8");
  assert.equal(await readProjectTitle(root), "game-placeholder");
  const body = "Pitch.\n\n## How to play\n\nPlay.\n";
  await fs.writeFile(path.join(root, "DESCRIPTION.md"), `# Starfall\n\n${body}`, "utf8");
  assert.equal(await setProjectTitle(root, "Starfall Keeper"), true);
  assert.equal(await fs.readFile(path.join(root, "DESCRIPTION.md"), "utf8"), `# Starfall Keeper\n\n${body}`);
  assert.equal(await setProjectTitle(root, "Starfall Keeper"), false, "an unchanged heading writes nothing");
  await fs.writeFile(path.join(root, "DESCRIPTION.md"), body, "utf8");
  assert.equal(await readProjectTitle(root), undefined, "no heading means no title");
  assert.equal(await setProjectTitle(root, "Koi Pond"), true, "a heading-less document gains one");
  assert.equal(await fs.readFile(path.join(root, "DESCRIPTION.md"), "utf8"), `# Koi Pond\n\n${body}`);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-docs-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "DESCRIPTION.md"), "# Escaped\n\nOutside.\n");
  await fs.rm(path.join(root, "DESCRIPTION.md"));
  try { await fs.symlink(path.join(outside, "DESCRIPTION.md"), path.join(root, "DESCRIPTION.md")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; t.diagnostic("Windows disallowed the test symlink; the heading checks above still ran."); return; }
  assert.equal(await setProjectTitle(root, "Hijacked"), false, "a symlinked document is never rewritten");
  assert.match(await fs.readFile(path.join(outside, "DESCRIPTION.md"), "utf8"), /^# Escaped$/m);
});

test("the agent README is empty until written and is bounded before it reaches README.md", async (t) => {  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-agent-readme-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "README.agent.md"), readmeAgentTemplate(), "utf8");
  assert.equal(await readProjectReadmeSection(root), undefined, "an untouched template says nothing");

  await fs.writeFile(path.join(root, "README.agent.md"), "## About\n\nFeed the koi.\n", "utf8");
  assert.equal(await readProjectReadmeSection(root), "## About\n\nFeed the koi.");

  await fs.writeFile(path.join(root, "README.agent.md"), "x".repeat(README_SECTION_MAX_BYTES * 2), "utf8");
  const bounded = await readProjectReadmeSection(root);
  assert.ok(bounded);
  assert.ok(Buffer.byteLength(bounded, "utf8") <= README_SECTION_MAX_BYTES + 200, "the appended section stays well under Forgejo's 64 KiB README limit");
  assert.match(bounded, /truncated/);
  const limited = await readProjectReadmeSection(root, 500);
  assert.ok(limited && Buffer.byteLength(limited, "utf8") <= 500, "the caller's remaining README budget includes the shortening notice");
  assert.equal(await readProjectReadmeSection(root, 0), undefined);
});
