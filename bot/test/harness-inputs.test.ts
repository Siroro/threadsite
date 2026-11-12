import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const { skillNames } = await import("../src/skills.js");
const { enginePackages } = await import("../src/engines.js");

const botRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the curated skill list is exactly the bot/assets/skills directory", () => {
  const skillsDir = path.join(botRoot, "assets", "skills");
  const onDisk = new Set(readdirSync(skillsDir).filter((name) => {
    if (!statSync(path.join(skillsDir, name)).isDirectory()) return false;
    return readdirSync(path.join(skillsDir, name)).includes("SKILL.md");
  }));
  const curated = new Set([...skillNames("game-2d"), ...skillNames("game-3d")]);
  assert.deepEqual([...onDisk].sort(), [...curated].sort(),
    "every skill directory ships for some project kind, and no listed skill is missing on disk");
});

test("engine package versions match the bot's own dependency pins", () => {
  const manifest = JSON.parse(readFileSync(path.join(botRoot, "package.json"), "utf8"));
  const pinned = { ...manifest.dependencies, ...manifest.devDependencies } as Record<string, string>;
  for (const pkg of enginePackages("game-3d").concat(enginePackages("game-2d"))) {
    assert.equal(pkg.version, pinned[pkg.name],
      `engines.ts manifest for ${pkg.name} must match the installed package version`);
  }
});
