import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-relay-delete-"));
const tokenFile = path.join(root, "token");
const state = path.join(root, "state");
const token = "a".repeat(64);
await fs.writeFile(tokenFile, token);
await fs.mkdir(state);
await fs.writeFile(path.join(state, "keep-game.json"), JSON.stringify({ version: 1, gameId: "keep-game", savedAt: Date.now(), state: { keep: true } }));
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
  ws.send(JSON.stringify({ t: "join", v: 4, mode: "single", game, name: "Test" }));
  await waitFor(() => frames.some((frame) => frame.t === "welcome" || frame.t === "error"));
  return { ws, frame: frames[0], frames };
}
try {
  await start();
  const host = await connect("delete-game");
  host.ws.send(JSON.stringify({ t: "world", generation: host.frame.generation, epoch: host.frame.epoch, s: { secret: "deleted project state" } }));
  await waitFor(() => fs.access(path.join(state, "delete-game.json")).then(() => true, () => false));
  assert.equal((await fetch(`${origin}/admin/games/delete-game`, { method: "DELETE" })).status, 403);
  assert.equal((await fetch(`${origin}/admin/games/delete-game`, { method: "DELETE", headers: { Authorization: "Bearer wrong" } })).status, 403);
  const closed = once(host.ws, "close");
  const remove = () => fetch(`${origin}/admin/games/delete-game`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await remove()).status, 204);
  assert.equal((await closed)[0], 4004);
  assert.equal((await remove()).status, 204, "deletion is idempotent");
  await assert.rejects(fs.access(path.join(state, "delete-game.json")), { code: "ENOENT" });
  assert.equal((await connect("delete-game")).frame.code, "project_deleted");
  assert.deepEqual((await connect("keep-game")).frame.world.s, { keep: true });
  for (const ws of sockets) ws.terminate();
  await stop();
  await start();
  assert.equal((await connect("delete-game")).frame.code, "project_deleted", "stale clients stay blocked after restart");
  assert.deepEqual((await connect("keep-game")).frame.world.s, { keep: true });
  assert.deepEqual((await fs.readdir(state)).sort(), ["delete-game.deleted", "keep-game.json"]);
  console.log("PASS: authenticated game deletion, disconnected players, no state resurrection, restart durability and unrelated-game preservation.");
} finally {
  for (const ws of sockets) ws.terminate();
  await stop();
  await fs.rm(root, { recursive: true, force: true });
}
