import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const { SHARED_BUNDLE_FLAGS } = await import("../src/build.js");
const { SHARED_BUNDLE_FLAGS: previewFlags } = await import("../../preview/esbuild-options.mjs");

const botRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("preview and production compile with the same esbuild flags", () => {
  assert.deepEqual(previewFlags, SHARED_BUNDLE_FLAGS,
    "preview/esbuild-options.mjs must mirror bot/src/build.ts SHARED_BUNDLE_FLAGS");
});

test("preview and bot pin the same esbuild version", () => {
  const preview = JSON.parse(readFileSync(path.join(botRoot, "..", "preview", "package.json"), "utf8"));
  const bot = JSON.parse(readFileSync(path.join(botRoot, "package.json"), "utf8"));
  assert.equal(preview.devDependencies?.esbuild ?? preview.dependencies?.esbuild, bot.devDependencies?.esbuild ?? bot.dependencies?.esbuild);
});
