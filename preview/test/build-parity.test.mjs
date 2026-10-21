import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("preview and deployment pin the same esbuild compiler", async () => {
  const [bot, preview] = await Promise.all([
    fs.readFile(new URL("../../bot/package.json", import.meta.url), "utf8"),
    fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.equal(JSON.parse(preview).dependencies.esbuild, JSON.parse(bot).dependencies.esbuild,
    "Preview and final builds must use the same esbuild version.");
});
