// Smoke test for the vendored browser client (bot/assets/threadsite-net.js)
// against a live relay. Start the relay first: node server.mjs
import { ThreadSiteNet, ThreadSiteNetError, NET_STATUS } from "../bot/assets/threadsite-net.js";

const assert = (await import("node:assert")).default;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const events = [];
const states = [];
let hostChange = { hostId: null, isHost: null };
const statuses = [];

const host = await ThreadSiteNet.connect({
  game: "client-test-game-01",
  url: "ws://127.0.0.1:8090/ws",
  createRoom: true,
  name: "HostAna",
  onEvent: (ev) => events.push(["host", ev]),
  onState: (snap) => states.push(["host", snap]),
  onHostChange: (hostId, isHost) => { hostChange = { hostId, isHost }; },
  onStatus: (s) => statuses.push(s),
});
assert.equal(host.status, NET_STATUS.ONLINE);
assert.equal(host.isHost, true);
assert.match(host.room, /^[A-Z2-9]{5}$/);
console.log("host connected, room", host.room);

let guestPeers = null;
const guest = await ThreadSiteNet.connect({
  game: "client-test-game-01",
  url: "ws://127.0.0.1:8090/ws",
  room: host.room,
  name: "GuestBo",
  onPeers: (peers) => { guestPeers = peers; },
  onEvent: (ev) => events.push(["guest", ev]),
  onState: (snap) => states.push(["guest", snap]),
});
assert.equal(guest.isHost, false);
assert.equal(guest.hostId, host.id);
await sleep(200);
assert.equal(guestPeers.length, 1);
assert.equal(guestPeers[0].name, "HostAna");
assert.equal(host.peers.length, 1);
console.log("guest connected; rosters agree");

host.publishState({ tick: 7, world: "calm" });
await sleep(200);
assert.ok(states.some(([, snap]) => snap.state.tick === 7));
console.log("publishState -> onState OK");

guest.send("input", { seq: 1, move: "north" });
await sleep(200);
assert.ok(events.some(([, ev]) => ev.type === "input" && ev.data.seq === 1));
console.log("send -> onEvent OK");

host.ping();
await sleep(300);
assert.equal(typeof host.rtt, "number");
console.log("rtt:", host.rtt, "ms");

// Peer-owned state: your own entity publishes directly, no host round trip.
let gotP = null;
guest.onPlayerState = (ps) => { gotP = ps; };
host.publishPlayerState({ x: 5, y: 6, anim: "run" });
await sleep(200);
assert.equal(gotP.from, host.id);
assert.equal(gotP.cid, host.cid);
assert.deepEqual(gotP.state, { x: 5, y: 6, anim: "run" });
assert.ok(typeof gotP.ts === "number");
assert.deepEqual(guest.peerState(host.id), { x: 5, y: 6, anim: "run" });
console.log("publishPlayerState -> onPlayerState OK");

// A late joiner immediately sees every peer's latest player state.
const late = await ThreadSiteNet.connect({
  game: "client-test-game-01",
  url: "ws://127.0.0.1:8090/ws",
  room: host.room,
  name: "LateLad",
});
assert.deepEqual(late.peerState(host.id), { x: 5, y: 6, anim: "run" });
assert.equal(late.playerStates.length, 1); // guest has not published anything
late.close();
console.log("late joiner gets peer states OK");

// Solo-fallback shape: connecting to a dead relay rejects with a usable error
// and the instance attached for later manual retry handling.
await assert.rejects(
  ThreadSiteNet.connect({ game: "client-test-game-01", url: "ws://127.0.0.1:9/ws", room: "ABCDX", autoReconnect: false, connectTimeoutMs: 1200 }),
  (error) => {
    assert.ok(error instanceof ThreadSiteNetError);
    assert.ok(["connect_timeout", "connect_failed", "bad_url"].includes(error.code));
    assert.ok(error.net);
    return true;
  },
);
console.log("unreachable relay -> rejected with", "error.net attached");

// Host leaving promotes the guest.
host.close();
await sleep(300);
assert.equal(guest.hostId, guest.id);
assert.equal(guest.isHost, true);
console.log("client-side host migration OK");

// v3: publishPlayerState throttling — per-frame calls coalesce to ~pstateHz,
// and only the newest state is actually sent.
let pstateCount = 0;
guest.onPlayerState = () => { pstateCount += 1; };
const sender = await ThreadSiteNet.connect({
  game: "client-test-game-01",
  url: "ws://127.0.0.1:8090/ws",
  room: host.room,
  name: "Throttler",
  pstateHz: 10,
});
for (let i = 0; i < 50; i += 1) sender.publishPlayerState({ i });
sender.flushPlayerState();
await sleep(350);
// 50 per-frame calls: ~1 immediate flush + ~3 timer ticks at 10 Hz, never 50.
assert.ok(pstateCount >= 1 && pstateCount <= 10, `throttled to ${pstateCount} sends, not 50`);
assert.deepEqual(guest.peerState(sender.cid), { i: 49 }, "newest state wins");
console.log("publishPlayerState throttling OK:", pstateCount, "sends for 50 calls");

// v3: sequenced events + gap recovery. The receiving side sees consecutive
// seqs, detects a simulated gap, requests a resend, and never double-delivers.
const seqCollector = [];
const gapVictim = await ThreadSiteNet.connect({
  game: "client-test-game-01",
  url: "ws://127.0.0.1:8090/ws",
  room: host.room,
  name: "GapVictim",
  onEvent: (ev) => { if (ev.type === "tick") seqCollector.push(ev.seq); },
});
sender.send("tick", null); // seq 1
sender.send("tick", null); // seq 2
sender.send("tick", null); // seq 3
sender.send("tick", null); // seq 4
await sleep(300);
assert.deepEqual(seqCollector, [1, 2, 3, 4], "no spurious gaps in clean delivery");
assert.equal(gapVictim.dropped, 0);
assert.equal(gapVictim.duplicates, 0);
console.log("clean sequenced delivery OK");

// True gap: swallow one frame on the wire and confirm automatic recovery.
// (Patch the raw socket's send so the relay — and therefore the receiver —
// genuinely never sees seq 6's first delivery. The library's own resend goes
// through the same patched send, so only swallow the frame once; the resend
// (marked r:1) must be allowed through.)
const realSend = sender._ws.send.bind(sender._ws);
let swallowed = false;
sender._ws.send = (data) => {
  const frame = JSON.parse(data);
  const isTarget = frame.t === "event" && frame.e === "gap-tick" && frame.seq === 6 && frame.r !== 1;
  if (isTarget && !swallowed) {
    swallowed = true;
    return; // dropped on the wire
  }
  realSend(data);
};
const gapCollector = [];
gapVictim.onEvent = (ev) => { if (ev.type === "gap-tick") gapCollector.push(ev.seq); };
sender.send("gap-tick", null); // seq 5
sender.send("gap-tick", null); // seq 6 — dropped on the wire
sender.send("gap-tick", null); // seq 7
await sleep(150);
assert.ok(gapCollector.includes(5) && gapCollector.includes(7), "later events delivered around the gap");
assert.ok(gapVictim.dropped >= 1, "drop counted");
await sleep(700); // resend-req travels; sender answers from its buffer
assert.ok(gapCollector.includes(6), `gap-tick seq 6 recovered: [${gapCollector.join(",")}]`);
assert.equal(gapCollector.filter((s) => s === 6).length, 1, "recovered event delivered exactly once");
assert.equal(gapVictim.duplicates, 0, "no duplicate deliveries");
sender._ws.send = realSend;
gapVictim.onEvent = null;
console.log("automatic gap recovery OK: recovered seq 6, no duplicates");

// v3: frame size guard fails loudly instead of getting the socket killed.
assert.throws(
  () => sender.publishState({ blob: "x".repeat(80 * 1024) }),
  (error) => error.code === "frame_too_large",
);
assert.equal(sender.status, "online", "connection survives an oversized attempt");
console.log("frame size guard OK");

// v3: offline outbox — events sent while the socket is down are queued and
// flushed in order once reconnected.
const outboxPeer = await ThreadSiteNet.connect({
  game: "client-test-game-01",
  url: "ws://127.0.0.1:8090/ws",
  room: host.room,
  name: "Outbox",
});
const outboxEvents = [];
gapVictim.onEvent = (ev) => { if (ev.type === "offline-msg") outboxEvents.push(ev.seq); };
outboxPeer._ws.close(); // simulated drop
await sleep(300);
assert.equal(outboxPeer.status, "reconnecting");
outboxPeer.send("offline-msg", { n: 1 });
outboxPeer.send("offline-msg", { n: 2 });
assert.ok(outboxPeer.queued >= 2, "frames queued while offline");
await sleep(4000); // reconnect backoff + flush
assert.equal(outboxPeer.status, "online");
assert.ok(outboxEvents.length >= 2, "queued events delivered after reconnect");
console.log("offline outbox OK:", outboxEvents.length, "events replayed");

// v3: server clock — pongs carry relay time, so serverNow() tracks it.
outboxPeer.ping();
await sleep(300);
assert.equal(typeof outboxPeer.rtt, "number");
assert.equal(typeof outboxPeer.serverTimeOffset, "number");
const skew = Math.abs(outboxPeer.serverNow() - Date.now());
assert.ok(skew < 2000, `serverNow() within 2s of local clock (skew ${skew}ms)`);
console.log("server clock sync OK: rtt", outboxPeer.rtt, "ms");

// v3: staleness bookkeeping — peerLastSeen/isStale reflect inbound traffic.
assert.ok(gapVictim.peerLastSeen(outboxPeer.id) !== null);
assert.equal(gapVictim.isStale(outboxPeer.id, 5000), false);
assert.equal(gapVictim.isStale(outboxPeer.id, -1), true, "isStale true past the age cutoff");
console.log("staleness tracking OK");

outboxPeer.close();
gapVictim.close();
sender.close();

// An unexpected socket drop (bypassing close()) reconnects into the SAME room
// code instead of hosting a new one — simulate by closing the raw socket
// directly, so the client never sets its manually-closed flag.
const rejoinStatuses = [];
guest.onStatus = (s) => rejoinStatuses.push(s);
const rejoinEvents = [];
guest.onPeers = (peers) => rejoinEvents.push(peers);
guest._ws.close(); // simulated network drop
await sleep(2500);
assert.equal(guest.status, "online");
assert.equal(guest.room, host.room); // same room, not a fresh code
assert.ok(rejoinStatuses.includes("reconnecting"));
console.log("drop -> auto-reconnect into same room OK");

// Joining an unknown code is terminal: rejects, ends CLOSED, does not retry.
let closedStatus = null;
await assert.rejects(
  ThreadSiteNet.connect({ game: "client-test-game-01", url: "ws://127.0.0.1:8090/ws", room: "ZZ9QZ" }),
  (error) => error.code === "room_not_found",
);
const stray = new ThreadSiteNet({ game: "client-test-game-01", url: "ws://127.0.0.1:8090/ws", room: "ZZ8QZ" });
stray.onStatus = (s, detail) => { closedStatus = [s, detail]; };
await stray.opened.catch(() => undefined);
await sleep(600);
assert.equal(stray.status, "closed");
assert.deepEqual(closedStatus, ["closed", "room_not_found"]);
console.log("room_not_found is terminal (no retry loop) OK");

// Single-server mode: two clients with mode "single" land in the same room,
// see each other, and no room code or createRoom is involved.
const arena1 = await ThreadSiteNet.connect({
  game: "client-arena-game-01",
  url: "ws://127.0.0.1:8090/ws",
  mode: "single",
  name: "ArenaOne",
});
assert.equal(arena1.mode, "single");
assert.equal(arena1.room, "ARENA");
assert.equal(arena1.isHost, true);

let arenaPeers = [];
const arena2 = await ThreadSiteNet.connect({
  game: "client-arena-game-01",
  url: "ws://127.0.0.1:8090/ws",
  mode: "single",
  name: "ArenaTwo",
  onPeers: (peers) => { arenaPeers = peers; },
});
assert.equal(arena2.room, "ARENA");
assert.equal(arena2.isHost, false);
assert.equal(arenaPeers.length, 1);
assert.equal(arenaPeers[0].id, arena1.id);
console.log("client single-server mode OK: shared room", arena1.room);

// inviteUrl()/roomFromUrl() round-trip via a simulated page location. Use a
// plain stub (not a URL instance) so the client's ws->wss upgrade logic does
// not kick in against the local plain-WS test relay.
const pageUrl = "https://sites.example.com/capy-courier-ab12cd/";
globalThis.location = { hash: "", href: pageUrl, origin: "https://sites.example.com", pathname: "/capy-courier-ab12cd/", search: "", protocol: "http:" };
assert.equal(ThreadSiteNet.roomFromUrl(), null);
globalThis.location.hash = `#room=${host.room}`;
assert.equal(ThreadSiteNet.roomFromUrl(), host.room);
const invitee = await ThreadSiteNet.connect({
  game: "client-test-game-01",
  url: "ws://127.0.0.1:8090/ws",
  room: ThreadSiteNet.roomFromUrl(),
  name: "Invitee",
});
assert.equal(invitee.room, host.room);
const hostInvite = host.inviteUrl();
assert.ok(hostInvite.endsWith(`#room=${host.room}`), `invite url carries room: ${hostInvite}`);
delete globalThis.location;
invitee.close();
arena1.close();
arena2.close();
console.log("invite URL round-trip OK:", hostInvite);

guest.close();
console.log("\nALL CLIENT SMOKE TESTS PASSED");
process.exit(0);
