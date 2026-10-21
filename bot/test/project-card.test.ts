import assert from "node:assert/strict";
import { test } from "node:test";
import { EmbedBuilder } from "discord.js";
import type { ProjectRecord } from "../src/types.js";
import type { UsageTotal } from "../src/usage.js";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const { renderProjectCard } = await import("../src/project-card.js");

function embed(options: { embeds: [EmbedBuilder] }) {
  return options.embeds[0].toJSON();
}

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
  const card = embed(renderProjectCard({
    project: record({ status: "creating", lastCommit: undefined, workspacePath: "", siteSlug: "", repoName: "", sessionId: "" }),
  }));
  assert.match(card.description!, /Building the first version/);
  assert.match(card.description!, /Build a koi pond arcade game/);
  assert.equal(card.color, 0xf59e0b);
  // The design version is bookkeeping in the stored record, not card chrome.
  assert.equal(card.footer, undefined);
  // Model routing is operational detail: no Model field on the public card.
  assert.equal(card.fields!.find((field) => field.name === "Model"), undefined);
  // No site or repo exists yet, so no links section to dead ends.
  assert.equal(card.fields!.find((field) => field.name === "Links"), undefined);
  assert.equal(card.fields!.find((field) => field.name === "Lifetime usage"), undefined);
});

test("a live project shows version, links, context, lifetime usage and the models used", () => {
  const card = embed(renderProjectCard({
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
  const projectField = card.fields!.find((field) => field.name === "Project")!.value;
  assert.match(projectField, /2D static web game/);
  assert.match(projectField, /multiplayer via the shared relay/);
  assert.match(projectField, /created <t:\d+:R>/);
  const lifetime = card.fields!.find((field) => field.name === "Lifetime usage")!.value;
  assert.match(lifetime, /4 turns · 1 failed/);
  assert.match(lifetime, /in 82\.3k \(65\.8k cached\) · out 6\.2k/);
  const links = card.fields!.find((field) => field.name === "Links")!.value;
  assert.ok(links.includes("[Open the game](https://sites.example.invalid/koi-pond-arcade/)"), `links missing site: ${links}`);
  assert.ok(links.includes("[Source](https://git.example.invalid/site-koi-pond-arcade)"), `links missing repo: ${links}`);
  // Spend and model routing stay admin-only: the pinned card is public.
  assert.doesNotMatch(JSON.stringify(card), /\$|1\.25|"cost"/);
  assert.doesNotMatch(JSON.stringify(card), /opencode\/|surplus\/|glm|qwen/i);
});

test("an errored project says so and keeps the card useful", () => {
  const card = embed(renderProjectCard({
    project: record({ status: "error", lastCommit: "abc1234", lastTurnAt: new Date().toISOString() }),
    siteUrl: "https://sites.example.invalid/koi-pond-arcade/",
  }));
  assert.equal(card.color, 0xef4444);
  assert.match(card.description!, /last turn failed/);
  assert.match(card.description!, /previously published version is unchanged/);
  // The links stay: the site is still live on its last good version.
  assert.ok(card.fields!.find((field) => field.name === "Links"));
});

test("a missing prompt degrades gracefully instead of rendering empty", () => {
  const card = embed(renderProjectCard({ project: record({ initialPrompt: undefined }) }));
  assert.match(card.description!, /\*\(not recorded\)\*/);
});

test("the project line names the chosen multiplayer architecture", () => {
  const bits = (overrides: Partial<ProjectRecord>) =>
    embed(renderProjectCard({ project: record(overrides) })).fields!.find((field) => field.name === "Project")!.value;

  // A game with no stored mode (legacy) but a relay tenant reads as arena.
  assert.match(bits({ multiplayerGameId: "koi-pond-arcade" }), /arena multiplayer via the shared relay/);
  assert.match(bits({ multiplayerMode: "rooms" }), /invite-code rooms via the shared relay/);
  assert.match(bits({ multiplayerMode: "singleplayer", multiplayerGameId: undefined }), /singleplayer only/);
  assert.match(bits({ multiplayerMode: "arena" }), /arena multiplayer via the shared relay/);
  // Sites never carry a multiplayer bit.
  assert.doesNotMatch(bits({ projectKind: "site", multiplayerMode: "arena" }), /relay|singleplayer/);
});
