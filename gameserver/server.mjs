// ThreadSite multiplayer relay — one shared, multi-tenant WebSocket service.
//
// Every game the harness publishes is a tenant, addressed by its game id (the
// site slug). Rooms are namespaced per game, so room code AB3CK in one game is
// a different room than AB3CK in another. The server is a relay only: it holds
// the last snapshot a room published, assigns peer ids, promotes a new host
// when the old one leaves, and forwards JSON frames between peers. It never
// interprets game state.
//
// Wire protocol: ThreadSite Multiplayer Protocol v1 (documented in the game
// AGENTS.md profiles and implemented by the vendored site/js/threadsite-net.js
// browser client).

import http from "node:http";
import { WebSocketServer } from "ws";

const PROTOCOL_VERSION = 2;

function env(name, fallback = "") {
  return (process.env[name] ?? "").trim() || fallback;
}

function intEnv(name, fallback) {
  const raw = env(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(`[threadsite-gameserver] Ignoring unparseable ${name}=${raw}; using ${fallback}.`);
    return fallback;
  }
  return value;
}

const HOST = env("GAMESERVER_HOST", "0.0.0.0");
const PORT = intEnv("GAMESERVER_PORT", 8090);
const MAX_PEERS_PER_ROOM = intEnv("GAMESERVER_MAX_PEERS_PER_ROOM", 16);
const MAX_ROOMS_PER_GAME = intEnv("GAMESERVER_MAX_ROOMS_PER_GAME", 256);
const MAX_MESSAGE_BYTES = intEnv("GAMESERVER_MAX_MESSAGE_BYTES", 64 * 1024);
const RATE_PER_SECOND = intEnv("GAMESERVER_RATE_PER_SECOND", 60);
const RATE_BURST = intEnv("GAMESERVER_RATE_BURST", 120);
const ROOM_TTL_MS = intEnv("GAMESERVER_ROOM_TTL_MS", 10 * 60 * 1000);
const JOIN_TIMEOUT_MS = intEnv("GAMESERVER_JOIN_TIMEOUT_MS", 10_000);
const ALLOWED_ORIGINS = env("GAMESERVER_ALLOWED_ORIGINS")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

// Unambiguous alphabet: no I, L, O, 0, 1.
const ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const GAME_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_ALPHABET}]{4,12}$`);
const MAX_NAME_LENGTH = 32;
// Single-server mode: every player of a game joins this one fixed room instead
// of code-addressed rooms. Chosen from the room alphabet so it round-trips
// through reconnects like any other code.
const SINGLE_ROOM_CODE = "ARENA";

const games = new Map(); // gameId -> Map<roomCode, Room>
let nextPeerSeq = 0;
let lastRateWarning = 0;

class RateLimiter {
  constructor(perSecond, burst) {
    this.tokens = burst;
    this.capacity = burst;
    this.refillPerMs = perSecond / 1000;
    this.updatedAt = Date.now();
  }

  allow() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.updatedAt) * this.refillPerMs);
    this.updatedAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

class Room {
  constructor(code) {
    this.code = code;
    this.peers = new Map(); // peerId -> peer; insertion order = join order, so the
    // first entry is always the current host (oldest peer).
    this.lastState = null;
    this.lastStateFrom = null;
    // Each peer's newest self-owned player state (peer-state model), retained so
    // late joiners and reconnecting clients see everyone immediately.
    this.peerStates = new Map(); // peerId -> latest pstate payload
    this.lastActivity = Date.now();
  }

  get hostId() {
    return this.peers.keys().next().value ?? null;
  }

  touch() {
    this.lastActivity = Date.now();
  }
}

function send(peer, frame) {
  if (peer?.ws?.readyState === peer.ws.OPEN) {
    try {
      peer.ws.send(JSON.stringify(frame));
    } catch {
      // A dying socket; the close handler will clean the peer up.
    }
  }
}

function broadcast(room, frame, exceptPeerId) {
  for (const peer of room.peers.values()) {
    if (peer.id !== exceptPeerId) send(peer, frame);
  }
}

function errorFrame(code, message) {
  return { t: "error", code, message };
}

function sanitizeName(raw) {
  const value = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return value || "player";
}

function makeRoomCode(gameRooms) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let code = "";
    for (let i = 0; i < 5; i += 1) {
      code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    }
    if (!gameRooms.has(code)) return code;
  }
  // Vanishingly unlikely; fall back to a longer code.
  return `Z${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

function roomSnapshot(room) {
  return {
    code: room.code,
    peers: [...room.peers.values()].map((peer) => ({ id: peer.id, name: peer.name })),
    host: room.hostId,
    lastState: room.lastState === null ? null : { from: room.lastStateFrom, state: room.lastState },
  };
}

function statsPayload() {
  let rooms = 0;
  let clients = 0;
  const perGame = [];
  for (const [gameId, gameRooms] of games) {
    let gameClients = 0;
    for (const room of gameRooms.values()) gameClients += room.peers.size;
    rooms += gameRooms.size;
    clients += gameClients;
    perGame.push({ game: gameId, rooms: gameRooms.size, clients: gameClients });
  }
  return {
    ok: true,
    protocol: PROTOCOL_VERSION,
    uptimeSec: Math.floor(process.uptime()),
    games: games.size,
    rooms,
    clients,
    perGame,
  };
}

function removeRoomIfEmpty(gameId, room) {
  if (room.peers.size > 0) return;
  const gameRooms = games.get(gameId);
  if (!gameRooms) return;
  // Keep empty rooms around until the TTL so a page refresh or brief disconnect
  // can rejoin with the last snapshot intact.
  if (Date.now() - room.lastActivity >= ROOM_TTL_MS) {
    gameRooms.delete(room.code);
    if (gameRooms.size === 0) games.delete(gameId);
  }
}

function handleJoin(peer, msg) {
  const gameId = String(msg.game ?? "");
  if (!GAME_ID_PATTERN.test(gameId)) {
    send(peer, errorFrame("bad_game", "join.game must be the harness game id (lowercase slug, 3-64 chars)."));
    return;
  }
  const singleServer = String(msg.mode ?? "").toLowerCase() === "single";
  const wantsCreate = Boolean(msg.create);
  const requestedCode = singleServer
    ? SINGLE_ROOM_CODE
    : String(msg.room ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");

  let gameRooms = games.get(gameId);
  if (!gameRooms) {
    gameRooms = new Map();
    games.set(gameId, gameRooms);
  }

  let room = requestedCode ? gameRooms.get(requestedCode) : undefined;
  if (!room && requestedCode && !wantsCreate && !singleServer) {
    send(peer, errorFrame("room_not_found", `No room ${requestedCode} is open in this game right now.`));
    if (gameRooms.size === 0) games.delete(gameId);
    return;
  }
  if (!room) {
    if (gameRooms.size >= MAX_ROOMS_PER_GAME) {
      send(peer, errorFrame("too_many_rooms", `This game already has ${MAX_ROOMS_PER_GAME} open rooms.`));
      if (gameRooms.size === 0) games.delete(gameId);
      return;
    }
    const code = requestedCode && ROOM_CODE_PATTERN.test(requestedCode) ? requestedCode : makeRoomCode(gameRooms);
    room = new Room(code);
    gameRooms.set(code, room);
    peer.createdRoom = true;
  } else {
    peer.createdRoom = false;
    if (room.peers.size >= MAX_PEERS_PER_ROOM) {
      send(peer, errorFrame("room_full", `Room ${room.code} is full (${MAX_PEERS_PER_ROOM} peers max).`));
      return;
    }
  }

  peer.game = gameId;
  peer.room = room;
  peer.name = sanitizeName(msg.name);
  room.peers.set(peer.id, peer);
  room.touch();

  const hostId = room.hostId;
  send(peer, {
    t: "welcome",
    v: PROTOCOL_VERSION,
    you: peer.id,
    room: room.code,
    mode: singleServer ? "single" : "rooms",
    created: Boolean(peer.createdRoom),
    peers: [...room.peers.values()]
      .filter((other) => other.id !== peer.id)
      .map((other) => ({ id: other.id, name: other.name, s: room.peerStates.get(other.id) ?? null })),
    host: hostId,
    s: room.lastState === null ? null : { from: room.lastStateFrom, s: room.lastState },
  });
  broadcast(room, { t: "peer-join", peer: { id: peer.id, name: peer.name }, host: hostId }, peer.id);
  console.log(`[threadsite-gameserver] join game=${gameId} room=${room.code}${singleServer ? " (single-server)" : ""} peer=${peer.id} peers=${room.peers.size}`);
}

function handleFrame(peer, msg) {
  switch (msg.t) {
    case "event": {
      const room = peer.room;
      const type = typeof msg.e === "string" ? msg.e.slice(0, 64) : "";
      if (!room || !type) {
        send(peer, errorFrame("bad_frame", "event needs a string e and an active room."));
        return;
      }
      room.touch();
      const frame = { t: "event", from: peer.id, e: type, d: msg.d ?? null };
      const target = typeof msg.to === "string" ? room.peers.get(msg.to) : undefined;
      if (msg.to !== undefined) {
        if (target) send(target, frame);
        else send(peer, errorFrame("bad_target", `Peer ${msg.to} is not in this room.`));
      } else {
        broadcast(room, frame, peer.id);
      }
      return;
    }
    case "state": {
      const room = peer.room;
      if (!room) {
        send(peer, errorFrame("not_joined", "Join a room before publishing state."));
        return;
      }
      room.touch();
      room.lastState = msg.s ?? null;
      room.lastStateFrom = peer.id;
      broadcast(room, { t: "state", from: peer.id, s: msg.s ?? null }, peer.id);
      return;
    }
    case "pstate": {
      // Peer-owned state: each player broadcasts their own entity without any
      // host round trip. The newest payload per peer is retained for joiners.
      const room = peer.room;
      if (!room) {
        send(peer, errorFrame("not_joined", "Join a room before publishing player state."));
        return;
      }
      room.touch();
      room.peerStates.set(peer.id, msg.s ?? null);
      broadcast(room, { t: "pstate", from: peer.id, s: msg.s ?? null }, peer.id);
      return;
    }
    case "state-req": {
      const room = peer.room;
      if (!room) {
        send(peer, errorFrame("not_joined", "Join a room before requesting state."));
        return;
      }
      const host = room.peers.get(room.hostId);
      if (host && host !== peer) send(host, { t: "state-req", from: peer.id });
      else if (room.lastState !== null) send(peer, { t: "state", from: room.lastStateFrom, s: room.lastState });
      return;
    }
    case "ping":
      send(peer, { t: "pong", ts: msg.ts ?? null });
      return;
    default:
      send(peer, errorFrame("unknown_frame", `Unsupported frame type '${String(msg.t)}'.`));
  }
}

const server = http.createServer((req, res) => {
  const pathname = (() => {
    try {
      return new URL(req.url ?? "/", "http://internal").pathname;
    } catch {
      return "/";
    }
  })();

  if (req.method === "GET" && (pathname === "/health" || pathname === "/stats")) {
    const body = JSON.stringify(statsPayload());
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(body);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("ThreadSite multiplayer relay. WebSocket endpoint: /ws\n");
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  let pathname = "/";
  try {
    pathname = new URL(req.url ?? "/", "http://internal").pathname;
  } catch {
    // fall through with "/" so non-parseable targets are rejected below
  }
  if (pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes("*")) {
    const origin = String(req.headers.origin ?? "").toLowerCase();
    if (!ALLOWED_ORIGINS.includes(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  ws.isAlive = true;

  const peer = {
    id: `p-${(nextPeerSeq += 1)}`,
    ws,
    name: "player",
    game: null,
    room: null,
    limiter: new RateLimiter(RATE_PER_SECOND, RATE_BURST),
    createdRoom: false,
    joinedAt: Date.now(),
  };

  const joinTimer = setTimeout(() => {
    if (!peer.room) ws.close(4000, "join timeout");
  }, JOIN_TIMEOUT_MS);

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      send(peer, errorFrame("bad_frame", "Binary frames are not part of the protocol; send JSON text."));
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      send(peer, errorFrame("bad_frame", "Frames must be UTF-8 JSON objects."));
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.t !== "string") {
      send(peer, errorFrame("bad_frame", "Frames must be {t: \"...\", ...} objects."));
      return;
    }

    if (msg.t === "join") {
      if (peer.room) {
        send(peer, errorFrame("already_joined", "This connection already joined a room."));
        return;
      }
      handleJoin(peer, msg);
      if (peer.room) clearTimeout(joinTimer);
      return;
    }

    if (!peer.limiter.allow()) {
      const now = Date.now();
      if (now - lastRateWarning > 1000) {
        lastRateWarning = now;
        console.warn(`[threadsite-gameserver] rate_limited peer=${peer.id} game=${peer.game ?? "-"} room=${peer.room?.code ?? "-"}`);
      }
      send(peer, errorFrame("rate_limited", `More than ${RATE_PER_SECOND} frames/sec; slow down.`));
      return;
    }

    handleFrame(peer, msg);
  });

  ws.on("close", () => {
    clearTimeout(joinTimer);
    const room = peer.room;
    if (room) {
      const wasHost = room.hostId === peer.id;
      room.peers.delete(peer.id);
      room.peerStates.delete(peer.id);
      room.touch();
      const newHost = room.hostId;
      broadcast(room, { t: "peer-leave", id: peer.id, host: newHost }, peer.id);
      if (wasHost && newHost) {
        console.log(`[threadsite-gameserver] host_migrated game=${peer.game} room=${room.code} from=${peer.id} to=${newHost}`);
      }
      removeRoomIfEmpty(peer.game, room);
    }
    console.log(`[threadsite-gameserver] leave peer=${peer.id} game=${peer.game ?? "-"} room=${room?.code ?? "-"}`);
  });

  ws.on("error", () => {
    // Close handling above performs the cleanup.
  });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);
heartbeat.unref();

const sweeper = setInterval(() => {
  for (const [gameId, gameRooms] of games) {
    for (const [code, room] of gameRooms) {
      if (room.peers.size === 0 && Date.now() - room.lastActivity >= ROOM_TTL_MS) {
        gameRooms.delete(code);
      }
    }
    if (gameRooms.size === 0) games.delete(gameId);
  }
}, 30_000);
sweeper.unref();

server.listen(PORT, HOST, () => {
  console.log(
    `[threadsite-gameserver] listening on ${HOST}:${PORT} (protocol v${PROTOCOL_VERSION}, ws path /ws)` +
    ` caps: ${MAX_PEERS_PER_ROOM} peers/room, ${MAX_ROOMS_PER_GAME} rooms/game, ${MAX_MESSAGE_BYTES} bytes/frame, ${RATE_PER_SECOND}/s per peer` +
    (ALLOWED_ORIGINS.length ? ` origins: ${ALLOWED_ORIGINS.join(",")}` : " origins: any"),
  );
});

function shutdown() {
  console.log("[threadsite-gameserver] shutting down; notifying rooms.");
  const bye = { t: "bye", reason: "shutdown" };
  for (const gameRooms of games.values()) {
    for (const room of gameRooms.values()) broadcast(room, bye);
  }
  for (const ws of wss.clients) ws.close(1001, "server shutdown");
  setTimeout(() => process.exit(0), 1500).unref();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
