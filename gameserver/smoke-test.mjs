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
assert.equal(health.protocol, 2);
console.log("health OK:", JSON.stringify(health));

// 1. host creates a room in game A
const host = await connect();
host.send({ t: "join", v: 1, game: "capy-courier-ab12cd", create: true, name: "Ana" });
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
guest.send({ t: "join", v: 1, game: "capy-courier-ab12cd", room, name: "Bo" });
const guestWelcome = await guest.next((f) => f.t === "welcome", "guest welcome");
assert.equal(guestWelcome.room, room);
assert.equal(guestWelcome.host, welcome.you);
assert.equal(guestWelcome.peers.length, 1);
const hostSeesJoin = await host.next((f) => f.t === "peer-join", "peer-join at host");
assert.equal(hostSeesJoin.peer.name, "Bo");
console.log("guest joined; host sees roster");

// 3. tenant isolation: same code in game B is a *different* room (auto-created with create:true)
const other = await connect();
other.send({ t: "join", v: 1, game: "hover-yard-998877", room, create: true, name: "Zed" });
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

// 4b. peer-owned state: direct relay to the room, no host involvement
host.send({ t: "pstate", s: { x: 1, y: 2 } });
const guestP = await guest.next((f) => f.t === "pstate", "pstate at guest");
assert.equal(guestP.from, welcome.you);
assert.deepEqual(guestP.s, { x: 1, y: 2 });
console.log("pstate relay OK");

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
late.send({ t: "join", v: 1, game: "capy-courier-ab12cd", room });
const lateWelcome = await late.next((f) => f.t === "welcome", "late welcome");
assert.equal(lateWelcome.s.s.tick, 42);
assert.equal(lateWelcome.peers.length, 2);
// ...plus every peer's newest player state
const lateHost = lateWelcome.peers.find((p) => p.id === welcome.you);
assert.deepEqual(lateHost.s, { x: 1, y: 2 });
const lateGuest = lateWelcome.peers.find((p) => p.id === guestWelcome.you);
assert.equal(lateGuest.s, null);
console.log("late-join snapshot + peer states OK");

// 7. state-req goes to the host
late.send({ t: "state-req" });
const hostReq = await host.next((f) => f.t === "state-req", "state-req at host");
assert.equal(hostReq.from, lateWelcome.you);
host.send({ t: "state", s: { tick: 43 } });
const lateState = await late.next((f) => f.t === "state", "refreshed state at late joiner");
assert.equal(lateState.s.tick, 43);
console.log("state-req OK");

// 8. join by unknown code without create => room_not_found
const stray = await connect();
stray.send({ t: "join", v: 1, game: "capy-courier-ab12cd", room: "ZZZZZ" });
const strayError = await stray.next((f) => f.t === "error", "room_not_found");
assert.equal(strayError.code, "room_not_found");
stray.close();
console.log("room_not_found OK");

// 9. ping/pong
host.send({ t: "ping", ts: 12345 });
const pong = await host.next((f) => f.t === "pong", "pong");
assert.equal(pong.ts, 12345);
console.log("ping/pong OK");

// 10. host leaves => host migration announced to remaining peers
host.close();
const migrationAtGuest = await guest.next((f) => f.t === "peer-leave", "peer-leave at guest");
assert.equal(migrationAtGuest.id, welcome.you);
assert.equal(migrationAtGuest.host, guestWelcome.you);
const migrationAtLate = await late.next((f) => f.t === "peer-leave", "peer-leave at late");
assert.equal(migrationAtLate.host, guestWelcome.you);
console.log("host migration OK ->", migrationAtGuest.host);

// 11. promoted host can publish state to the room
guest.send({ t: "state", s: { tick: 44, note: "new host" } });
const lateState2 = await late.next((f) => f.t === "state" && f.s.tick === 44, "state from new host");
assert.ok(lateState2);
console.log("promoted-host publish OK");

// 12. bad frames rejected politely
guest.send("this is not json");
const err1 = await guest.next((f) => f.t === "error", "bad json error");
assert.equal(err1.code, "bad_frame");
guest.send({ t: "warp" });
const err2 = await guest.next((f) => f.t === "error", "unknown frame error");
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
arenaA.send({ t: "join", v: 2, game: "arena-game-01", mode: "single", name: "First" });
const arenaWelcomeA = await arenaA.next((f) => f.t === "welcome", "single-mode welcome A");
assert.equal(arenaWelcomeA.mode, "single");
assert.equal(arenaWelcomeA.room, "ARENA");
assert.equal(arenaWelcomeA.created, true);

const arenaB = await connect();
arenaB.send({ t: "join", v: 2, game: "arena-game-01", mode: "single", name: "Second" });
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
arenaC.send({ t: "join", v: 2, game: "arena-game-02", mode: "single", name: "Other" });
const arenaWelcomeC = await arenaC.next((f) => f.t === "welcome", "single-mode welcome C");
assert.equal(arenaWelcomeC.room, "ARENA");
assert.equal(arenaWelcomeC.peers.length, 0);
arenaB.send({ t: "event", e: "hello", d: { to: "everyone" } });
const arenaEvent = await arenaA.next((f) => f.t === "event" && f.e === "hello", "event inside shared arena");
assert.equal(arenaEvent.from, arenaWelcomeB.you);
console.log("single-server isolation OK: separate game and rooms unaffected");

arenaA.close();
arenaB.close();
arenaC.close();
guest.close();
late.close();
other.close();
await sleep(150);
console.log("\nALL RELAY SMOKE TESTS PASSED");
process.exit(0);
