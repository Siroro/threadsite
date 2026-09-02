// Generated v4 browser-client conformance tests against a live relay.
import assert from "node:assert/strict";
import { NET_STATUS, ThreadSiteNet, ThreadSiteNetError } from "../bot/assets/threadsite-net.js";

const URL = "ws://127.0.0.1:8090/ws";
const GAME = "client-v4-test";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let hostAcquired = null;
let hostLost = null;
const host = await ThreadSiteNet.connect({
  game: GAME, url: URL, createRoom: true, name: "Host",
  onAuthorityAcquired: (snapshot, epoch) => { hostAcquired = { snapshot, epoch }; },
  onAuthorityLost: (epoch) => { hostLost = epoch; },
});
await Promise.resolve(); // initial callbacks run after await assigns `host`
assert.equal(host.status, NET_STATUS.ONLINE);
assert.equal(host.isHost, true);
assert.equal(hostAcquired.epoch, 1);
assert.equal(typeof host.authorityGeneration, "string");

const worlds = [];
const events = [];
let guestAcquired = null;
const guest = await ThreadSiteNet.connect({
  game: GAME, url: URL, room: host.room, name: "Guest",
  onWorld: (world) => worlds.push(world),
  onEvent: (event) => events.push(event),
  onAuthorityAcquired: (snapshot, epoch) => { guestAcquired = { snapshot, epoch }; },
});
assert.equal(guest.hostId, host.id);

host.publishWorld({ tick: 1, enemies: [{ id: "e1", hp: 3 }] });
await sleep(80);
assert.equal(worlds.at(-1).state.tick, 1);
assert.deepEqual([worlds.at(-1).authorityEpoch, worlds.at(-1).stateSeq], [1, 1]);
assert.throws(() => guest.publishWorld({ tick: 2 }), (error) => error instanceof ThreadSiteNetError && error.code === "not_host");

host.publishTransform({ x: 0, y: 5, vx: 100, vy: 0, facing: "right" });
await sleep(60);
host.publishTransform({ x: 6, y: 5, vx: 100, vy: 0, facing: "right" });
await sleep(80);
const sampled = guest.sampleTransform(host.id);
assert.ok(sampled && Number.isFinite(sampled.x) && sampled.y === 5);
assert.ok(guest.transformSampleInfo(host.id).samples >= 2, "library owns an actual transform jitter buffer");
assert.equal(guest.sampleRemotePlayers().find((entry) => entry.peer.id === host.id).transform.y, 5);
assert.equal(guest.transforms.latest(host.id).x, 6, "latest() returns the newest sample regardless of render delay");
host.transforms.teleport({ x: 100, y: 25, vx: 0, vy: 0, alive: true, runId: "movement-1" });
await sleep(80);
assert.equal(guest.transforms.sample(host.id).x, 100);
assert.equal(guest.transforms.latest(host.id).x, 100, "latest() tracks the newest transform after teleport");
const latestEntry = guest.transforms.latestAll().find((entry) => entry.peer.id === host.id);
assert.ok(latestEntry && latestEntry.transform.x === 100 && Number.isFinite(latestEntry.ageMs),
  "latestAll() pairs live peers with their newest transform and age");
assert.equal(guest.transforms.nearest(99, 25).peer.id, host.id);

const ephemerals = [];
guest.events.onEphemeral("aim", (event) => { ephemerals.push(event); });
host.events.sendEphemeral("aim", { angle: 1 }, guest.id);
host.events.sendEphemeral("aim", { angle: 1.25 }, guest.id);
host.events.sendEphemeral("aim", { angle: 1.5 }, guest.id);
const eventId = host.events.sendReliable("damage", { amount: 2 }, guest.id);
await sleep(80);
assert.equal(events.at(-1).id, eventId);
assert.equal(events.at(-1).type, "damage");
assert.ok(eventId.split(".").length >= 3, "event ids include a reload-unique instance nonce");
assert.equal(ephemerals.at(-1).data.angle, 1.5);
assert.equal(ephemerals.length, 2, "ephemeral updates coalesce latest-wins at 20 Hz");
host.presence.set({ character: "ranger", ready: true });
await sleep(80);
assert.equal(guest.presence.get(host.id).character, "ranger");

host.publishWorld({ tick: 2, enemies: [{ id: "e1", hp: 1 }] });
await sleep(50);
assert.equal(host.yieldHost(), true);
await sleep(120);
assert.equal(hostLost, 1);
assert.equal(guest.isHost, true);
assert.equal(guestAcquired.epoch, 2);
assert.equal(guestAcquired.snapshot.state.tick, 2, "authority acquired only after cached world is available");
guest.publishWorld({ tick: 3, enemies: [] });

host.ping();
await sleep(80);
assert.equal(typeof host.rtt, "number");
assert.equal(typeof host.serverTimeOffset, "number");
assert.ok(Math.abs(host.serverNow() - Date.now()) < 2000);
const deadline = host.clock.after(1000);
assert.ok(host.clock.remaining(deadline) <= 1000 && host.clock.elapsed(deadline - 1000) >= 0);

const late = await ThreadSiteNet.connect({ game: GAME, url: URL, room: host.room, name: "Late" });
assert.equal(late.peerState(host.id).x, 100, "late join receives newest player state");
assert.ok(late.sampleTransform(host.id), "late join seeds transform sampling immediately");
assert.equal(late.transforms.latest(host.id).x, 100, "latest() works from welcome-seeded transforms");
assert.equal(late.presence.get(host.id).character, "ranger", "late join receives separate presence");

assert.throws(
  () => guest.publishWorld({ blob: "x".repeat(300 * 1024) }),
  (error) => error instanceof ThreadSiteNetError && error.code === "frame_too_large",
);

// Large-but-legal worlds (256 KB client cap, 264 KB relay default) must flow.
// After the yield above the guest publishes; the ex-host peer receives.
const hostWorlds = [];
host.onWorld = (world) => hostWorlds.push(world);
guest.publishWorld({ tick: 4, blob: "x".repeat(200 * 1024) });
await sleep(150);
assert.equal(hostWorlds.at(-1)?.state.tick, 4, "200 KB world publishes under the raised cap");
assert.equal(hostWorlds.at(-1)?.state.blob.length, 200 * 1024, "200 KB world arrives intact on the guest");

const single = await ThreadSiteNet.connect({ game: "client-single-v4", url: URL, mode: "single", name: "Solo" });
assert.equal(single.room, null);
assert.equal(single.inviteUrl(), null);

assert.throws(
  () => new ThreadSiteNet({
    game: "invalid-world-v4", url: URL, createRoom: true, onWorld: () => undefined,
    world: {
      schemaVersion: 1, capture: () => ({ runId: 1, tick: 1, state: {} }),
      restore: () => undefined, present: () => undefined,
      onAuthorityStart: () => undefined, onAuthorityStop: () => undefined,
    },
  }),
  (error) => error instanceof ThreadSiteNetError && error.code === "bad_world_sync",
  "safe and raw authority lifecycles cannot be combined",
);

let safeTick = 1;
let safeAuthority = false;
const safeHost = await ThreadSiteNet.createAuthoritativeSession({
  game: "safe-world-v4", url: URL, mode: "rooms", createRoom: true, name: "SafeHost",
  world: {
    schemaVersion: 1,
    capture: () => ({ runId: "run-1", tick: safeTick++, state: { bossHp: 10 } }),
    restore: () => assert.fail("a new room has no recovery snapshot"),
    present: () => assert.fail("the host never presents guest snapshots"),
    onAuthorityStart: ({ recovered }) => { assert.equal(recovered, false); safeAuthority = true; },
    onAuthorityStop: () => { safeAuthority = false; },
    publishHz: 5,
  },
});
let facadeAcquire = null;
safeHost.authority.onAcquire((_snapshot, epoch) => { facadeAcquire = epoch; });
await Promise.resolve();
assert.equal(safeAuthority, true);
assert.equal(facadeAcquire, 1);
let presented = null;
let restored = null;
const safeGuest = await ThreadSiteNet.createAuthoritativeSession({
  game: "safe-world-v4", url: URL, mode: "rooms", room: safeHost.room, name: "SafeGuest",
  world: {
    schemaVersion: 1,
    capture: () => ({ runId: "run-1", tick: safeTick++, state: { bossHp: 10 } }),
    restore: (world) => { restored = world; },
    present: (world) => { presented = world; },
    onAuthorityStart: () => undefined,
    onAuthorityStop: () => undefined,
    publishHz: 5,
  },
});
let facadeWorld = null;
let runChange = null;
safeGuest.world.onSnapshot((snapshot) => { facadeWorld = snapshot; });
safeGuest.run.onChanged((change) => { runChange = change; });
await sleep(250);
assert.equal(presented.state.bossHp, 10, "late join is presented a validated cached complete world");
assert.equal(facadeWorld.state.state.bossHp, 10);
assert.equal(runChange.current, "run-1");
assert.equal(safeGuest.run.current, "run-1");
let receivedIntent = null;
safeHost.intents.on("try-pickup", (intent) => { receivedIntent = intent; });
const intentId = safeGuest.intents.send("try-pickup", { entityId: "gem-1" });
await sleep(80);
assert.equal(receivedIntent.id, intentId);
assert.equal(receivedIntent.runId, "run-1");
assert.equal(receivedIntent.payload.entityId, "gem-1");
receivedIntent = null;
safeGuest.events.sendReliable("@intent:try-pickup", { runId: "old-run", payload: { entityId: "gem-old" } }, safeHost.id);
await sleep(80);
assert.equal(receivedIntent, null, "host intent router rejects a stale run before game code");

const removed = [];
const enemiesSync = safeGuest.entities.syncCollection("enemies", {
  getId: (snapshot) => snapshot.id,
  create: (snapshot) => ({ ...snapshot }),
  update: (enemy, snapshot) => Object.assign(enemy, snapshot),
  remove: (_enemy, id) => removed.push(id),
});
enemiesSync.apply([{ id: "e1", hp: 3 }, { id: "e2", hp: 5 }]);
enemiesSync.apply([{ id: "e1", hp: 1 }]);
assert.equal(enemiesSync.get("e1").hp, 1);
assert.deepEqual(removed, ["e2"]);
assert.throws(
  () => enemiesSync.apply([{ id: "dup", hp: 1 }, { id: "dup", hp: 2 }]),
  (error) => error instanceof ThreadSiteNetError && error.code === "duplicate_entity_id",
);
safeHost.close();
await sleep(200);
assert.equal(safeGuest.isHost, true);
assert.equal(restored.state.bossHp, 10, "new authority restores the latest accepted complete world before starting");

for (const net of [host, guest, late, single, safeGuest]) net.close();
console.log("ALL CLIENT V4 CONFORMANCE TESTS PASSED");
