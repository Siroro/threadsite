// Dedicated-client integration: isolated relay, no provider calls or production state.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";
import { ThreadSiteLeaderboards } from "../bot/assets/threadsite-leaderboards.js";
import { ThreadSiteNet } from "../bot/assets/threadsite-net.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-leaderboards-"));
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const url = `ws://127.0.0.1:${port}/ws`;
const origin = `http://127.0.0.1:${port}`;
const allowedOrigin = "https://sites.example.invalid";
const tokenFile = path.join(root, "admin-token");
await fs.writeFile(tokenFile, "leaderboard-test-admin");
const originalSocket = globalThis.WebSocket;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const storage = new Map();
globalThis.WebSocket = class extends WebSocket {
  constructor(endpoint) { super(endpoint, { origin: allowedOrigin }); this.on("error", () => {}); }
};
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
} });
let child, exited;
let output = "";
const clients = [];
async function until(check) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Leaderboard integration timed out: ${output}`);
}
async function start() {
  child = spawn(process.execPath, ["dist/server.js"], { cwd: import.meta.dirname, windowsHide: true,
    env: { ...process.env, GAMESERVER_HOST: "127.0.0.1", GAMESERVER_PORT: String(port),
      GAMESERVER_STATE_DIR: path.join(root, "state"), GAMESERVER_ADMIN_TOKEN_FILE: tokenFile,
      GAMESERVER_ALLOWED_ORIGINS: allowedOrigin }, stdio: ["ignore", "pipe", "pipe"] });
  exited = once(child, "exit");
  child.stdout.on("data", (bytes) => { output += bytes; });
  child.stderr.on("data", (bytes) => { output += bytes; });
  await until(async () => { try { return (await fetch(`${origin}/health`)).ok; } catch { return false; } });
}
async function stop() { if (child) { child.kill("SIGKILL"); await exited; child = undefined; } }
async function raw(fields, requestOrigin = allowedOrigin) {
  const socket = new WebSocket(url, { origin: requestOrigin });
  socket.on("error", () => {});
  try {
    await once(socket, "open");
    const response = once(socket, "message");
    socket.send(JSON.stringify({ t: "leaderboard", v: 1, id: "raw", game: "scores-game", ...fields }));
    return JSON.parse(String((await response)[0]));
  } finally { socket.close(); }
}
try {
  await start();
  const alice = new ThreadSiteLeaderboards({ game: "scores-game", url });
  await assert.rejects(alice.submit("points-v1", 100), { code: "name_required" });
  alice.setName("Alice");
  const first = await alice.submit("points-v1", 100);
  const credential = storage.get("threadsite-player-v1:scores-game");
  assert.equal(first.playerId, crypto.createHash("sha256").update(`scores-game:${credential}`).digest("hex"));
  assert.equal(alice.identityPersistent, true);
  assert.deepEqual((await alice.list("points-v1")).entries.map((entry) => entry.score), [100]);
  const stats = await (await fetch(`${origin}/stats`)).json();
  assert.equal(stats.rooms, 0, "score-only submissions must never create a room");
  assert.equal(stats.games, 0, "score-only submissions must never create a gameplay session");
  const multiplayer = await ThreadSiteNet.connect({ game: "scores-game", url, mode: "rooms", createRoom: true, name: "Alice" });
  clients.push(multiplayer);
  assert.equal(multiplayer.playerId, first.playerId, "both clients share the existing anonymous identity");
  await alice.submit("points-v1", 150);
  assert.deepEqual((await alice.list("points-v1")).entries.map((entry) => entry.score), [150]);
  storage.set("threadsite-player-v1:scores-game", crypto.randomBytes(32).toString("hex"));
  const bob = new ThreadSiteLeaderboards({ game: "scores-game", url, name: "Bob" });
  await bob.submit("points-v1", 200);
  assert.deepEqual((await alice.list("points-v1")).entries.map((entry) => entry.name), ["Bob", "Alice"]);
  const otherGame = new ThreadSiteLeaderboards({ game: "other-game", url, name: "Other" });
  assert.deepEqual((await otherGame.list("points-v1")).entries, []);
  assert.deepEqual((await bob.list("other-board")).entries, []);
  bob.setName("Renamed Bob");
  assert.equal((await bob.submit("points-v1", 190)).name, "Bob");
  await bob.submit("time-v1", 300, { order: "asc" });
  assert.equal((await bob.submit("time-v1", 200, { order: "asc" })).score, 200);
  await assert.rejects(bob.submit("time-v1", 400), { code: "board_order_conflict" });
  assert.equal((await raw({ op: "save.get", slot: "secret", playerToken: credential })).code, "bad_operation");
  assert.equal((await raw({ op: "board.submit", board: "points-v1", score: 999, name: "Fake", playerToken: "invalid" })).code, "identity_unavailable");
  await assert.rejects(raw({ op: "board.list", board: "points-v1", playerToken: credential }, "https://blocked.invalid"));
  const burstToken = crypto.randomBytes(32).toString("hex");
  const burst = await Promise.all(Array.from({ length: 16 }, () => raw({ op: "board.list", board: "points-v1", playerToken: burstToken })));
  assert.ok(burst.some((reply) => reply.code === "storage_rate_limited"), "opening fresh sockets must not reset the player's budget");
  multiplayer.close();
  clients.length = 0;
  await stop();
  await start();
  assert.deepEqual((await alice.list("points-v1")).entries.map((entry) => entry.score), [200, 150], "rankings survive relay restart");
  const deletion = await fetch(`${origin}/admin/games/scores-game`, { method: "DELETE", headers: { Authorization: "Bearer leaderboard-test-admin" } });
  assert.equal(deletion.status, 204);
  await assert.rejects(alice.list("points-v1"), { code: "project_deleted" });
  await stop();
  await start();
  await assert.rejects(alice.list("points-v1"), { code: "project_deleted" });

  // A stalled service must time out without a retry loop, so offline play can continue.
  const stalled = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(stalled, "listening");
  let connections = 0;
  stalled.on("connection", () => { connections++; });
  try {
    const offline = new ThreadSiteLeaderboards({ game: "offline-game", url: `ws://127.0.0.1:${stalled.address().port}/ws`, name: "Offline", timeoutMs: 100 });
    await assert.rejects(offline.submit("points", 10), { code: "submission_uncertain" });
    await assert.rejects(offline.list("points"), { code: "unavailable" });
    assert.equal(connections, 2, "each explicit request attempts once, without automatic replay");
  } finally { for (const socket of stalled.clients) socket.terminate(); await new Promise((resolve) => stalled.close(resolve)); }
  console.log("PASS: dedicated global boards, shared multiplayer identity, game isolation, no rooms, names, limits, restart durability, cleanup and offline timeouts.");
} finally {
  for (const client of clients) client.close();
  await stop();
  globalThis.WebSocket = originalSocket;
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else delete globalThis.localStorage;
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith("threadsite-leaderboards-"));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
