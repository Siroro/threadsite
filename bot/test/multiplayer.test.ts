import assert from "node:assert/strict";
import { test } from "node:test";
import type { MultiplayerContext } from "../src/types.js";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
process.env.MULTIPLAYER_ENABLED ||= "true";
const { multiplayerContext } = await import("../src/multiplayer.js");
const { initialProjectInstruction, mutationInstruction, projectAgents } = await import("../src/templates.js");

const roomsContext: MultiplayerContext = { gameId: "neon-arena", wsUrl: "wss://relay.example/ws", protocolVersion: 4, mode: "rooms" };

test("multiplayerContext follows the chosen architecture", () => {
  assert.equal(multiplayerContext("site", "slug", "arena"), undefined, "sites never get a relay");
  assert.equal(multiplayerContext("game-2d", "slug", "singleplayer"), undefined, "singleplayer games get no relay wiring");
  const arena = multiplayerContext("game-3d", "slug");
  assert.deepEqual(arena && { mode: arena.mode, gameId: arena.gameId }, { mode: "arena", gameId: "slug" }, "omitted mode defaults to arena");
  const rooms = multiplayerContext("game-2d", "slug", "rooms");
  assert.equal(rooms?.mode, "rooms");
});

test("AGENTS.md carries the session-mode guidance for the chosen architecture", async () => {
  const rooms = await projectAgents("game-2d", roomsContext);
  assert.match(rooms, /Session mode — rooms/);
  assert.doesNotMatch(rooms, /\{\{modeGuidance\}\}/, "the guidance token must never survive into a generated AGENTS.md");

  const arena = await projectAgents("game-2d", { ...roomsContext, mode: "arena" });
  assert.match(arena, /Session mode — arena/);
  assert.doesNotMatch(arena, /invite-code rooms with/);
});

test("a singleplayer game gets an explicit no-netcode section instead", async () => {
  const agents = await projectAgents("game-2d", undefined, true);
  assert.match(agents, /## Singleplayer only/);
  assert.match(agents, /never add WebSocket\/WebRTC code/);
  assert.doesNotMatch(agents, /## Multiplayer first/, "the relay section is not written for singleplayer games");
  // The default (site) path stays untouched.
  assert.doesNotMatch(await projectAgents("game-2d", undefined, false), /## Singleplayer only/);
});

test("initial and mutation instructions describe the chosen architecture", () => {
  const initial = initialProjectInstruction("game-2d", "build koi pong", undefined, "singleplayer");
  assert.match(initial, /singleplayer only — no networking at all/);
  assert.match(initial, /2D and singleplayer sections/);
  assert.doesNotMatch(initial, /multiplayer-first/);

  assert.match(initialProjectInstruction("game-2d", "x", undefined, "rooms"), /room-based multiplayer .*invite-code rooms/);
  assert.match(initialProjectInstruction("game-2d", "x", undefined, "arena"), /multiplayer-first through the harness relay/);

  const mutate = mutationInstruction("game-3d", "add a boss", undefined, "rooms");
  assert.match(mutate, /Preserve working room-based multiplayer \(invite-code rooms/);
  assert.match(mutationInstruction("game-3d", "x", undefined, "singleplayer"), /singleplayer-only: keep it fully playable offline/);
  assert.match(mutationInstruction("game-3d", "x", undefined, "arena"), /Preserve working multiplayer \(arena sync/);
  // Sites are unchanged regardless of mode.
  assert.doesNotMatch(mutationInstruction("site", "x", undefined, "rooms"), /multiplayer/);
});

test("multiplayerSwapInstruction mandates investigate-then-question about the found difficulties", async () => {
  const { multiplayerSwapInstruction, multiplayerModeLabel } = await import("../src/templates.js");
  for (const [from, to] of [["arena", "rooms"], ["rooms", "arena"], ["arena", "singleplayer"], ["singleplayer", "rooms"]] as const) {
    const text = multiplayerSwapInstruction(from, to);
    assert.match(text, new RegExp(multiplayerModeLabel(from)), `${from}->${to}: names the source architecture`);
    assert.match(text, new RegExp(multiplayerModeLabel(to)), `${from}->${to}: names the target architecture`);
    assert.match(text, /MUST call the question tool/, `${from}->${to}: asking the user is mandatory`);
    assert.match(text, /Inspect the current/, `${from}->${to}: investigates before anything else`);
    // The questions come from what the investigation finds, not a canned list.
    assert.match(text, /where this transition is genuinely difficult or ambiguous for THIS game/);
    assert.match(text, /Ask only about real difficulties/);
  }
  // Rewrite rules stay architecture-specific.
  assert.match(multiplayerSwapInstruction("rooms", "singleplayer"), /Remove every import of \.\.\/net\/\*/);
  assert.match(multiplayerSwapInstruction("singleplayer", "arena"), /solo fallback/);
});

test("an optional user note rides the swap instruction without replacing the question step", async () => {
  const { multiplayerSwapInstruction } = await import("../src/templates.js");
  const plain = multiplayerSwapInstruction("arena", "rooms");
  assert.doesNotMatch(plain, /user added this note/);

  const noted = multiplayerSwapInstruction("arena", "rooms", "keep the existing lobby music playing while rooms are created");
  assert.match(noted, /user added this note/);
  assert.match(noted, /keep the existing lobby music/);
  assert.match(noted, /honor it over defaults where they conflict/);
  // The note narrows the questions, it does not remove the mandatory step.
  assert.match(noted, /MUST call the question tool/);
  assert.match(noted, /difficulties it does not resolve/);
  // Whitespace-only notes are dropped.
  assert.doesNotMatch(multiplayerSwapInstruction("arena", "rooms", "   "), /user added this note/);
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
    await fs.writeFile(path.join(dir, "site", "js", "threadsite-net.js"), "legacy");
    await fs.writeFile(path.join(dir, "NETWORKING.md"), "guide");
    assert.equal(await removeMultiplayerFiles(dir), true, "reports removal");
    await assert.rejects(fs.access(path.join(dir, "site", "net")));
    await assert.rejects(fs.access(path.join(dir, "site", "js", "threadsite-net.js")));
    await assert.rejects(fs.access(path.join(dir, "NETWORKING.md")));
    assert.equal(await removeMultiplayerFiles(dir), false, "a clean workspace is a no-op");
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
