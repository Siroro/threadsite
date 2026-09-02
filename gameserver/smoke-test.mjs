// End-to-end smoke test for the relay: two tenants, room isolation,
// host migration, event/state relay, late-join snapshot, bad-frame handling.
// Run with the server up: npm run test:relay
import assert from "node:assert";

const BASE = "http://127.0.0.1:8090";

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:8090/ws");
    const frames = [];
    const waiters = [];
    ws.onmessage = (event) => {
      const frame = JSON.parse(event.data);
      const index = waiters.findIndex((waiter) => waiter.predicate(frame));
      if (index >= 0) {
        const waiter = waiters.splice(index, 1)[0];
        waiter.resolve(frame);
      } else {
        frames.push(frame);
      }
    };
    ws.onerror = () => reject(new Error("socket error"));
    ws.onopen = () => resolve({
      ws,
      frames,
      next: (predicate, label, timeoutMs = 3000) => new Promise((resolve, reject) => {
        const buffered = frames.findIndex(predicate);
        if (buffered >= 0) return resolve(frames.splice(buffered, 1)[0]);
        const waiter = {
          predicate,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`timeout waiting for ${label}`));
        }, timeoutMs);
        waiters.push(waiter);
      }),
      send: (frame) => ws.send(JSON.stringify(frame)),
      close: () => ws.close(),
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 0. health endpoints
const health = await (await fetch(`${BASE}/health`)).json();
assert.equal(health.ok, true);
assert.equal(health.protocol, 3);
console.log("health OK:", JSON.stringify(health));

// 1. host creates a room in game A
const host = await connect();
host.send({ t: "join", v: 3, game: "capy-courier-ab12cd", create: true, name: "Ana", cid: "shared-tab-cid" });
const welcome = await host.next((f) => f.t === "welcome", "host welcome");
assert.equal(welcome.you.startsWith("p-"), true);
assert.equal(welcome.host, welcome.you);
assert.equal(welcome.peers.length, 0);
assert.equal(welcome.s, null);
const room = welcome.room;
assert.match(room, /^[A-Z2-9]{5}$/);
console.log("host joined room", room);

// 2. guest joins by code
const guest = await connect();
guest.send({ t: "join", v: 3, game: "capy-courier-ab12cd", room, name: "Bo", cid: "shared-tab-cid" });
const guestWelcome = await guest.next((f) => f.t === "welcome", "guest welcome");
assert.equal(guestWelcome.room, room);
assert.equal(guestWelcome.host, welcome.you);
assert.equal(guestWelcome.peers.length, 1);
const hostSeesJoin = await host.next((f) => f.t === "peer-join", "peer-join at host");
assert.equal(hostSeesJoin.peer.name, "Bo");
console.log("guest joined; host sees roster");

// 3. tenant isolation: same code in game B is a *different* room (auto-created with create:true)
const other = await connect();
other.send({ t: "join", v: 3, game: "hover-yard-998877", room, create: true, name: "Zed" });
const otherWelcome = await other.next((f) => f.t === "welcome", "other-game welcome");
assert.equal(otherWelcome.room, room);
assert.equal(otherWelcome.peers.length, 0); // empty: different tenant
console.log("tenant isolation OK");

// 4. host publishes state; relay stores it and relays to guest
host.send({ t: "state", s: { tick: 42, players: 2 } });
const guestState = await guest.next((f) => f.t === "state", "state at guest");
assert.equal(guestState.from, welcome.you);
assert.equal(guestState.s.tick, 42);
console.log("state relay OK");

// 4b. self-published player transform: direct relay to the room, no host involvement
host.send({ t: "pstate", s: { x: 1, y: 2 } });
const guestP = await guest.next((f) => f.t === "pstate", "pstate at guest");
assert.equal(guestP.from, welcome.you);
assert.deepEqual(guestP.s, { x: 1, y: 2 });
console.log("pstate relay OK");

// 4c. room snapshots are host-only: a guest state publish is rejected and
// must not replace the cached snapshot (pstate is per-player traffic and
// stays allowed for everyone).
guest.send({ t: "state", s: { tick: 777, poisoned: true } });
const guestStateRejection = await guest.next((f) => f.t === "error" && f.code === "not_host", "guest state rejected");
assert.ok(guestStateRejection, "guest publishState rejected");
const lateProbe = await connect();
lateProbe.send({ t: "join", v: 3, game: "capy-courier-ab12cd", room });
const lateProbeWelcome = await lateProbe.next((f) => f.t === "welcome", "late probe welcome");
assert.equal(lateProbeWelcome.s.s.tick, 42, "cached snapshot untouched by the guest publish");
lateProbe.close();
console.log("guest publishState rejected, snapshot intact OK");

// 5. guest event broadcast + targeted event
guest.send({ t: "event", e: "input", d: { seq: 1, move: "left" } });
const hostEvent = await host.next((f) => f.t === "event", "event at host");
assert.equal(hostEvent.e, "input");
assert.equal(hostEvent.d.seq, 1);
host.send({ t: "event", e: "ping-pong", d: { hi: true }, to: guestWelcome.you });
const guestTargeted = await guest.next((f) => f.t === "event", "targeted event at guest");
assert.equal(guestTargeted.e, "ping-pong");
console.log("event broadcast + targeting OK");

// 6. late joiner receives newest snapshot in welcome
const late = await connect();
late.send({ t: "join", v: 3, game: "capy-courier-ab12cd", room });
const lateWelcome = await late.next((f) => f.t === "welcome", "late welcome");
assert.equal(lateWelcome.s.s.tick, 42);
assert.equal(lateWelcome.peers.length, 2);
// ...plus every peer's newest player state
const lateHost = lateWelcome.peers.find((p) => p.id === welcome.you);
assert.deepEqual(lateHost.s, { x: 1, y: 2 });
const lateGuest = lateWelcome.peers.find((p) => p.id === guestWelcome.you);
assert.equal(lateGuest.s, null);
console.log("late-join snapshot + peer-id-keyed states OK (duplicate cid safe)");

// 7. state-req goes to the host (v3: the relay also answers from its cache
// immediately, so expect the cached copy first and the host's fresh one after)
late.send({ t: "state-req" });
const hostReq = await host.next((f) => f.t === "state-req", "state-req at host");
assert.equal(hostReq.from, lateWelcome.you);
const cachedAnswer = await late.next((f) => f.t === "state", "cached state-req answer");
assert.equal(cachedAnswer.s.tick, 42);
host.send({ t: "state", s: { tick: 43 } });
const lateState = await late.next((f) => f.t === "state" && f.s.tick === 43, "refreshed state at late joiner");
assert.equal(lateState.s.tick, 43);
console.log("state-req OK (cache answer + host refresh)");

// 8. join by unknown code without create => room_not_found
const stray = await connect();
stray.send({ t: "join", v: 3, game: "capy-courier-ab12cd", room: "ZZZZZ" });
const strayError = await stray.next((f) => f.t === "error", "room_not_found");
assert.equal(strayError.code, "room_not_found");
stray.close();
console.log("room_not_found OK");

// 9. ping/pong
host.send({ t: "ping", ts: 12345 });
const pong = await host.next((f) => f.t === "pong", "pong");
assert.equal(pong.ts, 12345);
assert.ok(typeof pong.sts === "number", "pong carries server time");
console.log("ping/pong OK");

// 9b. v3: events are stamped with the relay receive time and echoed cid
guest.send({ t: "event", e: "stamped", d: { v: 1 }, seq: 7 });
const stampedEvent = await host.next((f) => f.t === "event" && f.e === "stamped", "stamped event");
assert.equal(stampedEvent.seq, 7);
assert.ok(typeof stampedEvent.ts === "number", "event carries relay ts");
assert.equal(stampedEvent.cid, guestWelcome.cid, "event carries stable cid");
console.log("event seq/ts/cid stamping OK");

// 9c. v3: state-req is answered from the relay cache even when the host
// never implements onStateRequest (a common desync source in v2 games).
const cacheless = await connect();
cacheless.send({ t: "join", v: 3, game: "capy-courier-ab12cd", room });
const cachelessWelcome = await cacheless.next((f) => f.t === "welcome", "cacheless welcome");
cacheless.send({ t: "state-req" });
const cachedState = await cacheless.next((f) => f.t === "state", "cached state answer");
assert.equal(cachedState.s.tick, 43, "cache answers even before the host replies");
assert.ok(typeof cachedState.ts === "number", "cached state carries ts");
// the host still gets the forward and can answer with something fresher
const hostReq2 = await host.next((f) => f.t === "state-req" && f.from === cachelessWelcome.you, "state-req forward");
assert.ok(hostReq2);
cacheless.close();
console.log("state-req cache fallback OK");

// 9d. v3: resend-req is gone from the protocol (ordered delivery + seq dedupe
// + snapshots replaced it); sending it must fail visibly.
guest.send({ t: "resend-req", to: welcome.you, after: 0, before: 5 });
const rejectedResend = await guest.next((f) => f.t === "error" && f.code === "unsupported_frame", "resend-req rejection");
assert.ok(rejectedResend.message.includes("seq"), "rejection points at the recovery model");
console.log("resend-req rejected OK");

// 9e. v3: old protocol versions are rejected outright
const oldClient = await connect();
oldClient.send({ t: "join", v: 2, game: "capy-courier-ab12cd", room });
const versionError = await oldClient.next((f) => f.t === "error" && f.code === "bad_version", "bad_version");
assert.ok(versionError.message.includes("v3"), "error names the supported version");
oldClient.close();
console.log("protocol version enforcement OK");

// 9f. v3: transforms do NOT survive disconnect. The relay deletes peer state
// on disconnect; a reconnecting player is restored from the authoritative
// host snapshot (welcome.s / state-req), never from a retained transform —
// replaying one would rubber-band them from a stale position.
guest.send({ t: "pstate", s: { x: 9, y: 9, hp: 3 } });
await host.next((f) => f.t === "pstate" && f.s.hp === 3, "pstate before drop");
guest.close();
await host.next((f) => f.t === "peer-leave" && f.id === guestWelcome.you, "guest leave");
// reconnect with the SAME cid: identity is honored, but the stale transform is gone
const returning = await connect();
returning.send({ t: "join", v: 3, game: "capy-courier-ab12cd", room, name: "Bo", cid: guestWelcome.cid });
const returnWelcome = await returning.next((f) => f.t === "welcome", "returning welcome");
assert.equal(returnWelcome.cid, guestWelcome.cid, "cid honored on rejoin");
assert.equal(returnWelcome.s.s.tick, 43, "reconnecting player gets the authoritative snapshot");
const observer = await connect();
observer.send({ t: "join", v: 3, game: "capy-courier-ab12cd", room });
const observerWelcome = await observer.next((f) => f.t === "welcome", "observer welcome");
// Key by live peer id: this room deliberately has two connections sharing a
// cid, so a cid lookup alone could match either one.
const boEntry = observerWelcome.peers.find((p) => p.id === returnWelcome.you);
assert.ok(boEntry, "reconnected player appears with their new peer id");
assert.equal(boEntry.cid, guestWelcome.cid, "reconnected player still carries their cid");
assert.equal(boEntry.s, null, "no stale transform retained across the disconnect");
observer.close();
console.log("cid identity kept, stale transforms dropped on disconnect OK");

// 9g. v3: authoritative room state is host-only — a guest publish is rejected
// and must not replace the relay's cached snapshot.
const returningGuest = await connect();
returningGuest.send({ t: "join", v: 3, game: "capy-courier-ab12cd", room, name: "Imposter", cid: "imposter-cid-01" });
const imposterWelcome = await returningGuest.next((f) => f.t === "welcome", "imposter welcome");
returningGuest.send({ t: "state", s: { tick: 999, poisoned: true } });
const notHost = await returningGuest.next((f) => f.t === "error" && f.code === "not_host", "not_host rejection");
assert.ok(notHost, "guest state publish rejected");
const snapshotCheck = await connect();
snapshotCheck.send({ t: "join", v: 3, game: "capy-courier-ab12cd", room });
const snapshotWelcome = await snapshotCheck.next((f) => f.t === "welcome", "snapshot check welcome");
assert.equal(snapshotWelcome.s.s.tick, 43, "cached snapshot untouched by the guest publish");
returningGuest.close();
snapshotCheck.close();
console.log("guest publishState rejected, snapshot intact OK");

// 10. host leaves => host migration announced to remaining peers
host.close();
const migrationAtLate = await late.next((f) => f.t === "peer-leave" && f.id === welcome.you, "peer-leave at late");
assert.ok(migrationAtLate.host, "new host announced");
console.log("host migration OK ->", migrationAtLate.host);

// 11. the promoted host (the oldest remaining peer — `late`, joined in 6)
// publishes state to the room; `returning` as a guest only receives.
late.send({ t: "state", s: { tick: 44, note: "new host" } });
const lateState2 = await returning.next((f) => f.t === "state" && f.s.tick === 44, "state from new host");
assert.ok(lateState2);
returning.send({ t: "state", s: { tick: 45, note: "guest attempt" } });
const demoted = await returning.next((f) => f.t === "error" && f.code === "not_host", "ex-host rejected");
assert.ok(demoted, "non-host cannot publish state");
console.log("promoted-host publish OK; guests still rejected");

// 12. bad frames rejected politely
returning.send("this is not json");
const err1 = await returning.next((f) => f.t === "error", "bad json error");
assert.equal(err1.code, "bad_frame");
returning.send({ t: "warp" });
const err2 = await returning.next((f) => f.t === "error", "unknown frame error");
assert.equal(err2.code, "unknown_frame");
console.log("bad-frame handling OK");

// 13. stats endpoint reflects rooms
await sleep(150);
const stats = await (await fetch(`${BASE}/stats`)).json();
assert.ok(stats.games >= 2);
assert.ok(stats.rooms >= 2);
assert.ok(stats.clients >= 2);
console.log("stats OK:", stats.games, "games,", stats.rooms, "rooms,", stats.clients, "clients");

// 14. single-server mode: every player lands in the same shared arena room
const arenaA = await connect();
arenaA.send({ t: "join", v: 3, game: "arena-game-01", mode: "single", name: "First" });
const arenaWelcomeA = await arenaA.next((f) => f.t === "welcome", "single-mode welcome A");
assert.equal(arenaWelcomeA.mode, "single");
assert.equal(arenaWelcomeA.room, "ARENA");
assert.equal(arenaWelcomeA.created, true);

const arenaB = await connect();
arenaB.send({ t: "join", v: 3, game: "arena-game-01", mode: "single", name: "Second" });
const arenaWelcomeB = await arenaB.next((f) => f.t === "welcome", "single-mode welcome B");
assert.equal(arenaWelcomeB.room, "ARENA");
assert.equal(arenaWelcomeB.created, false);
assert.equal(arenaWelcomeB.peers.length, 1);
assert.equal(arenaWelcomeB.peers[0].id, arenaWelcomeA.you);
const arenaJoin = await arenaA.next((f) => f.t === "peer-join", "peer-join in shared arena");
assert.equal(arenaJoin.peer.id, arenaWelcomeB.you);
console.log("single-server mode OK: both players share room", arenaWelcomeA.room);

// 15. single-server rooms are isolated per game and from code rooms
const arenaC = await connect();
arenaC.send({ t: "join", v: 3, game: "arena-game-02", mode: "single", name: "Other" });
const arenaWelcomeC = await arenaC.next((f) => f.t === "welcome", "single-mode welcome C");
assert.equal(arenaWelcomeC.room, "ARENA");
assert.equal(arenaWelcomeC.peers.length, 0);
arenaB.send({ t: "event", e: "hello", d: { to: "everyone" } });
const arenaEvent = await arenaA.next((f) => f.t === "event" && f.e === "hello", "event inside shared arena");
assert.equal(arenaEvent.from, arenaWelcomeB.you);
console.log("single-server isolation OK: separate game and rooms unaffected");

// 14b. the ARENA namespace is reserved: code-addressed joins cannot touch it
const arenaSquatter = await connect();
arenaSquatter.send({ t: "join", v: 3, game: "arena-game-01", room: "ARENA", create: true, name: "Squatter" });
const reservedError = await arenaSquatter.next((f) => f.t === "error" && f.code === "reserved_room", "reserved_room rejection");
assert.ok(reservedError.message.includes("single"), "rejection names the single-server mode");
arenaSquatter.close();
console.log("ARENA reserved against code-addressed joins OK");

arenaA.close();
arenaB.close();
arenaC.close();
guest.close();
late.close();
other.close();
await sleep(150);
console.log("\nALL RELAY SMOKE TESTS PASSED");
process.exit(0);
