// Protocol v4 relay conformance tests. Run with the relay already listening.
import assert from "node:assert/strict";

const PORT = process.env.GAMESERVER_TEST_PORT || "8090";
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const HTTP_URL = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const frames = [];
    const waiters = [];
    ws.onmessage = (event) => {
      const frame = JSON.parse(event.data);
      const index = waiters.findIndex((waiter) => waiter.predicate(frame));
      if (index < 0) frames.push(frame);
      else waiters.splice(index, 1)[0].resolve(frame);
    };
    ws.onerror = () => reject(new Error("socket error"));
    ws.onopen = () => resolve({
      ws,
      send: (frame) => ws.send(JSON.stringify(frame)),
      close: () => ws.close(),
      next: (predicate, label, timeoutMs = 3000) => new Promise((resolveFrame, rejectFrame) => {
        const buffered = frames.findIndex(predicate);
        if (buffered >= 0) { resolveFrame(frames.splice(buffered, 1)[0]); return; }
        const waiter = { predicate, resolve: (frame) => { clearTimeout(timer); resolveFrame(frame); } };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          rejectFrame(new Error(`timeout waiting for ${label}`));
        }, timeoutMs);
        waiters.push(waiter);
      }),
    });
  });
}

const health = await (await fetch(`${HTTP_URL}/health`)).json();
assert.equal(health.protocol, 4);

const host = await connect();
host.send({ t: "join", v: 4, game: "relay-v4-test", create: true, name: "Host", cid: "same-tab-cid" });
const hostWelcome = await host.next((f) => f.t === "welcome", "host welcome");
assert.equal(hostWelcome.epoch, 1);
assert.equal(hostWelcome.host, hostWelcome.you);
assert.equal(typeof hostWelcome.generation, "string");
assert.match(hostWelcome.room, /^[A-Z2-9]{5}$/);

const guest = await connect();
guest.send({ t: "join", v: 4, game: "relay-v4-test", room: hostWelcome.room, name: "Guest", cid: "same-tab-cid" });
const guestWelcome = await guest.next((f) => f.t === "welcome", "guest welcome");
assert.notEqual(guestWelcome.you, hostWelcome.you, "duplicate cid tabs remain distinct peers");
assert.equal(guestWelcome.host, hostWelcome.you);

host.send({ t: "world", generation: hostWelcome.generation, epoch: 1, s: { tick: 1, enemy: "alive" } });
const hostAck = await host.next((f) => f.t === "world-ack", "host world acknowledgement");
assert.equal(hostAck.generation, hostWelcome.generation);
const world1 = await guest.next((f) => f.t === "world", "first world");
assert.deepEqual([world1.epoch, world1.seq], [1, 1]);
assert.equal(world1.generation, hostWelcome.generation);

guest.send({ t: "world", generation: hostWelcome.generation, epoch: 1, s: { tick: 999 } });
assert.equal((await guest.next((f) => f.code === "not_host", "guest rejection")).code, "not_host");

host.send({ t: "pstate", pt: 1, s: { x: 10, y: 20, vx: 2 } });
const transform = await guest.next((f) => f.t === "pstate", "transform");
assert.equal(transform.pt, 1);
assert.equal(transform.ts > 0, true);
host.send({ t: "pstate", pt: 2, s: { x: 11, y: 20, vx: 2 } });
const transform2 = await guest.next((f) => f.t === "pstate" && f.pt === 2, "second transform");
assert.ok(transform2.ts > transform.ts, "relay transform timestamps are monotonic per peer");
host.send({ t: "presence", s: { character: "mage", ready: true } });
const presence = await guest.next((f) => f.t === "presence", "presence");
assert.equal(presence.s.character, "mage");
host.send({ t: "signal", to: guestWelcome.you, e: "aim", d: { angle: 1.5 } });
const signal = await guest.next((f) => f.t === "signal" && f.e === "aim", "ephemeral signal");
assert.equal(signal.d.angle, 1.5);

const late = await connect();
late.send({ t: "join", v: 4, game: "relay-v4-test", room: hostWelcome.room, name: "Late" });
const lateWelcome = await late.next((f) => f.t === "welcome", "late welcome");
assert.equal(lateWelcome.world.s.tick, 1, "late join receives cached authoritative world");
assert.equal(lateWelcome.peers.find((p) => p.id === hostWelcome.you).pt, 2, "late join receives newest transform");
assert.equal(lateWelcome.peers.find((p) => p.id === hostWelcome.you).presence.character, "mage", "late join receives presence");

host.send({ t: "event", id: "target.1", to: guestWelcome.you, e: "hit", d: { damage: 2 } });
const targeted = await guest.next((f) => f.t === "event" && f.id === "target.1", "target event");
assert.equal(targeted.from, hostWelcome.you);

host.send({ t: "world", generation: hostWelcome.generation, epoch: 1, s: { tick: 2, enemy: "hurt" } });
await guest.next((f) => f.t === "world" && f.s.tick === 2, "final old-host world");
host.send({ t: "yield-host", generation: hostWelcome.generation, epoch: 1 });
const acquired = await guest.next((f) => f.t === "authority", "yield authority");
assert.equal(acquired.host, guestWelcome.you);
assert.equal(acquired.epoch, 2);
assert.equal(acquired.world.s.tick, 2, "migration carries complete cached world");

host.send({ t: "world", generation: hostWelcome.generation, epoch: 1, s: { tick: 3, poison: true } });
assert.equal((await host.next((f) => f.code === "not_host", "old host rejection")).code, "not_host");
guest.send({ t: "world", generation: hostWelcome.generation, epoch: 1, s: { tick: 3 } });
assert.equal((await guest.next((f) => f.code === "stale_authority", "stale epoch rejection")).code, "stale_authority");
guest.send({ t: "world", generation: "stale-room-generation", epoch: 2, s: { tick: 3 } });
const staleGeneration = await guest.next((f) => f.code === "stale_authority", "stale generation rejection");
assert.equal(staleGeneration.generation, hostWelcome.generation);
guest.send({ t: "world", generation: hostWelcome.generation, epoch: 2, s: { tick: 3, enemy: "dead" } });
const world3 = await late.next((f) => f.t === "world" && f.s.tick === 3, "new host world");
assert.deepEqual([world3.epoch, world3.seq], [2, 3]);

guest.close();
const migration = await late.next((f) => f.t === "authority" && f.epoch === 3, "disconnect migration");
assert.equal(migration.host, lateWelcome.you);
assert.equal(migration.epoch, 3);

const singleA = await connect();
singleA.send({ t: "join", v: 4, game: "single-v4-test", mode: "single", name: "A" });
const singleWelcomeA = await singleA.next((f) => f.t === "welcome", "single A");
assert.equal(singleWelcomeA.room, null, "single room implementation key is not public API");
const singleB = await connect();
singleB.send({ t: "join", v: 4, game: "single-v4-test", mode: "single", name: "B" });
const singleWelcomeB = await singleB.next((f) => f.t === "welcome", "single B");
assert.equal(singleWelcomeB.host, singleWelcomeA.you);

const resumed = await connect();
const resumeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const resumeCode = Array.from({ length: 8 }, () => resumeAlphabet[Math.floor(Math.random() * resumeAlphabet.length)]).join("");
resumed.send({ t: "join", v: 4, game: "resume-v4-test", mode: "rooms", room: resumeCode, resume: true, name: "Recovery" });
const resumedWelcome = await resumed.next((f) => f.t === "welcome", "resume missing room");
assert.equal(resumedWelcome.room, resumeCode);
assert.equal(resumedWelcome.created, true, "a reconnect may safely recreate a room lost with relay memory");

for (const peer of [host, late, singleA, singleB, resumed]) peer.close();
await sleep(50);
console.log("ALL RELAY V4 CONFORMANCE TESTS PASSED");
