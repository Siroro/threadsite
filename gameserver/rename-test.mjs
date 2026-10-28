// Project renames re-key a game's relay presence: the durable arena world
// follows the new name, old names keep working as redirects for connected
// players and briefly stale published configs, and the old name's saves and
// scores are dropped. Admin wipes through an old name are refused.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-relay-rename-"));
const tokenFile = path.join(root, "token");
const state = path.join(root, "state");
const token = "e".repeat(64);
const playerToken = "f".repeat(64);
await fs.writeFile(tokenFile, token);
await fs.mkdir(state);
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const auth = { Authorization: `Bearer ${token}` };
const sockets = [];
let child;
let exited;
let output = "";
async function waitFor(check) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Relay test timed out: ${output}`);
}
async function start() {
  child = spawn(process.execPath, ["dist/server.js"], { env: { ...process.env, GAMESERVER_PORT: String(port),
    GAMESERVER_STATE_DIR: state, GAMESERVER_ADMIN_TOKEN_FILE: tokenFile, GAMESERVER_PERSIST_INTERVAL_MS: "30" }, stdio: ["ignore", "pipe", "pipe"] });
  exited = once(child, "exit");
  child.stdout.on("data", (bytes) => { output += bytes; });
  child.stderr.on("data", (bytes) => { output += bytes; });
  await waitFor(async () => (await fetch(`${origin}/health`)).ok);
}
async function stop() {
  for (const ws of sockets) ws.terminate();
  if (child) { child.kill("SIGTERM"); await exited; child = undefined; }
}
async function connect(game) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); sockets.push(ws);
  const frames = [];
  ws.on("message", (bytes) => frames.push(JSON.parse(String(bytes))));
  await once(ws, "open");
  ws.send(JSON.stringify({ t: "join", v: 4, mode: "single", game, name: "Test", playerToken }));
  await waitFor(() => frames.some((frame) => frame.t === "welcome" || frame.t === "error"));
  return { ws, frame: frames[0], frames };
}
async function board(op, game, extra = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); sockets.push(ws);
  const frames = [];
  ws.on("message", (bytes) => frames.push(JSON.parse(String(bytes))));
  await once(ws, "open");
  ws.send(JSON.stringify({ t: "leaderboard", v: 1, id: `lb-${op}-${game}`, op, game, playerToken, ...extra }));
  await waitFor(() => frames.some((frame) => frame.t === "leaderboard-result"));
  ws.terminate();
  return frames.find((frame) => frame.t === "leaderboard-result").result;
}
let storageSeq = 0;
async function storage(connection, op, fields = {}) {
  const id = `s-${++storageSeq}`;
  connection.ws.send(JSON.stringify({ t: "storage", id, op, ...fields }));
  await waitFor(() => connection.frames.some((frame) => frame.t === "storage-result" && frame.id === id));
  return connection.frames.find((frame) => frame.t === "storage-result" && frame.id === id);
}
const inventory = async () => (await fetch(`${origin}/admin/games`, { headers: auth })).json();
const durableCount = async () => (await (await fetch(`${origin}/health`)).json()).durableWorlds;
const rename = (from, query = "", headers = {}) => fetch(`${origin}/admin/games/${from}/rename${query}`, { method: "POST", headers });
const remove = (game) => fetch(`${origin}/admin/games/${game}`, { method: "DELETE", headers: auth });
async function publish(game, secret, expectedWorlds) {
  const host = await connect(game);
  host.ws.send(JSON.stringify({ t: "world", generation: host.frame.generation, epoch: host.frame.epoch, s: { secret } }));
  await waitFor(async () => (await durableCount()) === expectedWorlds);
  return host;
}

try {
  await start();
  const host = await publish("old-name-game", "moved shared world", 1);
  const saved = await storage(host, "save.set", { slot: "progress", revision: 0, value: { gold: 5 } });
  assert.equal(saved.ok, true);
  assert.equal((await board("board.submit", "old-name-game", { board: "main", score: 50, name: "Alice", order: "desc" })).score, 50);

  assert.equal((await rename("old-name-game", "?to=new-name-game")).status, 403);
  assert.equal((await rename("old-name-game", "?to=new-name-game", { Authorization: `Bearer ${"0".repeat(64)}` })).status, 403);
  assert.equal((await rename("old-name-game", "", auth)).status, 400, "a missing target name is rejected");
  assert.equal((await rename("old-name-game", "?to=Bad_Name", auth)).status, 400, "an invalid target name is rejected");
  assert.equal((await rename("old-name-game", "?to=new-name-game", auth)).status, 204);

  assert.deepEqual(await inventory(), ["new-name-game"], "the world follows the new name; an old name is not a tenant");
  assert.deepEqual(await board("board.list", "old-name-game", { board: "main" }), { order: null, entries: [] }, "the old name's scores are dropped");
  const staleSave = await storage(host, "save.get", { slot: "progress" });
  assert.equal(staleSave.ok, true);
  assert.equal(staleSave.result.value, null, "the old name's saves are dropped");

  // Old-name and new-name players land in one live room, with the world.
  const stale = await connect("old-name-game");
  assert.equal(stale.frame.t, "welcome", "an old name redirects instead of reading as deleted");
  assert.deepEqual(stale.frame.world?.s, { secret: "moved shared world" }, "the moved world reaches old-name clients");
  const fresh = await connect("new-name-game");
  assert.deepEqual(fresh.frame.world?.s, { secret: "moved shared world" });
  assert.equal(fresh.frame.peers.length, 2, "old-name and new-name players share one room");

  // A stale tab's new score lands on the renamed game's board.
  assert.equal((await board("board.submit", "old-name-game", { board: "main", score: 75, name: "Alice", order: "desc" })).score, 75);
  assert.deepEqual((await board("board.list", "new-name-game", { board: "main" })).entries.map((entry) => entry.score), [75]);

  assert.equal((await rename("old-name-game", "?to=new-name-game", auth)).status, 204, "redelivering a landed rename is idempotent");
  assert.equal((await rename("new-name-game", "?to=new-name-game", auth)).status, 204, "renaming to the current name is a no-op");

  await publish("other-game", "other world", 2);
  assert.equal((await rename("new-name-game", "?to=other-game", auth)).status, 409, "a live world owns its name");
  assert.equal((await rename("other-game", "?to=old-name-game", auth)).status, 409, "another game's redirect is not takeable");
  assert.equal((await fetch(`${origin}/admin/games/old-name-game/reset`, { method: "POST", headers: auth })).status, 409, "admin resets refuse old names");
  assert.equal((await remove("old-name-game")).status, 409, "admin deletion refuses old names");
  assert.deepEqual((await connect("old-name-game")).frame.world?.s, { secret: "moved shared world" }, "refused wipes leave the game untouched");

  await stop();
  await start();
  assert.deepEqual(await inventory(), ["new-name-game", "other-game"], "redirects and moved worlds survive a restart");
  assert.deepEqual((await connect("old-name-game")).frame.world?.s, { secret: "moved shared world" }, "the redirect survives a restart");
  assert.deepEqual((await board("board.list", "new-name-game", { board: "main" })).entries.map((entry) => entry.score), [75], "renamed-game scores survive a restart");

  // Deleting through the current name removes the game for old names too.
  assert.equal((await remove("new-name-game")).status, 204);
  assert.equal((await connect("old-name-game")).frame.code, "project_deleted");
  await stop();
  await start();
  assert.equal((await connect("old-name-game")).frame.code, "project_deleted", "deleted stays deleted for old names after a restart");

  // Renaming back to a previous name collapses the redirect instead of looping.
  await publish("first-name", "round trip", 2);
  assert.equal((await rename("first-name", "?to=second-name", auth)).status, 204);
  assert.equal((await rename("second-name", "?to=first-name", auth)).status, 204);
  assert.deepEqual((await connect("second-name")).frame.world?.s, { secret: "round trip" }, "the collapsed name still redirects");
  const inventoryAfterRoundTrip = await inventory();
  assert.ok(inventoryAfterRoundTrip.includes("first-name") && !inventoryAfterRoundTrip.includes("second-name"));

  // A name still tombstoned by a deleted project is taken over completely.
  await publish("dead-game", "dead world", 3);
  assert.equal((await remove("dead-game")).status, 204);
  assert.equal((await rename("other-game", "?to=dead-game", auth)).status, 204);
  assert.deepEqual((await connect("dead-game")).frame.world?.s, { secret: "other world" }, "the takeover brings the live world");
  assert.deepEqual((await connect("other-game")).frame.world?.s, { secret: "other world" }, "the old name redirects to the taken-over world");
  console.log("PASS: authenticated game renames, redirecting old names, dropped old-name stats, shared rooms, conflicts, restart durability, rename-back collapse and tombstone takeover.");
} finally {
  for (const ws of sockets) ws.terminate();
  if (child) { child.kill("SIGTERM"); await exited; }
  await fs.rm(root, { recursive: true, force: true });
}
