import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const { BACKGROUND_AGENTS, BROWSER_PERMISSION_ACTION, BROWSER_TOOL_PATTERN, BUILDER_AGENT, PLUGIN_ID } =
  await import("../src/opencode-contract.js");

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

test("the plugin's background-agent set matches the bot's turn-ownership list", () => {
  const plugin = read("opencode/v2/plugin.mjs");
  const match = /backgroundAgents = new Set\(\[([^\]]+)\]\)/.exec(plugin);
  assert.ok(match, "plugin.mjs builds its background-agent set from an inline array");
  const serviceAgents = match![1]!.split(",").map((entry) => entry.trim().replaceAll('"', ""));
  assert.deepEqual([...serviceAgents].sort(), [...BACKGROUND_AGENTS].sort(),
    "opencode/v2/plugin.mjs and src/opencode-contract.ts must list the same background agents");
});

test("the builder agent name is the one the plugin and native config route on", () => {
  const plugin = read("opencode/v2/plugin.mjs");
  assert.match(plugin, /"sitebuilder"/, "plugin.mjs routes sitebuilder-specific tool policy");
  const nativeConfig = read("opencode/opencode.json") as unknown as { agents: Record<string, unknown> };
  assert.ok(Object.keys(JSON.parse(nativeConfig as unknown as string).agents).includes(BUILDER_AGENT),
    "opencode.json defines the builder agent the bot prompts as");
});

test("browser permission actions exist on both sides of the service boundary", () => {
  const plugin = read("opencode/v2/plugin.mjs");
  assert.ok(plugin.includes(`"${BROWSER_PERMISSION_ACTION}"`), "plugin tags tools with the bot's browser action");
  assert.ok(plugin.includes(BROWSER_TOOL_PATTERN), "plugin recognizes the Playwright tool pattern");
  const nativeConfig = JSON.parse(read("opencode/opencode.json"));
  const actions = JSON.stringify(nativeConfig);
  assert.ok(actions.includes(BROWSER_PERMISSION_ACTION), "opencode.json rulesets use the browser action");
  assert.ok(actions.includes("playwright"), "opencode.json rulesets cover Playwright tools");
});

test("the plugin id the harness waits for is the one the service registers", () => {
  const plugin = read("opencode/v2/plugin.mjs");
  assert.match(plugin, /id:\s*["']threadsite\.v2["']/, "plugin registers the id the bot's configure() waits for");
});
