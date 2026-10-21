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
  assert.match(card.fields!.find((field) => field.name === "Original request")!.value, /Build a koi pond arcade game/);
  assert.deepEqual(card.fields!.slice(0, 3).map((field) => field.name), ["Type", "Engine", "Multiplayer"]);
  assert.equal(card.fields![1].value, "Phaser");
  assert.equal(card.color, 0xf59e0b);
  // The design version is bookkeeping in the stored record, not card chrome.
  assert.equal(card.footer, undefined);
  // Model routing is operational detail: no Model field on the public card.
  assert.equal(card.fields!.find((field) => field.name === "Model"), undefined);
  // No site or repo exists yet, so no links section to dead ends.
  assert.equal(card.fields!.find((field) => field.name === "Links"), undefined);
  assert.equal(card.fields!.find((field) => field.name === "Lifetime usage"), undefined);
});

test("a live project puts settings before the request and shows version, links and lifetime usage", () => {
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
  assert.match(card.fields!.find((field) => field.name === "Type")!.value, /2D static web game/);
  assert.equal(card.fields!.find((field) => field.name === "Multiplayer")!.value, "Shared arena multiplayer");
  assert.match(card.description!, /Created <t:\d+:R>/);
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
  assert.match(card.fields!.find((field) => field.name === "Original request")!.value, /\*\(not recorded\)\*/);
});

test("game settings name the dimension, engine and chosen multiplayer architecture", () => {
  const fields = (overrides: Partial<ProjectRecord>) => embed(renderProjectCard({ project: record(overrides) })).fields!;
  const multiplayer = (overrides: Partial<ProjectRecord>) => fields(overrides).find((field) => field.name === "Multiplayer")?.value;

  // A game with no stored mode (legacy) but a relay tenant reads as arena.
  assert.equal(multiplayer({ multiplayerGameId: "koi-pond-arcade" }), "Shared arena multiplayer");
  assert.equal(multiplayer({ multiplayerMode: undefined, multiplayerGameId: undefined }), "Shared arena multiplayer");
  assert.equal(multiplayer({ multiplayerMode: "rooms" }), "Invite-code rooms");
  assert.equal(multiplayer({ multiplayerMode: "singleplayer", multiplayerGameId: undefined }), "Singleplayer only");
  assert.equal(multiplayer({ multiplayerMode: "arena" }), "Shared arena multiplayer");
  const three = fields({ projectKind: "game-3d" });
  assert.match(three.find((field) => field.name === "Type")!.value, /3D/);
  assert.equal(three.find((field) => field.name === "Engine")!.value, "Three.js");
  assert.equal(multiplayer({ projectKind: "site", multiplayerMode: "arena" }), undefined);
  assert.equal(fields({ projectKind: undefined }).find((field) => field.name === "Engine"), undefined);
});

test("the pinned card shows advisory QA status and keeps long requests within field limits", () => {
  const card = embed(renderProjectCard({ project: record({ initialPrompt: "request ".repeat(1000), browserQaFindings: {
    checkedAt: new Date().toISOString(), errors: ["runtime finding"], notes: ["preview unavailable"],
  } }) }));
  assert.match(card.fields!.find((field) => field.name === "Browser QA")!.value, /Advisory · 2 findings · checked <t:\d+:R>/);
  assert.ok(card.fields!.every((field) => field.value.length <= 1024));
});
