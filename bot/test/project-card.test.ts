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
    turns: 4, failedTurns: 1, inputTokens: 82_300, outputTokens: 6_200, cacheTokens: 65_840, cost: 1.25, catalogCost: 9.8,
    models: new Map([
      ["surplus/glm", { model: "surplus/glm", turns: 3, inputTokens: 80_000, outputTokens: 6_000, cacheTokens: 65_000, cost: 1.2, catalogCost: 9.8 }],
      ["opencode/qwen-free", { model: "opencode/qwen-free", turns: 1, inputTokens: 2_300, outputTokens: 200, cacheTokens: 840, cost: 0 }],
    ]),
    ...overrides,
  } as UsageTotal;
}

test("a live project links its site and repo and carries lifetime spend with model names", () => {
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
  const lifetime = card.fields!.find((field) => field.name === "Lifetime usage")!.value;
  assert.ok(lifetime.length > 0);
  assert.equal(card.buttons[0].url, "https://sites.example.invalid/koi-pond-arcade/");
  assert.equal(card.buttons[1].url, "https://git.example.invalid/site-koi-pond-arcade");
  // Spend is public on the pinned card: the ledgered total, then each model
  // that billed anything — a surplus model with its catalog-rate equivalent,
  // an unpriced free-tier model not at all.
  const cost = card.fields!.find((field) => field.name === "Lifetime cost")!.value;
  assert.match(cost, /\*\*Total \$1\.25\*\* · \$9\.80 at catalog rates/);
  assert.match(cost, /`glm`: \$1\.20 on surplus · \$9\.80 at catalog rates/);
  assert.doesNotMatch(cost, /qwen/, "a model that billed nothing earns no line");
  // Provider routing still stays off the public card.
  assert.doesNotMatch(JSON.stringify(card), /opencode\/|surplus\//);
});

test("a project where nothing was priced carries no cost field at all", () => {
  const card = cardView(renderProjectCard({ project: record(), usage: usage({
    cost: 0, catalogCost: 0,
    models: new Map([["opencode/qwen-free", { model: "opencode/qwen-free", turns: 1, inputTokens: 100, outputTokens: 10, cacheTokens: 0, cost: 0 }]]),
  }) }));
  assert.match(card.fields!.find((field) => field.name === "Lifetime usage")!.value, /4 turns/);
  assert.equal(card.fields!.some((field) => field.name === "Lifetime cost"), false, "a $0 project shows no cost field");
});

test("missing provider counts are shown as unavailable instead of claiming zero usage", () => {
  const card = cardView(renderProjectCard({ project: record(), usage: usage({ inputTokens: 0, outputTokens: 0, cacheTokens: 0 }) }));
  const lifetime = card.fields!.find((field) => field.name === "Lifetime usage")!.value;
  assert.match(lifetime, /4 turns · 1 failed · token counts unavailable/);
  assert.doesNotMatch(lifetime, /in 0|out 0/);
});

test("the pinned card shows advisory QA status and keeps long requests within field limits", () => {
  const card = cardView(renderProjectCard({ project: record({ initialPrompt: "request ".repeat(1000), browserQaFindings: {
    checkedAt: new Date().toISOString(), findings: ["runtime finding", "missing asset"],
  } }) }));
  assert.ok(card.fields!.every((field) => field.value.length <= 1024));

});

test("game cards offer the relay-state wipe button and show who may use it; site cards have neither", () => {
  const game = cardView(renderProjectCard({ project: record(), usage: usage() }));
  assert.ok(game.buttons.some((button) => button.custom_id === "ts2:wipe:123"), "the game card carries the Wipe state button");
  assert.match(game.fields!.find((field) => field.name === "Project details")!.value, /\*\*Reset state\*\* · Owner & admins/);
  const open = cardView(renderProjectCard({ project: record({ collaboration: { mode: "open", userIds: [], revision: 1, wipePolicy: "anyone" } }), usage: usage() }));
  assert.match(open.fields!.find((field) => field.name === "Project details")!.value, /\*\*Reset state\*\* · Anyone in the thread/);
  const site = cardView(renderProjectCard({ project: record({ projectKind: "site" }), usage: usage() }));
  assert.ok(site.buttons.every((button) => !button.custom_id?.includes("wipe")));
  assert.doesNotMatch(site.fields!.find((field) => field.name === "Project details")!.value, /Reset state/);
});

test("pinned cards use only V2 components, safe buttons and bounded text", () => {
  const message = renderProjectCard({
    project: record({ displayName: "Koi\n## @everyone", initialPrompt: "request ".repeat(1000) }),
    usage: usage(), siteUrl: "javascript:alert(1)", repoUrl: "https://user:secret@example.invalid/",
  });
  assertV2(message);
  const card = cardView(message);
  assert.equal(card.components[0].type, ComponentType.Container);
  assert.equal(card.buttons.filter((button) => button.url).length, 0);
  assert.equal((card.title!.match(/\n/g) ?? []).length, 0);
});

test("the pinned card links the starter and counts each user's contributions, busiest first", () => {
  const card = cardView(renderProjectCard({ project: record({
    starterId: "100000000000000001",
    contributors: {
      "100000000000000001": { turns: 3, steers: 0, answers: 2 },
      "100000000000000002": { turns: 1, steers: 1, answers: 0 },
      "100000000000000003": { turns: 0, steers: 0, answers: 0 },
    },
  }) }));
  const contributors = card.fields!.find((field) => field.name === "Contributors")!;
  assert.match(contributors.value, /\*\*Started by\*\* <@100000000000000001>/);
  // The zero-count user is not listed, and the rest sort by total contributions.
  assert.equal(contributors.value, "**Started by** <@100000000000000001>\n"
    + "<@100000000000000001> · 3 turns · 2 answers\n"
    + "<@100000000000000002> · 1 turn · 1 steer");
  assert.doesNotMatch(contributors.value, /100000000000000003/);
});

test("a busy thread summarizes contributors past eight rows", () => {
  const contributors = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
    `3${index}0000000000000000`, { turns: 10 - index, steers: 0, answers: 0 },
  ]));
  const card = cardView(renderProjectCard({ project: record({ contributors: contributors as ProjectRecord["contributors"] }) }));
  const field = card.fields!.find((entry) => entry.name === "Contributors")!;
  assert.match(field.value, /<@300000000000000000> · 10 turns/);
  assert.match(field.value, /\+2 more contributors/);
  assert.doesNotMatch(field.value, /390000000000000000/);
});
