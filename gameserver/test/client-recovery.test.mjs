import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { NET_STATUS, ThreadSiteNet } from "../../bot/assets/threadsite-net.js";

async function relay(t, onConnection) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  server.on("connection", onConnection);
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return `ws://127.0.0.1:${server.address().port}`;
}

function welcome(socket) {
  socket.send(JSON.stringify({ t: "welcome", v: 4, you: "p-1", host: "p-1", generation: "test", epoch: 1,
    mode: "rooms", room: "ABCDE", peers: [], persistence: { version: 1, playerId: "player-1" } }));
}

async function waitFor(check) {
  const deadline = Date.now() + 4000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(check(), "client should settle rather than reconnect forever");
}

for (const code of ["project_deleted", "access_denied"]) {
  test(`a ${code} rejection during reconnect closes a previously joined client`, async (t) => {
    let connections = 0;
    let first;
    const url = await relay(t, (socket) => {
      connections++;
      socket.once("message", () => {
        if (connections === 1) { first = socket; welcome(socket); }
        else {
          socket.send(JSON.stringify({ t: "error", code, message: "Join refused" }));
          socket.close(4000, code);
        }
      });
    });
    const client = await ThreadSiteNet.connect({ game: "recovery-test", url });
    t.after(() => client.close());
    first.close(4001, "transport lost");
    await waitFor(() => client.status === NET_STATUS.CLOSED);
    assert.equal(connections, 2);
    assert.equal(client.id, null);
  });
}

test("a project deletion also closes an online client", async (t) => {
  let peer;
  const url = await relay(t, (socket) => {
    peer = socket;
    socket.once("message", () => welcome(socket));
  });
  const client = await ThreadSiteNet.connect({ game: "online-deletion", url });
  t.after(() => client.close());
  peer.send(JSON.stringify({ t: "error", code: "project_deleted", message: "Deleted" }));
  await waitFor(() => client.status === NET_STATUS.CLOSED && client.id === null);
  assert.equal(client.id, null);
});

test("an operational frame rejection leaves an online client usable", async (t) => {
  let peer;
  const url = await relay(t, (socket) => {
    peer = socket;
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw);
      if (frame.t === "join") welcome(socket);
      if (frame.t === "storage") socket.send(JSON.stringify({ t: "storage-result", id: frame.id, ok: true,
        result: { value: "saved", revision: 1, updatedAt: 1 } }));
    });
  });
  const client = await ThreadSiteNet.connect({ game: "frame-rejection", url });
  t.after(() => client.close());
  peer.send(JSON.stringify({ t: "error", code: "not_host", message: "Host only" }));
  assert.equal((await client.saves.get("slot")).value, "saved");
  assert.equal(client.status, NET_STATUS.ONLINE);
});

test("an open socket that never receives welcome obeys the connection timeout", async (t) => {
  const url = await relay(t, () => {});
  const client = new ThreadSiteNet({ game: "welcome-timeout", url, connectTimeoutMs: 1000, autoReconnect: false });
  t.after(() => client.close());
  let timer;
  try {
    await assert.rejects(Promise.race([client.opened, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("welcome never timed out")), 1800);
    })]), { code: "connect_timeout" });
  } finally { clearTimeout(timer); }
});

test("a superseded attempt's timeout cannot disrupt the welcomed replacement", async (t) => {
  let connections = 0;
  const url = await relay(t, (socket) => {
    connections++;
    socket.once("message", () => { if (connections > 1) welcome(socket); });
  });
  const client = new ThreadSiteNet({ game: "superseded-timeout", url, connectTimeoutMs: 1000 });
  t.after(() => client.close());
  await waitFor(() => connections === 1);
  client.connectSocket();
  await client.opened;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(client.status, NET_STATUS.ONLINE);
  assert.equal(connections, 2);
});

test("disabling automatic reconnection also applies after a successful join", async (t) => {
  let peer;
  const url = await relay(t, (socket) => {
    peer = socket;
    socket.once("message", () => welcome(socket));
  });
  const client = await ThreadSiteNet.connect({ game: "no-reconnect", url, autoReconnect: false });
  t.after(() => client.close());
  peer.close(4001, "transport lost");
  await waitFor(() => client.status === NET_STATUS.CLOSED);
});
