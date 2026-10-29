import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { testRootSetup } from "./fixtures/root.js";

const root = testRootSetup("relay-client");
process.env.GAMESERVER_ADMIN_TOKEN_FILE = path.join(root, "control", "token");
const { deleteRelayGame, renameRelayGame, resetRelayGame, resetAllRelayGames, listRelayGames, relayCleanupToken } = await import("../src/relay-cleanup.js");

test("relay client validates before sending and validates remote responses", async (t) => {
  const calls: Array<{ url: URL; method: string; authorization: string }> = [];
  let reply = () => new Response(null, { status: 204 });
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    calls.push({ url: new URL(url), method: options.method!, authorization: (options.headers as Record<string, string>).Authorization });
    return reply();
  });
  await assert.rejects(deleteRelayGame("../escape"));
  await assert.rejects(renameRelayGame("valid-game", "INVALID"));
  await assert.rejects(resetRelayGame("valid-game", { world: false, scores: false } as any));
  await assert.rejects(resetAllRelayGames({ world: "false", scores: true } as any));
  assert.equal(calls.length, 0);

  await deleteRelayGame("valid-game");
  await renameRelayGame("valid-game", "new-game");
  await resetRelayGame("new-game", { world: false, scores: true });
  assert.deepEqual(calls.map(({ url, method }) => [url.pathname + url.search, method]), [
    ["/admin/games/valid-game", "DELETE"],
    ["/admin/games/valid-game/rename?to=new-game", "POST"],
    ["/admin/games/new-game/reset?scope=scores", "POST"],
  ]);
  assert.ok(calls.every((call) => call.authorization === calls[0].authorization));
  assert.equal(calls[0].authorization, `Bearer ${await relayCleanupToken()}`);

  for (const games of [-1, 0.5, "3", null, Number.MAX_SAFE_INTEGER + 1]) {
    reply = () => Response.json({ games });
    await assert.rejects(resetAllRelayGames(), /payload/);
  }
  reply = () => Response.json({ games: 0 });
  assert.equal(await resetAllRelayGames(), 0);
  reply = () => Response.json(["valid-game", "../escape"]);
  await assert.rejects(listRelayGames(), /payload/);
  reply = () => Response.json(["new-game"]);
  assert.deepEqual(await listRelayGames(), ["new-game"]);
  reply = () => new Response(null, { status: 409 });
  await assert.rejects(resetRelayGame("valid-game"), /409/);
});
