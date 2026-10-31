// Hidden-tab host behavior against a live relay: a hidden host must hand
// authority to waiting peers — on the visibilitychange event, when a peer
// joins an already-hidden host, via the worker-metronome retry when the event
// was missed, and without latching when the frame could not be sent (closed
// socket, full send buffer, or a refused final world) — while hidden tabs
// never ping-pong authority between each other and keep heartbeating through
// browser timer throttling.
//
// The Page Visibility API is mocked globally; guests standing in for active
// visible players disable autoYieldOnHidden so only the simulated hidden host
// reacts. A fake Worker class lets metronome ticks fire deterministically.
import assert from "node:assert/strict";

const URL_ = `ws://127.0.0.1:${process.env.GAMESERVER_TEST_PORT || "8090"}/ws`;
const GAME = "hidden-host-test";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Page Visibility mock (installed before the client loads) --------------
const visibilityListeners = new Set();
globalThis.document = {
  hidden: false,
  addEventListener(type, listener) { if (type === "visibilitychange") visibilityListeners.add(listener); },
  removeEventListener(_type, listener) { visibilityListeners.delete(listener); },
};
const show = () => {
  globalThis.document.hidden = false;
  for (const fn of [...visibilityListeners]) fn();
};
const hide = (dispatch) => {
  globalThis.document.hidden = true;
  if (dispatch) for (const fn of [...visibilityListeners]) fn();
};

// --- Fake worker metronome --------------------------------------------------
class FakeWorker {
  static instances = [];
  constructor(url) { this.url = url; this.onmessage = null; this.onerror = null; this.terminated = false; FakeWorker.instances.push(this); }
  postMessage() {}
  terminate() { this.terminated = true; }
}
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
if (typeof realCreateObjectURL !== "function") URL.createObjectURL = () => `blob:hidden-host-${Math.random()}`;
if (typeof realRevokeObjectURL !== "function") URL.revokeObjectURL = () => {};
globalThis.Worker = FakeWorker;
const tickMetronomes = () => {
  for (const worker of FakeWorker.instances) if (!worker.terminated && worker.onmessage) worker.onmessage({ data: 0 });
};

const { ThreadSiteNet } = await import("../bot/assets/threadsite-net.js");

const clients = [];
const connect = async (options) => {
  const net = await ThreadSiteNet.connect({ game: GAME, url: URL_, ...options });
  clients.push(net);
  return net;
};
// Closes a case's clients so later metronome ticks cannot leak into them.
const closeCase = (...nets) => { for (const net of nets) net.close(); };

// 1. A host that hides while an active peer is connected yields immediately.
{
  show();
  let lostEpoch = null;
  let acquired = null;
  const host = await connect({
    createRoom: true, name: "HideHost",
    onAuthorityLost: (epoch) => { lostEpoch = epoch; },
  });
  await sleep(30);
  host.publishWorld({ tick: 5, note: "case-1" });
  const guest = await connect({
    room: host.room, name: "ActiveGuest", autoYieldOnHidden: false,
    onAuthorityAcquired: (snapshot, epoch) => { acquired = { snapshot, epoch }; },
  });
  await sleep(80);
  assert.equal(guest.hostId, host.id);
  hide(true);
  await sleep(150);
  assert.equal(host.isHost, false, "a hidden host yields authority to the waiting peer");
  assert.equal(lostEpoch, 1);
  assert.equal(guest.isHost, true);
  assert.equal(acquired.epoch, 2);
  assert.equal(acquired.snapshot.state.tick, 5, "the successor restores the cached world before acquiring");
  tickMetronomes();
  await sleep(120);
  assert.equal(guest.isHost, true, "an active successor keeps authority across further hidden-host ticks");
  closeCase(host, guest);
}

// 2. A host hidden while alone yields the moment a peer joins.
{
  show();
  const host = await connect({ createRoom: true, name: "AloneHost" });
  await sleep(30);
  host.publishWorld({ tick: 3, note: "case-2" });
  hide(true);
  assert.equal(host.isHost, true, "a lone hidden host has nobody to yield to yet");
  let acquired = null;
  const guest = await connect({
    room: host.room, name: "LateGuest", autoYieldOnHidden: false,
    onAuthorityAcquired: (snapshot, epoch) => { acquired = { snapshot, epoch }; },
  });
  await sleep(150);
  assert.equal(host.isHost, false, "peer-join triggers the hidden host's yield");
  assert.equal(guest.isHost, true);
  assert.equal(acquired.snapshot.state.tick, 3, "the joiner takes over from the frozen snapshot");
  closeCase(host, guest);
}

// 3. A missed visibilitychange event is healed by the worker metronome tick.
{
  show();
  const host = await connect({ createRoom: true, name: "MissedHost" });
  await sleep(30);
  host.publishWorld({ tick: 7, note: "case-3" });
  let acquired = null;
  const guest = await connect({
    room: host.room, name: "MissedGuest", autoYieldOnHidden: false,
    onAuthorityAcquired: (snapshot, epoch) => { acquired = { snapshot, epoch }; },
  });
  await sleep(80);
  hide(false); // the tab is hidden but the event itself never fires
  await sleep(120);
  assert.equal(host.isHost, true, "before a metronome tick the missed event has no effect");
  tickMetronomes();
  await sleep(150);
  assert.equal(host.isHost, false, "the background tick retries the yield a throttled timer would have missed");
  assert.equal(guest.isHost, true);
  assert.equal(acquired.snapshot.state.tick, 7);
  closeCase(host, guest);
}

// 4. A yield that could not be sent does not latch; the retry goes out later.
//    Also: the metronome tick sends the heartbeat ping a throttled interval
//    would have dropped.
{
  show();
  const host = await connect({ createRoom: true, name: "LatchHost" });
  await sleep(30);
  host.publishWorld({ tick: 9, note: "case-4" });
  const guest = await connect({ room: host.room, name: "LatchGuest", autoYieldOnHidden: false });
  await sleep(80);
  hide(false);
  const socket = host.socket;
  host.socket = null;
  assert.equal(host.yieldHost(), false, "the yield is refused while the socket cannot send");
  assert.equal(host.yieldPending, false, "a refused yield must not latch");
  host.socket = socket;
  hide(true); // still hidden; the change event fires the retry
  await sleep(150);
  assert.equal(host.isHost, false, "the yield goes out once the frame is actually sendable");
  assert.equal(guest.isHost, true);

  const agedPingAt = host.lastPingTs = Date.now() - 60_000;
  host.lastPongAt = agedPingAt;
  tickMetronomes();
  assert.ok(host.lastPingTs > agedPingAt, "the background tick sends the overdue heartbeat ping");
  await sleep(120);
  assert.ok(host.lastPongAt >= host.lastPingTs, "the relay answered the metronome keepalive");
  closeCase(host, guest);
}

// 5. Two hidden tabs exchange authority at most once each, then it settles:
//    repeated ticks must not ping-pong authority between hidden peers.
{
  show();
  const host = await connect({ createRoom: true, name: "PingHost" });
  const guest = await connect({ room: host.room, name: "PingGuest" });
  await sleep(80);
  assert.equal(host.isHost, true);
  hide(false);
  tickMetronomes();
  await sleep(150);
  assert.equal(guest.isHost, true, "the hidden host hands off once");
  tickMetronomes();
  await sleep(150);
  assert.equal(host.isHost, true, "the hidden successor hands back once");
  const settledEpoch = host.authorityEpoch;
  for (let i = 0; i < 3; i++) { tickMetronomes(); await sleep(120); }
  assert.equal(host.authorityEpoch, settledEpoch, "further hidden ticks stop migrating authority");
  assert.equal(host.isHost, true);
  assert.equal(guest.isHost, false);
  closeCase(host, guest);
}

// 6. Without Worker support the interval-fallback metronome still compensates.
{
  delete globalThis.Worker;
  show();
  const host = await connect({ createRoom: true, name: "FallbackHost" });
  await sleep(30);
  host.publishWorld({ tick: 11, note: "case-6" });
  let acquired = null;
  const guest = await connect({
    room: host.room, name: "FallbackGuest", autoYieldOnHidden: false,
    onAuthorityAcquired: (snapshot, epoch) => { acquired = { snapshot, epoch }; },
  });
  await sleep(80);
  hide(false);
  let migrated = false;
  for (let i = 0; i < 13 && !migrated; i++) { await sleep(200); migrated = !host.isHost; }
  assert.equal(migrated, true, "the interval-fallback tick still retries the hidden yield");
  assert.equal(guest.isHost, true);
  assert.equal(acquired.snapshot.state.tick, 11);
  closeCase(host, guest);
  globalThis.Worker = FakeWorker;
}

// 7. A yield blocked by a full send buffer does not latch either: the frame
//    would be silently dropped, so the retry must continue until it goes out.
{
  show();
  const host = await connect({ createRoom: true, name: "BufferHost" });
  await sleep(30);
  host.publishWorld({ tick: 13, note: "case-7" });
  const guest = await connect({ room: host.room, name: "BufferGuest", autoYieldOnHidden: false });
  await sleep(80);
  hide(false);
  // Simulate a stalled send buffer: transient frames would be dropped silently.
  Object.defineProperty(host.socket, "bufferedAmount", { value: 500_000, configurable: true });
  hide(true);
  await sleep(120);
  assert.equal(host.yieldPending, false, "a yield a full buffer would drop must not latch");
  assert.equal(host.isHost, true);
  assert.equal(guest.isHost, false);
  delete host.socket.bufferedAmount;
  tickMetronomes();
  await sleep(150);
  assert.equal(guest.isHost, true, "once the buffer drains, the retry hands authority over");
  closeCase(host, guest);
}

// 8. A final world the client refuses (frame_too_large) neither latches as
//    the last published world nor stops the hidden-tab handoff.
{
  show();
  const host = await connect({ createRoom: true, name: "HugeHost" });
  await sleep(30);
  const huge = { tick: 15, blob: "x".repeat(300 * 1024) };
  assert.throws(() => host.publishWorld(huge), (error) => error.code === "frame_too_large");
  assert.notEqual(host.lastPublishedWorld, huge, "a refused publish must not become the final world");
  const guest = await connect({ room: host.room, name: "HugeGuest", autoYieldOnHidden: false });
  await sleep(80);
  hide(true); // must not throw out of the visibilitychange listener
  await sleep(150);
  assert.equal(guest.isHost, true, "the handoff still goes out without the refused final world");
  closeCase(host, guest);
}

// 9. close() disposes the metronome worker.
{
  show();
  const before = FakeWorker.instances.length;
  const net = await connect({ createRoom: true, name: "DisposeHost" });
  assert.equal(FakeWorker.instances.length, before + 1, "each client owns one worker metronome");
  net.close();
  assert.equal(FakeWorker.instances.at(-1).terminated, true, "close() terminates the worker metronome");
}

for (const net of clients) net.close();
if (typeof realCreateObjectURL === "function") URL.createObjectURL = realCreateObjectURL;
else delete URL.createObjectURL;
if (typeof realRevokeObjectURL === "function") URL.revokeObjectURL = realRevokeObjectURL;
else delete URL.revokeObjectURL;
delete globalThis.Worker;
delete globalThis.document;
console.log("ALL HIDDEN-HOST TESTS PASSED");
