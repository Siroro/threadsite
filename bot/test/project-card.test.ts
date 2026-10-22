import assert from "node:assert/strict";
import { test } from "node:test";
import { ComponentType } from "discord.js";
import { assertV2, cardView } from "./fixtures/cards.js";
import type { ProjectRecord } from "../src/types.js";
import type { UsageTotal } from "../src/usage.js";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const { renderProjectCard } = await import("../src/project-card.js");

function record(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    threadId: "123", guildId: "1", parentChannelId: "2", displayName: "Koi Pond Arcade",
    workspacePath: "/w", siteSlug: "koi-pond-arcade", repoName: "site-koi-pond-arcade",
    sessionId: "s", projectKind: "game-2d", status: "ready",
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    updatedAt: new Date().toISOString(),
    initialPrompt: "Build a koi pond arcade game with a leaderboard",
    ...overrides,
  };
}

function usage(overrides: Partial<UsageTotal> = {}): UsageTotal {
  return {
    turns: 4, failedTurns: 1, inputTokens: 82_300, outputTokens: 6_200, cacheTokens: 65_840, cost: 1.25,
    models: new Map([
      ["surplus/glm", { model: "surplus/glm", turns: 3, inputTokens: 80_000, outputTokens: 6_000, cacheTokens: 65_000, cost: 1.2 }],
      ["opencode/qwen-free", { model: "opencode/qwen-free", turns: 1, inputTokens: 2_300, outputTokens: 200, cacheTokens: 840, cost: 0 }],
    ]),
    ...overrides,
  } as UsageTotal;
}

test("the creating preview shows the request and settings before any build work", () => {
  const card = cardView(renderProjectCard({
    project: record({ status: "creating", lastCommit: undefined, workspacePath: "", siteSlug: "", repoName: "", sessionId: "" }),
  }));
  assert.match(card.description!, /Building the first version/);
  assert.match(card.fields!.find((field) => field.name === "Original request")!.value, /Build a koi pond arcade game/);
  assert.equal(card.fields[0].name, "Project details");
  assert.match(card.fields[0].value, /Excalibur/);
  assert.equal(card.color, 0xf59e0b);
  assert.match(card.footer.text, /Reply in this thread/);
  // Model routing is operational detail: no Model field on the public card.
  assert.equal(card.fields!.find((field) => field.name === "Model"), undefined);
  // No site or repo exists yet, so no links section to dead ends.
  assert.equal(card.buttons.length, 0);
  assert.equal(card.fields!.find((field) => field.name === "Lifetime usage"), undefined);
});

test("a live project puts settings before the request and shows version, links and lifetime usage", () => {
  const card = cardView(renderProjectCard({
    project: record({
      multiplayerGameId: "koi-pond-arcade",
      lastCommit: "abc1234",
      lastTurnAt: new Date(Date.now() - 3_600_000).toISOString(),
      lastTurnUsage: { contextTokens: 28_400, contextLimit: 100_000 },
    }),
    usage: usage(),
    siteUrl: "https://sites.example.invalid/koi-pond-arcade/",
    repoUrl: "https://git.example.invalid/site-koi-pond-arcade",
  }));
  assert.equal(card.color, 0x22c55e);
  assert.match(card.description!, /Live · version `abc1234` · updated <t:\d+:R>/);
  assert.match(card.fields.find((field) => field.name === "Project details")!.value, /2D static web game/);
  assert.match(card.fields[0].value, /Shared arena multiplayer/);
  assert.match(card.description!, /Created <t:\d+:R>/);
  const lifetime = card.fields!.find((field) => field.name === "Lifetime usage")!.value;
  assert.match(lifetime, /4 turns · 1 failed/);
  assert.match(lifetime, /in 82\.3k \(65\.8k cached\) · out 6\.2k/);
  assert.equal(card.buttons[0].label, "Play game");
  assert.equal(card.buttons[0].url, "https://sites.example.invalid/koi-pond-arcade/");
  assert.equal(card.buttons[1].label, "Source");
  assert.equal(card.buttons[1].url, "https://git.example.invalid/site-koi-pond-arcade");
  // Spend and model routing stay admin-only: the pinned card is public.
  assert.doesNotMatch(JSON.stringify(card), /\$|1\.25|"cost"/);
  assert.doesNotMatch(JSON.stringify(card), /opencode\/|surplus\/|glm|qwen/i);
});

test("an errored project says so and keeps the card useful", () => {
  const card = cardView(renderProjectCard({
    project: record({ status: "error", lastCommit: "abc1234", lastTurnAt: new Date().toISOString() }),
    siteUrl: "https://sites.example.invalid/koi-pond-arcade/",
  }));
  assert.equal(card.color, 0xef4444);
  assert.match(card.description!, /last turn failed/);
  assert.match(card.description!, /previously published version is unchanged/);
  // The links stay: the site is still live on its last good version.
  assert.equal(card.buttons[0].label, "Play game");
});

test("missing provider counts are shown as unavailable instead of claiming zero usage", () => {
  const card = cardView(renderProjectCard({ project: record(), usage: usage({ inputTokens: 0, outputTokens: 0, cacheTokens: 0 }) }));
  const lifetime = card.fields!.find((field) => field.name === "Lifetime usage")!.value;
  assert.match(lifetime, /4 turns · 1 failed · token counts unavailable/);
  assert.doesNotMatch(lifetime, /in 0|out 0/);
});

test("a missing prompt degrades gracefully instead of rendering empty", () => {
  const card = cardView(renderProjectCard({ project: record({ initialPrompt: undefined }) }));
  assert.match(card.fields!.find((field) => field.name === "Original request")!.value, /\*\(not recorded\)\*/);
});

test("game settings name the dimension, engine and chosen multiplayer architecture", () => {
  const details = (overrides: Partial<ProjectRecord>) => cardView(renderProjectCard({ project: record(overrides) })).fields[0].value;
  assert.match(details({ multiplayerGameId: "koi-pond-arcade" }), /Shared arena multiplayer/);
  assert.match(details({ multiplayerMode: undefined, multiplayerGameId: undefined }), /Shared arena multiplayer/);
  assert.match(details({ multiplayerMode: "rooms" }), /Invite-code rooms/);
  assert.match(details({ multiplayerMode: "singleplayer", multiplayerGameId: undefined }), /Singleplayer only/);
  assert.match(details({ multiplayerMode: "arena" }), /Shared arena multiplayer/);
  assert.match(details({ projectKind: "game-3d" }), /3D.*\n.*Three.js/);
  assert.doesNotMatch(details({ projectKind: "site", multiplayerMode: "arena" }), /Multiplayer|Engine/);
  assert.doesNotMatch(details({ projectKind: undefined }), /Engine/);
});

test("the pinned card shows advisory QA status and keeps long requests within field limits", () => {
  const card = cardView(renderProjectCard({ project: record({ initialPrompt: "request ".repeat(1000), browserQaFindings: {
    checkedAt: new Date().toISOString(), findings: ["runtime finding", "missing asset"],
  } }) }));
  assert.match(card.fields!.find((field) => field.name === "Browser QA")!.value, /Advisory · 2 findings · checked <t:\d+:R>/);
  assert.ok(card.fields!.every((field) => field.value.length <= 1024));

});

test("pinned cards use only V2 components, safe buttons and bounded text", () => {
  const message = renderProjectCard({
    project: record({ displayName: "Koi\n## @everyone", initialPrompt: "request ".repeat(1000) }),
    usage: usage(), siteUrl: "javascript:alert(1)", repoUrl: "https://user:secret@example.invalid/",
  });
  assertV2(message);
  const card = cardView(message);
  assert.equal(card.components[0].type, ComponentType.Container);
  assert.equal(card.buttons.length, 0);
  assert.equal((card.title!.match(/\n/g) ?? []).length, 0);
});
