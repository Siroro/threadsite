// End-to-end relay restart recovery using the generated browser client.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { ThreadSiteNet } from "../bot/assets/threadsite-net.js";

const PORT = 8091;
const URL = `ws://127.0.0.1:${PORT}/ws`;
const HEALTH = `http://127.0.0.1:${PORT}/health`;
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
    env: { ...process.env, GAMESERVER_HOST: "127.0.0.1", GAMESERVER_PORT: String(PORT) },
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

function worldLifecycle(state) {
  return {
    schemaVersion: 1,
    publishHz: 10,
    capture: () => ({ runId: "restart-run", tick: ++state.tick, state: { bossHp: state.bossHp } }),
    restore: (world) => { state.tick = world.tick; state.bossHp = world.state.bossHp; state.restores += 1; },
    present: (world) => { state.tick = world.tick; state.bossHp = world.state.bossHp; },
    onAuthorityStart: ({ recovered }) => { state.authoritative = true; state.recovered ||= recovered; },
    onAuthorityStop: () => { state.authoritative = false; },
  };
}

let relay = await startRelay();
let host;
let guest;
try {
  const hostState = { tick: 0, bossHp: 7, restores: 0, authoritative: false, recovered: false };
  const guestState = { tick: 0, bossHp: 0, restores: 0, authoritative: false, recovered: false };
  host = await ThreadSiteNet.connect({
    game: "restart-v4-test", url: URL, createRoom: true, name: "Host", world: worldLifecycle(hostState),
  });
  guest = await ThreadSiteNet.connect({
    game: "restart-v4-test", url: URL, room: host.room, name: "Guest", world: worldLifecycle(guestState),
  });
  await waitFor(() => guestState.bossHp === 7, "initial complete world");
  const oldGeneration = host.authorityGeneration;

  await stopRelay(relay);
  relay = await startRelay();

  await waitFor(() => host.status === "online" && guest.status === "online", "both clients to reconnect");
  await waitFor(() => host.authorityGeneration !== oldGeneration && host.authorityGeneration === guest.authorityGeneration, "new shared room generation");
  await waitFor(() => Number(host.isHost) + Number(guest.isHost) === 1, "single recovered authority");
  await waitFor(() => hostState.recovered || guestState.recovered, "cached snapshot restore");
  await waitFor(() => hostState.bossHp === 7 && guestState.bossHp === 7, "recovered world replication");

  assert.equal(host.room, guest.room);
  assert.notEqual(host.authorityGeneration, oldGeneration);
  console.log("ALL RELAY RESTART RECOVERY TESTS PASSED");
} finally {
  host?.close(); guest?.close();
  await stopRelay(relay);
}
