import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { WebSocket, WebSocketServer } from "ws";
import { ThreadSiteNet } from "../bot/assets/threadsite-net.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-player-persistence-"));
const state = path.join(root, "state");
const tokenFile = path.join(root, "admin-token");
const token = "admin-test-token";
await fs.writeFile(tokenFile, token);
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const url = `ws://127.0.0.1:${port}/ws`;
const clients = [];
const sockets = [];
let child, exited;
let output = "";
const savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const browserStorage = new Map();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key) => browserStorage.get(key) ?? null,
  setItem: (key, value) => browserStorage.set(key, value),
} });
async function waitFor(check) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Persistence test timed out: ${output}`);
}
async function start() {
  child = spawn(process.execPath, ["dist/server.js"], { cwd: import.meta.dirname,
    env: { ...process.env, GAMESERVER_HOST: "127.0.0.1", GAMESERVER_PORT: String(port), GAMESERVER_STATE_DIR: state,
      GAMESERVER_ADMIN_TOKEN_FILE: tokenFile }, stdio: ["ignore", "pipe", "pipe"] });
  exited = once(child, "exit");
  child.stdout.on("data", (bytes) => { output += bytes; });
  child.stderr.on("data", (bytes) => { output += bytes; });
  await waitFor(async () => { try { return (await fetch(`${origin}/health`)).ok; } catch { return false; } });
}
async function stop() { if (child) { child.kill("SIGKILL"); await exited; child = undefined; } }
async function connect(options = {}) {
  const client = await ThreadSiteNet.connect({ game: "save-test-game", url, mode: "rooms", createRoom: true, ...options });
  clients.push(client); return client;
}
async function raw(game, playerToken, cid = "same-public-cid") {
  const ws = new WebSocket(url); sockets.push(ws);
  const frames = [];
  ws.on("message", (bytes) => frames.push(JSON.parse(String(bytes))));
  await once(ws, "open");
  ws.send(JSON.stringify({ t: "join", v: 4, game, mode: "rooms", create: true, playerToken, cid }));
  await waitFor(() => frames.some((frame) => frame.t === "welcome" || frame.t === "error"));
  let sequence = 0;
  return { ws, frames, welcome: frames[0], request: async (op, fields = {}) => {
    const id = `test-${++sequence}`;
    ws.send(JSON.stringify({ t: "storage", id, op, ...fields }));
    await waitFor(() => frames.some((frame) => frame.id === id));
    return frames.find((frame) => frame.id === id);
  } };
}
const inventory = async () => (await fetch(`${origin}/admin/games`, { headers: { Authorization: `Bearer ${token}` } })).json();
const remove = (game) => fetch(`${origin}/admin/games/${game}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });

try {
  await start();
  // A storage outage is recoverable and must not disable normal relay traffic:
  // a second connection holding the database's only write slot makes every
  // write request fail cleanly while ordinary routing continues.
  const lock = new DatabaseSync(path.join(state, "relay.sqlite"));
  lock.exec("BEGIN EXCLUSIVE");
  const first = await connect({ name: "Alice" });
  await assert.rejects(first.saves.set("progress", { level: 0 }, 0), { code: "storage_unavailable" });
  first.ping();
  await waitFor(() => first.rtt !== null);
  lock.exec("COMMIT");
  lock.close();
  const empty = await first.saves.get("progress");
  const saved = await first.saves.set("progress", { level: 4, inventory: ["key"] }, empty.revision);
  const best = await first.leaderboards.submit("points", 125);
  const identity = first.playerId;
  assert.equal(first.saves.identityPersistent, true);

  // A separate room and a fresh client still belong to this browser's player.
  first.close();
  const returned = await connect({ name: "Alice" });
  assert.equal(returned.playerId, identity);
  assert.deepEqual((await returned.saves.get("progress")).value, saved.value);
  const tab = await connect();
  const stale = await tab.saves.get("progress");
  await returned.saves.set("progress", { level: 5 }, saved.revision);
  await assert.rejects(tab.saves.set("progress", { level: 2 }, stale.revision), { code: "save_conflict" });
  assert.deepEqual((await tab.saves.get("progress")).value, { level: 5 });

  // Same public continuity metadata is no credential, nor is a visible player ID.
  const bob = await raw("save-test-game", "b".repeat(64));
  assert.equal((await bob.request("save.get", { slot: "progress" })).result.value, null);
  assert.equal((await bob.request("board.submit", { board: "points", score: 200 })).result.score, 200);
  const impersonator = await raw("save-test-game", "c".repeat(64));
  assert.notEqual(impersonator.welcome.persistence.playerId, bob.welcome.persistence.playerId);
  const invalid = await raw("save-test-game", identity);
  // Even if the public hash has credential syntax, hashing it again identifies
  // a different player; it cannot recover the original secret.
  assert.equal((await invalid.request("save.get", { slot: "progress", playerId: identity, player: identity })).result.value, null);
  const legacy = await raw("save-test-game");
  assert.equal((await legacy.request("save.get", { slot: "progress" })).code, "identity_unavailable");
  assert.equal(bob.frames.some((frame) => JSON.stringify(frame).includes("inventory")), false, "personal save data is never broadcast");
  assert.equal(bob.frames.some((frame) => JSON.stringify(frame).includes("playerToken")), false, "credentials are never echoed");
  const elsewhere = await connect({ game: "other-save-game" });
  assert.equal((await elsewhere.saves.get("progress")).value, null);
  await elsewhere.saves.set("progress", "keep me", 0);

  // Explicit protocol errors are correlated; storage throttling leaves sockets usable.
  assert.equal((await bob.request("save.get", { slot: "../escape" })).code, "bad_key");
  const throttled = await raw("rate-test-game", "d".repeat(64));
  const responses = await Promise.all(Array.from({ length: 12 }, () => throttled.request("save.get", { slot: "progress" })));
  assert.ok(responses.some((frame) => frame.code === "storage_rate_limited"));
  assert.ok(responses.some((frame) => frame.ok === true));
  assert.equal(throttled.ws.readyState, WebSocket.OPEN);

  // Acknowledged writes survive abrupt process death, without an interval flush.
  for (const client of clients) client.close();
  for (const ws of sockets) ws.terminate();
  await stop();
  await start();
  const afterCrash = await connect({ name: "Alice" });
  assert.equal(afterCrash.playerId, identity);
  assert.deepEqual((await afterCrash.saves.get("progress")).value, { level: 5 });
  assert.deepEqual((await afterCrash.leaderboards.list("points")).entries.map((entry) => entry.score), [200, best.score]);
  const lower = await afterCrash.leaderboards.submit("points", 100);
  assert.equal(lower.score, best.score);
  const improved = await afterCrash.leaderboards.submit("points", 300);
  assert.equal(improved.playerId, identity);

  // Closing with an outstanding write is explicit uncertainty; it never queues a replay.
  const current = await afterCrash.saves.get("progress");
  const uncertain = afterCrash.saves.set("progress", { level: 6 }, current.revision);
  const rejection = assert.rejects(uncertain, { code: "storage_uncertain" });
  afterCrash.close();
  await rejection;
  const reconcile = await connect();
  const reconciled = await reconcile.saves.get("progress");
  assert.ok([current.revision, current.revision + 1].includes(reconciled.revision));
  assert.ok([5, 6].includes(reconciled.value.level));

  // Storage-only tenants remain discoverable after all room memory is lost.
  assert.deepEqual(await inventory(), ["other-save-game", "save-test-game"]);
  assert.equal((await remove("save-test-game")).status, 204);
  const database = new DatabaseSync(path.join(state, "relay.sqlite"));
  try {
    for (const table of ["players", "saves", "boards", "scores"]) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE game = ?`).get("save-test-game").n, 0);
    }
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM saves WHERE game = ?").get("other-save-game").n, 1);
  } finally { database.close(); }
  await waitFor(() => reconcile.status === "closed" || reconcile.status === "reconnecting");
  assert.equal((await remove("save-test-game")).status, 204);
  await stop();
  await start();
  assert.deepEqual(await inventory(), ["other-save-game"]);
  assert.equal((await raw("save-test-game", "b".repeat(64))).welcome.code, "project_deleted");
  const kept = await connect({ game: "other-save-game" });
  assert.equal((await kept.saves.get("progress")).value, "keep me");

  // A pre-extension v4 relay still accepts the new client for normal play.
  const oldRelay = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(oldRelay, "listening");
  oldRelay.on("connection", (ws) => {
    ws.on("message", (bytes) => {
      const frame = JSON.parse(String(bytes));
      if (frame.t === "join") ws.send(JSON.stringify({ t: "welcome", v: 4, you: "old-peer", mode: "single",
        host: "old-peer", generation: "old-generation", epoch: 1, peers: [], world: null }));
    });
  });
  try {
    const compatible = await connect({ url: `ws://127.0.0.1:${oldRelay.address().port}/ws`, mode: "single" });
    assert.equal(compatible.status, "online");
    assert.equal(compatible.saves.available, false);
    await assert.rejects(compatible.saves.get("progress"), { code: "storage_unsupported" });
    compatible.close();
  } finally { for (const ws of oldRelay.clients) ws.terminate(); await new Promise((resolve) => oldRelay.close(resolve)); }

  // localStorage denial degrades to page-lifetime identity and never prevents play.
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
  const temporary = await connect({ game: "temporary-game" });
  assert.equal(temporary.saves.identityPersistent, false);
  assert.equal(temporary.saves.available, true);
  await temporary.saves.set("progress", "temporary", 0);
  temporary.close();
  await assert.rejects(temporary.saves.get("progress"), { code: "storage_offline" });

  const savedCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, get() { throw new Error("no secure randomness"); } });
  try {
    const noIdentity = await connect({ game: "no-secure-identity" });
    assert.equal(noIdentity.status, "online");
    assert.equal(noIdentity.saves.available, false);
    await assert.rejects(noIdentity.saves.get("progress"), { code: "storage_unsupported" });
  } finally {
    if (savedCrypto) Object.defineProperty(globalThis, "crypto", savedCrypto);
    else delete globalThis.crypto;
  }
  console.log("PASS: private browser identity, CAS conflicts, disk failure recovery, request limits, crash durability, leaderboards, cleanup and solo-safe failures.");
} finally {
  for (const client of clients) client.close();
  for (const ws of sockets) ws.terminate();
  await stop();
  if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
  else delete globalThis.localStorage;
  const resolved = path.resolve(root);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("threadsite-player-persistence-"));
  await fs.rm(resolved, { recursive: true, force: true });
}
