// Host-stall watchdog: a connected-but-silent host must lose authority to a
// waiting peer once the stall window passes, while a healthy publishing host
// must never be demoted. The "ghost" is a raw WebSocket client so it can keep
// its socket perfectly alive (browsers answer pings for frozen tabs) while
// publishing nothing — exactly the frozen-old-tab failure mode.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { ThreadSiteNet } from "../bot/assets/threadsite-net.js";

const PORT = 8093;
const URL = `ws://127.0.0.1:${PORT}/ws`;
const HEALTH = `http://127.0.0.1:${PORT}/health`;
const STALL_MS = 1200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function startRelay() {
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: import.meta.dirname,
    env: {
      ...process.env,
      GAMESERVER_HOST: "127.0.0.1",
      GAMESERVER_PORT: String(PORT),
      GAMESERVER_HOST_STALL_MS: String(STALL_MS),
      GAMESERVER_STATE_DIR: process.env.GAMESERVER_STATE_DIR || "./data/stall-test-state",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  // Windows reports signal-killed children with exitCode null forever, so
  // liveness is tracked with one shared exit promise instead of exitCode.
  const exited = new Promise((resolve) => child.once("exit", () => resolve(true)));
  await waitFor(async () => {
    try { return (await fetch(HEALTH)).ok; } catch { return false; }
  }, "relay health");
  return { child, exited, stopped: false };
}

async function stopRelay(relay) {
  if (relay.stopped) return;
  relay.stopped = true;
  relay.child.kill("SIGTERM");
  const graceful = await Promise.race([relay.exited, sleep(3000).then(() => false)]);
  if (graceful !== true) relay.child.kill("SIGKILL");
  await relay.exited;
}

/** Raw ghost client: joins, then publishes complete worlds on demand. */
function connectGhost() {
  const ghost = {
    ws: new WebSocket(URL),
    you: null,
    generation: null,
    epoch: null,
    room: null,
    frames: [],
    errors: [],
    timer: null,
    tick: 0,
    send(frame) { ghost.ws.send(JSON.stringify(frame)); },
    publish() {
      ghost.tick += 1;
      ghost.send({
        t: "world", generation: ghost.generation, epoch: ghost.epoch,
        s: { schemaVersion: 1, runId: "ghost-run", tick: ghost.tick, state: { bossHp: 3 } },
      });
    },
  };
  ghost.ws.on("message", (data) => {
    const frame = JSON.parse(String(data));
    ghost.frames.push(frame);
    if (frame.t === "error") ghost.errors.push(frame);
    if (frame.t === "welcome") {
      ghost.you = frame.you;
      ghost.generation = frame.generation;
      ghost.epoch = frame.epoch;
      ghost.room = frame.room;
    }
  });
  return ghost;
}

let relay = await startRelay();
let ghost;
let guest;
try {
  // --- Boot: ghost joins first (becomes host) and publishes at ~3.3 Hz. ---
  ghost = connectGhost();
  await new Promise((resolve, reject) => {
    ghost.ws.once("open", () => {
      ghost.send({ t: "join", v: 4, game: "host-stall-test", mode: "rooms", create: true, name: "Ghost" });
      resolve();
    });
    ghost.ws.once("error", reject);
  });
  await waitFor(() => ghost.you !== null, "ghost welcome");

  const guestState = {
    tick: 0, bossHp: 0, authoritative: false, recovered: false, restoredTick: null,
  };
  guest = await ThreadSiteNet.connect({
    game: "host-stall-test", url: URL, room: ghost.room, name: "Guest",
    world: {
      schemaVersion: 1,
      publishHz: 10,
      capture: () => ({ runId: "guest-run", tick: ++guestState.tick, state: { bossHp: guestState.bossHp } }),
      restore: (world) => { guestState.tick = world.tick; guestState.restoredTick = world.tick; guestState.bossHp = world.state.bossHp; },
      present: (world) => { guestState.tick = world.tick; guestState.bossHp = world.state.bossHp; },
      onAuthorityStart: ({ recovered }) => { guestState.authoritative = true; guestState.recovered ||= recovered; },
      onAuthorityStop: () => { guestState.authoritative = false; },
    },
  });

  // --- Phase 1: healthy host. Publish well past the stall window and assert
  // the watchdog leaves it alone and the guest follows the worlds. ---
  ghost.timer = setInterval(() => ghost.publish(), 300);
  await sleep(STALL_MS * 2 + 400);
  clearInterval(ghost.timer);
  ghost.timer = null;
  await waitFor(() => guestState.tick >= 3, "guest receives healthy host worlds");
  assert.equal(guestState.authoritative, false, "healthy host must not be demoted");
  assert.equal(ghost.frames.some((f) => f.t === "authority"), false, "no authority broadcast while host publishes");
  const frozenTick = ghost.tick;

  // --- Phase 2: ghost goes silent but stays connected (frozen tab). ---
  await waitFor(() => guest.isHost && guestState.authoritative, "watchdog elects the waiting guest", 12_000);
  await waitFor(() => guestState.recovered && guestState.restoredTick === frozenTick, "guest restored the frozen world");
  const authority = ghost.frames.filter((f) => f.t === "authority").at(-1);
  assert.ok(authority, "demoted ghost received the authority broadcast");
  assert.equal(authority.host, guest.id);
  assert.ok(authority.epoch > ghost.epoch, "authority epoch advanced past the ghost's");

  // The new host must actually resume publication — the ghost, still connected
  // as a guest, sees fresh worlds from the successor.
  await waitFor(() => ghost.frames.some((f) => f.t === "world" && f.from === guest.id && f.epoch === authority.epoch), "successor publishes again");

  // A late publish from the demoted ghost must be refused, not merged. The
  // not_host guard fires before the generation/epoch check for a demoted peer.
  ghost.publish();
  await waitFor(() => ghost.errors.some((e) => e.code === "not_host" || e.code === "stale_authority"), "stale ghost publish rejected");

  console.log("ALL HOST-STALL WATCHDOG TESTS PASSED");
} finally {
  if (ghost?.timer) clearInterval(ghost.timer);
  ghost?.ws.close();
  guest?.close();
  await stopRelay(relay);
}
