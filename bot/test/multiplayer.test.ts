import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
process.env.MULTIPLAYER_ENABLED ||= "true";
const { multiplayerContext } = await import("../src/multiplayer.js");

test("multiplayerContext follows the chosen architecture", () => {
  assert.equal(multiplayerContext("site", "slug", "arena"), undefined, "sites never get a relay");
  assert.equal(multiplayerContext("game-2d", "slug", "singleplayer"), undefined, "singleplayer games get no relay wiring");
  const arena = multiplayerContext("game-3d", "slug");
  assert.deepEqual(arena && { mode: arena.mode, gameId: arena.gameId }, { mode: "arena", gameId: "slug" }, "omitted mode defaults to arena");
  const rooms = multiplayerContext("game-2d", "slug", "rooms");
  assert.equal(rooms?.mode, "rooms");
});

test("removeMultiplayerFiles strips the harness wiring from a singleplayer workspace", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { removeMultiplayerFiles } = await import("../src/multiplayer.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-mp-"));
  try {
    await fs.mkdir(path.join(dir, "site", "net"), { recursive: true });
    await fs.mkdir(path.join(dir, "site", "js"), { recursive: true });
    await fs.writeFile(path.join(dir, "site", "net", "threadsite-net.js"), "client");
    await fs.writeFile(path.join(dir, "site", "net", "net-config.js"), "config");
    await fs.writeFile(path.join(dir, "NETWORKING.md"), "guide");
    assert.equal(await removeMultiplayerFiles(dir), true, "reports removal");
    await assert.rejects(fs.access(path.join(dir, "site", "net")));
    await assert.rejects(fs.access(path.join(dir, "NETWORKING.md")));
    assert.equal(await removeMultiplayerFiles(dir), false, "a clean workspace is a no-op");
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
