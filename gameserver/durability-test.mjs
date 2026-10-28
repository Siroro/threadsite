// ARENA (mode "single") world durability across relay restarts, using the
// generated browser client: interval flush to disk, first-joiner restore
// through the welcome snapshot, and the publish gate that protects a restored
// world from an eager fresh host. Roomed games stay ephemeral.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ThreadSiteNet } from "../bot/assets/threadsite-net.js";

const PORT = 8092;
const URL = `ws://127.0.0.1:${PORT}/ws`;
const HEALTH = `http://127.0.0.1:${PORT}/health`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STATE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-durable-"));
const arenaFile = path.join(STATE_DIR, "durable-arena-test.json");

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
      GAMESERVER_HOST: "127.0.0.1", GAMESERVER_PORT: String(PORT),
      GAMESERVER_STATE_DIR: STATE_DIR, GAMESERVER_PERSIST_INTERVAL_MS: "1",
      // The 1 ms flush interval plus six publishers keeps a deep write queue;
      // shutdown must be allowed to drain it instead of abandoning the newest
      // snapshot on a loaded machine.
      GAMESERVER_SHUTDOWN_FLUSH_TIMEOUT_MS: "10000",
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
  // Grace: the configured shutdown drain (10s) plus the exit fallback (1.5s).
  // Anything slower gets terminated so the suite can never hang on a stubborn
  // relay.
  const graceful = await Promise.race([relay.exited, sleep(15_000).then(() => false)]);
  if (graceful !== true) relay.child.kill("SIGKILL");
  await relay.exited;
}

async function readArenaFile() {
  return JSON.parse(await fs.readFile(arenaFile, "utf8"));
}

function arenaLifecycle(state) {
  return {
    schemaVersion: 1,
    publishHz: 10,
    capture: () => ({ runId: "arena-run", tick: ++state.tick, state: { bossHp: state.bossHp, elapsed: state.elapsed } }),
    restore: (world) => { state.tick = world.tick; state.bossHp = world.state.bossHp; state.restores += 1; },
    present: (world) => { state.bossHp = world.state.bossHp; },
    onAuthorityStart: ({ recovered }) => { state.authoritative = true; state.recovered ||= recovered; },
    onAuthorityStop: () => { state.authoritative = false; },
  };
}

let relay = await startRelay();
const clients = [];
const track = (net) => { clients.push(net); return net; };
try {
  // Phase 1: a host plays in the arena; the relay persists the latest world.
  const hostState = { tick: 0, bossHp: 9, elapsed: 305.4, restores: 0, authoritative: false, recovered: false };
  const first = track(await ThreadSiteNet.createAuthoritativeSession({
    game: "durable-arena-test", url: URL, mode: "single", name: "First",
    world: arenaLifecycle(hostState),
  }));
  assert.equal(first.room, null, "arenas expose no room code");
  assert.equal(first.authority.ready, false, "bootstrap completes one tick after connect resolves");
  assert.throws(
    () => first.world.publish({ fresh: true }),
    (error) => error.code === "not_ready",
    "an eager host cannot publish before the restored world is processed",
  );
  await Promise.resolve(); // initial authority callbacks run after await assigns the client
  assert.equal(first.authority.ready, true, "publishing is unblocked once the welcome world is processed");
  assert.equal(first.world.restored, false, "a brand-new arena starts fresh");
  await waitFor(() => hostState.tick > 1, "arena world publication");
  await waitFor(async () => {
    try { return (await readArenaFile()).state.state.bossHp === 9; } catch { return false; }
  }, "interval flush of the arena world to disk");
  const saved = await readArenaFile();
  assert.equal(saved.version, 1);
  assert.equal(saved.gameId, "durable-arena-test");
  assert.equal(saved.state.schemaVersion, 1, "the persisted state is the complete game envelope, opaque to the relay");

  // Roomed worlds must never touch disk.
  const roomState = { tick: 0, bossHp: 4, restores: 0, authoritative: false, recovered: false };
  const roomed = track(await ThreadSiteNet.createAuthoritativeSession({
    game: "durable-arena-test", url: URL, mode: "rooms", createRoom: true, name: "RoomHost",
    world: arenaLifecycle(roomState),
  }));
  await waitFor(() => roomState.tick > 1, "roomed world publication");
  first.close(); roomed.close();
  await waitFor(async () => {
    const names = await fs.readdir(STATE_DIR);
    return names.length === 1 && names[0] === "durable-arena-test.json";
  }, "rooms stay ephemeral (only the arena file exists)");

  // Phase 2: full relay restart wipes RAM rooms; disk must survive.
  await stopRelay(relay);
  relay = await startRelay();
  const health = await (await fetch(HEALTH)).json();
  assert.equal(health.durableWorlds, 1, "startup scan loads the persisted arena world");

  // Phase 3: hours later, one player returns to the empty arena.
  const returnState = { tick: 0, bossHp: 0, elapsed: 0, restores: 0, authoritative: false, recovered: false };
  const returned = track(await ThreadSiteNet.createAuthoritativeSession({
    game: "durable-arena-test", url: URL, mode: "single", name: "Returner",
    world: arenaLifecycle(returnState),
  }));
  await Promise.resolve();
  assert.equal(returned.authority.ready, true);
  assert.equal(returned.world.restored, true, "the returning host began from an existing snapshot");
  await waitFor(() => returnState.restores === 1, "persisted world restored before host simulation");
  assert.equal(returnState.recovered, true, "authority started from a recovered snapshot, not a fresh world");
  assert.equal(returnState.bossHp, 9, "the resumed arena carries the saved boss state");
  await waitFor(() => returnState.tick > 1, "restored host republishes the arena");

  // Phase 4: updated state is flushed again and survives another restart.
  returnState.bossHp = 2;
  await waitFor(async () => {
    try { return (await readArenaFile()).state.state.bossHp === 2; } catch { return false; }
  }, "updated arena world flushed again");
  await stopRelay(relay);
  assert.equal((await readArenaFile()).state.state.bossHp, 2, "latest dirty world persisted at exit");

  relay = await startRelay();
  const lateState = { tick: 0, bossHp: 0, elapsed: 0, restores: 0, authoritative: false, recovered: false };
  const late = track(await ThreadSiteNet.createAuthoritativeSession({
    game: "durable-arena-test", url: URL, mode: "single", name: "Late",
    world: arenaLifecycle(lateState),
  }));
  await waitFor(() => lateState.bossHp === 2, "post-restart arena resumes from the latest persisted world");
  late.close();

  // Phase 5: bursty updates while writes are still in flight must never lose
  // the final state. The 1 ms flush interval makes every flush overlap an
  // in-flight write; closing the host hands the last world to the last-leave
  // flush, and the graceful shutdown drains the queued chain.
  const BURSTS = 6;
  const burstIds = [];
  for (let i = 0; i < BURSTS; i += 1) {
    const gameId = `durable-burst-test-${i}`;
    burstIds.push(gameId);
    const burstState = { tick: 0, bossHp: 100 + i, restores: 0, authoritative: false, recovered: false };
    const net = track(await ThreadSiteNet.createAuthoritativeSession({
      game: gameId, url: URL, mode: "single", name: `Burst${i}`,
      world: { ...arenaLifecycle(burstState), publishHz: 30 },
    }));
    await waitFor(() => burstState.tick >= 10, `burst ${i} publications`);
    burstState.bossHp = 777;
    await waitFor(() => burstState.tick >= 13, `burst ${i} final publications`);
    // The relay acknowledges each world it accepts. Closing before the final
    // snapshot is acknowledged (and then stopping the relay) would race frames
    // still in transit, which proves nothing about durability.
    await waitFor(() => net.world.snapshot?.state?.state?.bossHp === 777,
      `burst ${i} final world acknowledgement`);
    net.close(); // last-leave flush races whatever is still in flight
  }
  await stopRelay(relay); // shutdown awaits every queued write
  for (const [i, gameId] of burstIds.entries()) {
    const saved = JSON.parse(await fs.readFile(path.join(STATE_DIR, `${gameId}.json`), "utf8"));
    assert.equal(saved.state.state.bossHp, 777, `burst game ${i} kept its final world`);
  }
  console.log("ALL ARENA DURABILITY TESTS PASSED");
} finally {
  for (const net of clients) net.close();
  await stopRelay(relay);
  await fs.rm(STATE_DIR, { recursive: true, force: true });
}
