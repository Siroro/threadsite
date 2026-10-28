import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PlayerStore } from "../dist/player-store.js";

// Each test owns its directory; cleanup can never touch production relay state.
async function fixture(t, limits = { players: 4, gameBytes: 100_000 }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-player-store-"));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith("threadsite-player-store-"));
  const store = new PlayerStore(path.join(root, "relay.sqlite"), limits);
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const request = (op, fields = {}, player = "alice", game = "game-one") => store.execute(game, player, player, { op, ...fields });
  return { store, request, root };
}

test("save quotas stay accurate across resizing, rejected writes, restart and game deletion", async (t) => {
  const { store, request, root } = await fixture(t, { players: 4, gameBytes: 12 });
  request("save.set", { slot: "a", value: "123456", revision: 0 });
  assert.throws(() => request("save.set", { slot: "b", value: "123", revision: 0 }), { code: "storage_full" });
  const resized = request("save.set", { slot: "a", value: "1", revision: 1 });
  request("save.set", { slot: "b", value: "123", revision: 0 });
  assert.throws(() => request("save.set", { slot: "a", value: "123456", revision: resized.revision }), { code: "storage_full" });
  store.close();
  assert.equal(request("save.get", { slot: "a" }).value, "1");
  assert.throws(() => request("save.set", { slot: "c", value: "123", revision: 0 }), { code: "storage_full" });
  request("save.delete", { slot: "b", revision: 1 });
  request("save.set", { slot: "a", value: "123456", revision: resized.revision });
  const inspect = new DatabaseSync(path.join(root, "relay.sqlite"), { readOnly: true });
  try {
    assert.equal(inspect.prepare("SELECT bytes FROM game_save_bytes WHERE game = ?").get("game-one").bytes, 8);
    for (const direction of ["ASC", "DESC"]) {
      const plan = inspect.prepare(`EXPLAIN QUERY PLAN SELECT player FROM scores WHERE game = ? AND board = ?
        ORDER BY score ${direction}, updated_at ASC, player ASC LIMIT 10`).all("game-one", "board");
      assert.equal(plan.some((row) => String(row.detail).includes("TEMP B-TREE")), false);
    }
    assert.ok(inspect.prepare("EXPLAIN QUERY PLAN SELECT bytes FROM game_save_bytes WHERE game = ?").all("game-one")
      .some((row) => String(row.detail).includes("INDEX")));
  } finally { inspect.close(); }
  store.deleteGame("game-one");
  request("save.set", { slot: "new", value: "123456", revision: 0 });
  assert.equal(request("save.get", { slot: "new" }).value, "123456");
});

test("save revisions reject stale writes and stay monotonic across deletion; player and game isolation", async (t) => {
  const { request } = await fixture(t);
  const initial = request("save.get", { slot: "progress" });
  const saved = request("save.set", { slot: "progress", value: { level: 3 }, revision: initial.revision });
  assert.deepEqual(request("save.get", { slot: "progress" }).value, { level: 3 });
  assert.throws(() => request("save.set", { slot: "progress", value: { level: 1 }, revision: initial.revision }), { code: "save_conflict" });
  assert.equal(request("save.get", { slot: "progress" }, "bob").value, null);
  assert.equal(request("save.get", { slot: "progress" }, "alice", "game-two").value, null);
  const deleted = request("save.delete", { slot: "progress", revision: saved.revision });
  assert.equal(request("save.get", { slot: "progress" }).value, null);
  assert.throws(() => request("save.set", { slot: "progress", value: "stale", revision: 0 }), { code: "save_conflict" });
  assert.throws(() => request("save.delete", { slot: "progress", revision: saved.revision }), { code: "save_conflict" });
  assert.deepEqual(request("save.set", { slot: "progress", value: "new run", revision: deleted.revision }).value, "new run");
});

test("quota failures roll back writes, deletions release bytes, and existing players still update at the player cap", async (t) => {
  const { request, store } = await fixture(t, { players: 1, gameBytes: 20 });
  const saved = request("save.set", { slot: "a", value: "1234567890", revision: 0 });
  assert.throws(() => request("save.set", { slot: "b", value: "1234567890", revision: 0 }), { code: "storage_full" });
  assert.equal(request("save.get", { slot: "b" }).revision, 0);
  assert.throws(() => request("board.submit", { board: "scores", score: 42 }, "bob"), { code: "player_limit" });
  assert.equal(request("board.list", { board: "scores" }).order, null, "failed board creation rolled back too");
  request("save.delete", { slot: "a", revision: saved.revision });
  request("save.set", { slot: "b", value: "1234567890", revision: 0 });
  assert.equal(request("board.submit", { board: "scores", score: 42 }).score, 42);
  store.deleteGame("game-one");
  request("save.set", { slot: "a", value: 7, revision: 0 }, "bob");
  assert.equal(request("save.get", { slot: "a" }, "bob").value, 7, "deletion released the player quota");
});

test("leaderboards sort both directions and retain personal bests without letting worse submissions change names or tie priority", async (t) => {
  const { request, store } = await fixture(t);
  const first = request("board.submit", { board: "points", score: 50 });
  request("board.submit", { board: "points", score: 75 }, "bob");
  assert.deepEqual(request("board.submit", { board: "points", score: 10 }), first);
  assert.deepEqual(request("board.submit", { board: "points", score: 50 }), first);
  assert.deepEqual(store.execute("game-one", "alice", "Changed name", { op: "board.submit", board: "points", score: 50 }), first);
  assert.deepEqual(request("board.list", { board: "points" }).entries.map((p) => p.playerId), ["bob", "alice"]);
  request("board.submit", { board: "points", score: 100 });
  assert.equal(request("board.list", { board: "points", limit: 1 }).entries[0].playerId, "alice");
  request("board.submit", { board: "times", score: 20, order: "asc" });
  request("board.submit", { board: "times", score: 15, order: "asc" }, "bob");
  request("board.submit", { board: "times", score: 40, order: "asc" }, "bob");
  assert.deepEqual(request("board.list", { board: "times" }).entries.map((p) => p.score), [15, 20]);
  assert.throws(() => request("board.submit", { board: "times", score: 1, order: "desc" }), { code: "board_order_conflict" });
  assert.equal(request("board.list", { board: "points" }, "alice", "game-two").entries.length, 0);
});

test("invalid inputs and capacity limits do not damage existing saves or boards", async (t) => {
  const { request } = await fixture(t, { players: 4, gameBytes: 2_000_000 });
  for (let index = 0; index < 16; index++) {
    request("save.set", { slot: `slot-${index}`, value: index, revision: 0 });
    request("board.submit", { board: `board-${index}`, score: index });
  }
  assert.throws(() => request("save.set", { slot: "extra", value: 1, revision: 0 }), { code: "slot_limit" });
  request("save.delete", { slot: "slot-0", revision: 1 });
  assert.throws(() => request("save.set", { slot: "extra", value: 1, revision: 0 }), { code: "slot_limit" });
  assert.throws(() => request("board.submit", { board: "extra", score: 1 }), { code: "board_limit" });
  assert.throws(() => request("save.set", { slot: "slot-1", value: "💾".repeat(17_000), revision: 1 }), { code: "save_too_large" });
  assert.throws(() => request("save.set", { slot: "slot-1", value: 2, revision: -1 }), { code: "bad_revision" });
  assert.throws(() => request("save.get", { slot: "../escape" }), { code: "bad_key" });
  assert.throws(() => request("board.submit", { board: "board-0", score: Infinity }), { code: "bad_score" });
  assert.throws(() => request("board.list", { board: "board-0", limit: 101 }), { code: "bad_limit" });
  assert.equal(request("save.get", { slot: "slot-1" }).value, 1);
  assert.equal(request("board.list", { board: "board-0" }).entries[0].score, 0);
});

test("reopening persists committed saves/scores; deleting one game preserves other tenants", async (t) => {
  const { store, request } = await fixture(t);
  request("save.set", { slot: "progress", value: { items: ["key"] }, revision: 0 });
  request("board.submit", { board: "points", score: 12 });
  request("save.set", { slot: "progress", value: "keep", revision: 0 }, "alice", "game-two");
  store.close();
  assert.deepEqual(request("save.get", { slot: "progress" }).value, { items: ["key"] });
  assert.equal(request("board.list", { board: "points" }).entries[0].score, 12);
  store.deleteGame("game-one");
  assert.deepEqual(store.games(), ["game-two"]);
  assert.equal(request("save.get", { slot: "progress" }).revision, 0);
  assert.equal(request("save.get", { slot: "progress" }, "alice", "game-two").value, "keep");
});

test("resetScores wipes boards while saves survive and other games keep their scores", async (t) => {
  const { store, request } = await fixture(t);
  request("save.set", { slot: "progress", value: { level: 3 }, revision: 0 });
  request("board.submit", { board: "points", score: 50 });
  request("board.submit", { board: "points", score: 75 }, "bob");
  request("board.submit", { board: "points", score: 5 }, "alice", "game-two");
  store.resetScores("game-one");
  assert.deepEqual(request("board.list", { board: "points" }), { order: null, entries: [] });
  assert.deepEqual(request("save.get", { slot: "progress" }).value, { level: 3 });
  assert.deepEqual(request("board.list", { board: "points" }, "alice", "game-two").entries.map((entry) => entry.score), [5]);
  assert.equal(request("board.submit", { board: "points", score: 10, order: "asc" }).score, 10, "a wiped board may be recreated with a fresh order");
  assert.deepEqual(store.games().sort(), ["game-one", "game-two"], "the tenant stays known through its saves");
  store.deleteGame("game-one");
  assert.deepEqual(request("board.list", { board: "points" }, "alice", "game-two").entries.map((entry) => entry.score), [5]);
});
