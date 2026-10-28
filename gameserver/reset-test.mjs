import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-relay-reset-"));
const tokenFile = path.join(root, "token");
const state = path.join(root, "state");
const token = "b".repeat(64);
const playerToken = "c".repeat(64);
const otherToken = "d".repeat(64);
await fs.writeFile(tokenFile, token);
await fs.mkdir(state);
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
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
async function stop() { if (child) { child.kill("SIGTERM"); await exited; child = undefined; } }
async function connect(game) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); sockets.push(ws);
  const frames = [];
  ws.on("message", (bytes) => frames.push(JSON.parse(String(bytes))));
  await once(ws, "open");
  ws.send(JSON.stringify({ t: "join", v: 4, mode: "single", game, name: "Test", playerToken }));
  await waitFor(() => frames.some((frame) => frame.t === "welcome" || frame.t === "error"));
  return { ws, frame: frames[0], frames };
}
async function board(op, game, extra = {}, tokenForPlayer = playerToken) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); sockets.push(ws);
  const frames = [];
  ws.on("message", (bytes) => frames.push(JSON.parse(String(bytes))));
  await once(ws, "open");
  ws.send(JSON.stringify({ t: "leaderboard", v: 1, id: `lb-${op}`, op, game, playerToken: tokenForPlayer, ...extra }));
  await waitFor(() => frames.some((frame) => frame.t === "leaderboard-result"));
  ws.terminate();
  return frames.find((frame) => frame.t === "leaderboard-result").result;
}
const reset = (headers) => fetch(`${origin}/admin/games/reset-game/reset`, { method: "POST", headers });
try {
  await start();
  const keeper = await connect("keep-game");
  keeper.ws.send(JSON.stringify({ t: "world", generation: keeper.frame.generation, epoch: keeper.frame.epoch, s: { keep: true } }));
  await waitFor(async () => (await (await fetch(`${origin}/health`)).json()).durableWorlds === 1);
  const durableCount = async () => (await (await fetch(`${origin}/health`)).json()).durableWorlds;
  const host = await connect("reset-game");
  host.ws.send(JSON.stringify({ t: "world", generation: host.frame.generation, epoch: host.frame.epoch, s: { secret: "old shared world" } }));
  await waitFor(async () => (await durableCount()) === 2);
  host.ws.send(JSON.stringify({ t: "storage", id: "s1", op: "save.set", slot: "progress", revision: 0, value: { gold: 5 } }));
  await waitFor(() => host.frames.some((frame) => frame.t === "storage-result" && frame.ok));
  assert.deepEqual((await board("board.submit", "reset-game", { board: "main", score: 100, name: "Alice", order: "desc" })).score, 100);
  assert.deepEqual((await board("board.submit", "reset-game", { board: "main", score: 200, name: "Bob", order: "desc" }, otherToken)).score, 200);
  assert.deepEqual((await board("board.submit", "keep-game", { board: "main", score: 7, name: "Kay", order: "desc" })).score, 7);
  assert.equal((await reset()).status, 403);
  assert.equal((await reset({ Authorization: "Bearer " + "0".repeat(64) })).status, 403);
  const closed = once(host.ws, "close");
  assert.equal((await reset({ Authorization: `Bearer ${token}` })).status, 204);
  assert.equal((await closed)[0], 4005, "connected players are closed with a recoverable code, not project-deleted");
  await waitFor(async () => (await durableCount()) === 1);
  const fresh = await connect("reset-game");
  assert.equal(fresh.frame.t, "welcome");
  assert.equal(fresh.frame.world, null, "a fresh join restores no durable world");
  assert.deepEqual(await board("board.list", "reset-game", { board: "main" }), { order: null, entries: [] }, "scores are wiped");
  fresh.ws.send(JSON.stringify({ t: "storage", id: "s2", op: "save.get", slot: "progress" }));
  await waitFor(() => fresh.frames.some((frame) => frame.t === "storage-result"));
  const save = fresh.frames.find((frame) => frame.t === "storage-result");
  assert.equal(save.ok, true);
  assert.deepEqual(save.result.value, { gold: 5 }, "private save slots survive the reset");
  assert.deepEqual((await board("board.list", "keep-game", { board: "main" })).entries.map((entry) => entry.score), [7], "other games keep their scores");
  assert.equal((await reset({ Authorization: `Bearer ${token}` })).status, 204, "reset is idempotent");
  for (const ws of sockets) ws.terminate();
  await stop();
  await start();
  const afterRestart = await connect("reset-game");
  assert.equal(afterRestart.frame.t, "welcome", "a reset never tombstones the project");
  assert.equal(afterRestart.frame.world, null, "the old world does not resurrect from disk after a restart");
  assert.deepEqual((await connect("keep-game")).frame.world.s, { keep: true });
  // Per-game scopes are independent: a world-only reset keeps scores, and a
  // scores-only reset keeps the world and leaves connected players alone.
  const resetOne = (query = "", headers) => fetch(`${origin}/admin/games/reset-game/reset${query}`, { method: "POST", headers });
  afterRestart.ws.send(JSON.stringify({ t: "world", generation: afterRestart.frame.generation, epoch: afterRestart.frame.epoch, s: { secret: "scoped world" } }));
  await waitFor(async () => (await durableCount()) === 2);
  await board("board.submit", "reset-game", { board: "main", score: 30, name: "Alice", order: "desc" });
  assert.equal((await resetOne("?scope=nonsense", { Authorization: `Bearer ${token}` })).status, 400, "an unknown scope is rejected instead of clearing everything");
  assert.equal(await durableCount(), 2);
  assert.equal((await board("board.list", "reset-game", { board: "main" })).entries.length, 1);
  const closedWorld = once(afterRestart.ws, "close");
  assert.equal((await resetOne("?scope=world", { Authorization: `Bearer ${token}` })).status, 204);
  assert.equal((await closedWorld)[0], 4005);
  await waitFor(async () => (await durableCount()) === 1);
  assert.deepEqual((await board("board.list", "reset-game", { board: "main" })).entries.map((entry) => entry.score), [30], "a world reset keeps scores");
  const host2 = await connect("reset-game");
  assert.equal(host2.frame.world, null);
  host2.ws.send(JSON.stringify({ t: "world", generation: host2.frame.generation, epoch: host2.frame.epoch, s: { secret: "kept world" } }));
  await waitFor(async () => (await durableCount()) === 2);
  assert.equal((await resetOne("?scope=scores", { Authorization: `Bearer ${token}` })).status, 204);
  assert.deepEqual(await board("board.list", "reset-game", { board: "main" }), { order: null, entries: [] });
  assert.equal(host2.ws.readyState, 1, "a scores-only reset leaves connected players alone");
  assert.equal(await durableCount(), 2);
  // Relay-wide reset: the scores-only sweep spares worlds, the full sweep clears both.
  await board("board.submit", "keep-game", { board: "main", score: 9, name: "Kay", order: "desc" });
  await board("board.submit", "reset-game", { board: "main", score: 11, name: "Alice", order: "desc" });
  const wipeAll = (query = "", headers) => fetch(`${origin}/admin/reset${query}`, { method: "POST", headers });
  assert.equal((await wipeAll()).status, 403);
  assert.equal((await wipeAll("", { Authorization: `Bearer ${"0".repeat(64)}` })).status, 403);
  const scoresOnly = await wipeAll("?scope=scores", { Authorization: `Bearer ${token}` });
  assert.equal(scoresOnly.status, 200);
  assert.equal((await scoresOnly.json()).games, 2, "the sweep counts every known game");
  assert.deepEqual(await board("board.list", "reset-game", { board: "main" }), { order: null, entries: [] });
  assert.deepEqual(await board("board.list", "keep-game", { board: "main" }), { order: null, entries: [] });
  assert.equal(host2.ws.readyState, 1, "a scores-only sweep leaves connected players alone");
  assert.equal(await durableCount(), 2);
  const closed2 = once(host2.ws, "close");
  const full = await wipeAll("", { Authorization: `Bearer ${token}` });
  assert.equal(full.status, 200);
  assert.equal((await full.json()).games, 2);
  assert.equal((await closed2)[0], 4005);
  await waitFor(async () => (await durableCount()) === 0);
  assert.equal((await connect("reset-game")).frame.world, null);
  assert.equal((await connect("keep-game")).frame.world, null);
  console.log("PASS: authenticated game reset, scoped world/scores resets, recoverable disconnects, wiped scores with surviving saves, no state resurrection, relay-wide sweeps and unrelated-game preservation.");
} finally {
  for (const ws of sockets) ws.terminate();
  await stop();
  await fs.rm(root, { recursive: true, force: true });
}
