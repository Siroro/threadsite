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
assert.deepEqual(gotP, { from: host.id, state: { x: 5, y: 6, anim: "run" } });
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
