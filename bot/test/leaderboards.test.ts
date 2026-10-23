import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { testRootSetup } from "./fixtures/root.js";

const root = testRootSetup("leaderboards");
const { ensureLeaderboardFiles } = await import("../src/leaderboards.js");
const { buildSite } = await import("../src/build.js");
const { validateSite, publishSite } = await import("../src/publish.js");
const { config } = await import("../src/config.js");

test("singleplayer games build and publish with the small global leaderboard client and preserve authored source", async () => {
  const dir = path.join(root, "singleplayer");
  assert.equal(await ensureLeaderboardFiles(dir, "game-2d", "global-game"), true);
  assert.equal(await ensureLeaderboardFiles(dir, "game-2d", "global-game"), false);
  await assert.rejects(fs.access(path.join(dir, "site/net")), { code: "ENOENT" });
  const injected = await import(pathToFileURL(path.join(dir, "site/leaderboards/leaderboards-config.js")).href);
  assert.equal(injected.LEADERBOARDS_CONFIG.game, "global-game");
  assert.equal(injected.LEADERBOARDS_CONFIG.url, config.gameserverPublicUrl);
  await fs.mkdir(path.join(dir, "site/src"));
  const source = 'import { ThreadSiteLeaderboards } from "../leaderboards/threadsite-leaderboards.js";\n'
    + 'import { LEADERBOARDS_CONFIG } from "../leaderboards/leaderboards-config.js";\n'
    + 'const boards = new ThreadSiteLeaderboards(LEADERBOARDS_CONFIG);\n'
    + 'void boards.list("points-v1").catch(() => {});\n';
  await fs.writeFile(path.join(dir, "site/src/main.ts"), source);
  await fs.writeFile(path.join(dir, "site/index.html"), '<html><body><script type="module" src="js/main.js"></script></body></html>');
  const client = path.join(dir, "site/leaderboards/threadsite-leaderboards.js");
  await fs.writeFile(client, "corrupted harness input");
  assert.equal(await ensureLeaderboardFiles(dir, "game-2d", "global-game"), true);
  await buildSite(dir);
  await validateSite(path.join(dir, "site"));
  await publishSite(path.join(dir, "site"), "global-game");
  await fs.access(path.join(config.publishRoot, "global-game/js/main.js"));
  await assert.rejects(fs.access(path.join(config.publishRoot, "global-game/leaderboards")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(dir, "site/src/main.ts"), "utf8"), source);
  await fs.writeFile(path.join(dir, "site/src/main.ts"), source + '\nboards.submit("points-v1", "wrong");\n');
  await buildSite(dir);
  await assert.rejects(validateSite(path.join(dir, "site")), /not assignable to parameter of type 'number'/);
});

test("websites receive no leaderboard wiring", async () => {
  const dir = path.join(root, "site-only");
  assert.equal(await ensureLeaderboardFiles(dir, "site", "some-site"), false);
  await assert.rejects(fs.access(dir), { code: "ENOENT" });
});
