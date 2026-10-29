import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { test } from "node:test";
import { createAdminApi } from "../dist/admin-api.js";
import { GameConflict } from "../dist/game-lifecycle.js";

test("admin boundary authenticates, routes and rejects ambiguous destructive requests", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-admin-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, "a".repeat(64));
  const calls = [];
  let fail;
  const record = async (...args) => { if (fail) throw fail; calls.push(args); };
  const api = createAdminApi({ tokenFile, games: () => ["z-game", "a-game"],
    delete: (id) => record("delete", id), reset: (id, scope) => record("reset", id, scope),
    rename: (from, to) => record("rename", from, to), resetAll: async (scope) => { await record("all", scope); return 2; } });
  const server = http.createServer(async (req, res) => {
    if (!await api(req, res, new URL(req.url, "http://internal"))) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${"a".repeat(64)}` };
  const request = (route, method = "POST", auth = headers) => fetch(`${origin}${route}`, { method, headers: auth });
  assert.equal((await request("/admin/games/my-game/reset", "POST", {})).status, 403);
  assert.equal((await request("/admin/games/my-game/reset", "POST", { Authorization: "Bearer wrong" })).status, 403);
  for (const route of ["/admin/reset?scope=unknown", "/admin/reset?scope=world&scope=all", "/admin/games/my-game/reset?scope=", "/admin/games/my-game/rename?to=bad!", "/admin/games/my-game/rename?to=new-game&to=other-game"]) {
    assert.equal((await request(route)).status, 400, route);
  }
  assert.equal((await request("/admin/games/my-game", "POST")).status, 404);
  assert.deepEqual(calls, []);
  assert.deepEqual(await (await request("/admin/games", "GET")).json(), ["a-game", "z-game"]);
  assert.equal((await request("/admin/games/my-game", "DELETE")).status, 204);
  assert.equal((await request("/admin/games/my-game/reset?scope=scores")).status, 204);
  assert.equal((await request("/admin/games/my-game/rename?to=new-game")).status, 204);
  assert.deepEqual(await (await request("/admin/reset")).json(), { ok: true, games: 2 });
  assert.deepEqual(calls, [["delete", "my-game"], ["reset", "my-game", { world: false, scores: true }], ["rename", "my-game", "new-game"], ["all", { world: true, scores: true }]]);
  fail = new GameConflict("old name");
  assert.equal((await request("/admin/games/my-game", "DELETE")).status, 409);
  fail = new Error("storage unavailable");
  assert.equal((await request("/admin/games/my-game/reset")).status, 503);
  // Authentication is read per request, including token rotation and missing files.
  await fs.writeFile(tokenFile, "b".repeat(64));
  assert.equal((await request("/admin/games", "GET")).status, 403);
  await fs.unlink(tokenFile);
  assert.equal((await request("/admin/games", "GET")).status, 503);
});
