// ThreadSite Multiplayer Protocol v4 relay.
// The relay owns rooms, routing, host authority, epochs, timestamps and caches.
// It deliberately does not interpret or simulate game state.

import fs from "node:fs/promises";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import zlib from "node:zlib";
import { WebSocket, WebSocketServer, type RawData } from "ws";

const PROTOCOL_VERSION = 4;
const SINGLE_ROOM_KEY = "@single";
const ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const GAME_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_ALPHABET}]{4,12}$`);
const CID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function env(name: string, fallback = ""): string { return (process.env[name] ?? "").trim() || fallback; }
function intEnv(name: string, fallback: number): number {
  const value = Number.parseInt(env(name), 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

const HOST = env("GAMESERVER_HOST", "0.0.0.0");
const PORT = intEnv("GAMESERVER_PORT", 8090);
const MAX_PEERS_PER_ROOM = intEnv("GAMESERVER_MAX_PEERS_PER_ROOM", 16);
const MAX_ROOMS_PER_GAME = intEnv("GAMESERVER_MAX_ROOMS_PER_GAME", 256);
// 264 KB keeps headroom above the net client's 256 KB frame cap, so an
// oversized world always fails as a clean client-side frame_too_large instead
// of a relay connection drop. Worlds with hundreds of entities at 10-20 Hz fit.
const MAX_MESSAGE_BYTES = intEnv("GAMESERVER_MAX_MESSAGE_BYTES", 264 * 1024);
// Slow-consumer socket buffer: with 256 KB frames, 1 MB holds ~4 in-flight
// worlds before the recoverable 1013 close, so 10-20 Hz publishing to a
// momentarily stalled peer degrades gracefully instead of churning reconnects.
const MAX_BUFFERED_BYTES = intEnv("GAMESERVER_MAX_BUFFERED_BYTES", 1024 * 1024);
const RATE_PER_SECOND = intEnv("GAMESERVER_RATE_PER_SECOND", 60);
const RATE_BURST = intEnv("GAMESERVER_RATE_BURST", 120);
const ROOM_TTL_MS = intEnv("GAMESERVER_ROOM_TTL_MS", 10 * 60 * 1000);
const JOIN_TIMEOUT_MS = intEnv("GAMESERVER_JOIN_TIMEOUT_MS", 10_000);
// A host that publishes nothing for this long while another peer waits is
// stalled (frozen/hidden tab, crashed sim, pre-watchdog client) and loses
// authority to that peer. Healthy hosts publish at >=1 Hz, so 15 s is ~15
// missed publishes plus generous bootstrap headroom for the elected successor.
const HOST_STALL_MS = intEnv("GAMESERVER_HOST_STALL_MS", 15_000);
// ARENA (mode "single") worlds survive empty rooms and relay restarts; the
// latest authoritative world.s is snapshotted here. Roomed games stay ephemeral.
const STATE_DIR = env("GAMESERVER_STATE_DIR", path.join(process.cwd(), "data", "relay-state"));
const PERSIST_INTERVAL_MS = intEnv("GAMESERVER_PERSIST_INTERVAL_MS", 1000);
const SHUTDOWN_FLUSH_TIMEOUT_MS = intEnv("GAMESERVER_SHUTDOWN_FLUSH_TIMEOUT_MS", 1000);
const ALLOWED_ORIGINS = env("GAMESERVER_ALLOWED_ORIGINS").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);

type Frame = { t: string; [key: string]: unknown };
type PlayerState = { from: string; cid: string | null; s: unknown; ts: number; pt?: number; pr?: boolean };
type PresenceState = { from: string; cid: string | null; s: unknown; ts: number };
type WorldState = {
  from: string; cid: string | null; s: unknown; ts: number;
  generation: string; epoch: number; seq: number;
};

interface LiveSocket extends WebSocket { isAlive?: boolean }
interface Peer {
  id: string;
  cid: string | null;
  ws: LiveSocket;
  name: string;
  game: string | null;
  room: Room | null;
  limiter: RateLimiter;
}

class RateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private updatedAt = Date.now();
  constructor(perSecond: number, burst: number) {
    this.tokens = burst;
    this.capacity = burst;
    this.refillPerMs = perSecond / 1000;
  }
  allow(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.updatedAt) * this.refillPerMs);
    this.updatedAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

class Room {
  readonly generation = crypto.randomUUID();
  readonly peers = new Map<string, Peer>();
  readonly playerStates = new Map<string, PlayerState>();
  readonly presences = new Map<string, PresenceState>();
  hostId: string | null = null;
  authorityEpoch = 0;
  stateSeq = 0;
  world: WorldState | null = null;
  durableDirty = false;
  lastActivity = Date.now();
  /** When authority last changed; the stall watchdog's grace anchor. */
  authorityGrantedAt = Date.now();
  constructor(readonly key: string, readonly mode: "single" | "rooms") {}
  get publicCode(): string | null { return this.mode === "single" ? null : this.key; }
  touch(): void { this.lastActivity = Date.now(); }
}

/**
 * The on-disk form of one game's persisted ARENA world. Only the latest
 * authoritative world.s is kept: generation/epoch/seq/from/cid belong to the
 * relay session that produced them and must never be reused after a restart.
 */
type DurableWorld = { version: 1; gameId: string; state: unknown; savedAt: number };

/** Latest persisted ARENA world per game; seeded from STATE_DIR at startup. */
const durableWorlds = new Map<string, DurableWorld>();

function stateFile(gameId: string): string { return path.join(STATE_DIR, `${gameId}.json`); }

/** Scan STATE_DIR once at startup; corrupt/foreign files are skipped, not fatal. */
async function loadDurableWorlds(): Promise<void> {
  let names: string[];
  try { names = await fs.readdir(STATE_DIR); }
  catch { return; } // no directory yet: nothing was ever persisted
  for (const name of names) {
    const match = /^([a-z0-9][a-z0-9-]{2,63})\.json$/.exec(name);
    const gameId = match?.[1];
    if (!gameId) continue;
    try {
      const raw = await fs.readFile(path.join(STATE_DIR, name), "utf8");
      const parsed = JSON.parse(raw) as Partial<DurableWorld>;
      if (parsed?.version === 1 && parsed.gameId === gameId
        && typeof parsed.savedAt === "number" && parsed.state !== undefined) {
        durableWorlds.set(parsed.gameId, { version: 1, gameId: parsed.gameId, state: parsed.state, savedAt: parsed.savedAt });
      } else {
        console.warn(`[threadsite-gameserver] durable_state skipped ${name}: unexpected shape`);
      }
    } catch (error) {
      console.warn(`[threadsite-gameserver] durable_state skipped ${name}: ${String((error as Error).message ?? error)}`);
    }
  }
  if (durableWorlds.size) console.log(`[threadsite-gameserver] restored ${durableWorlds.size} durable arena world(s) from ${STATE_DIR}`);
}

/**
 * Serialized per-game write chain: rename-atomic full-file writes, newest
 * last. A state handed here is queued behind any write still in flight and
 * always reaches disk — which is why callers may clear their dirty flag at
 * call time — so a slow write can never silently swallow the newest
 * snapshot. The last-leave and shutdown flushes depend on exactly that.
 */
const durableTails = new Map<string, Promise<void>>();

function persistWorld(gameId: string, state: unknown): Promise<void> {
  const write = (durableTails.get(gameId) ?? Promise.resolve()).then(async () => {
    const durable: DurableWorld = { version: 1, gameId, state, savedAt: Date.now() };
    try {
      await fs.mkdir(STATE_DIR, { recursive: true });
      const final = stateFile(gameId);
      const tmp = `${final}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
      try {
        await fs.writeFile(tmp, JSON.stringify(durable));
        await fs.rename(tmp, final);
      } catch (error) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw error;
      }
      durableWorlds.set(gameId, durable);
    } catch (error) {
      console.warn(`[threadsite-gameserver] durable_state write failed for ${gameId}: ${String((error as Error).message ?? error)}`);
    }
  });
  durableTails.set(gameId, write);
  return write;
}

/** Flush every dirty ARENA room; used by the interval, last-leave, and shutdown. */
function flushDurableRooms(): Promise<unknown>[] {
  const writes: Promise<unknown>[] = [];
  for (const [gameId, rooms] of games) {
    const room = rooms.get(SINGLE_ROOM_KEY);
    if (room?.durableDirty && room.world) {
      room.durableDirty = false;
      writes.push(persistWorld(gameId, room.world.s));
    }
  }
  return writes;
}

/**
 * Seed a fresh ARENA room with the persisted world so the first joiner's
 * welcome carries it. The snapshot is re-stamped with this room's brand-new
 * generation/epoch/seq: frames from before the restart must never validate.
 */
function restoreDurableWorld(room: Room, gameId: string, firstPeer: Peer): void {
  const durable = durableWorlds.get(gameId);
  if (!durable) return;
  room.stateSeq = 1;
  room.world = {
    from: firstPeer.id, cid: firstPeer.cid, s: durable.state, ts: Date.now(),
    generation: room.generation, epoch: room.authorityEpoch, seq: room.stateSeq,
  };
}

const games = new Map<string, Map<string, Room>>();
let nextPeerSeq = 0;
let lastRateWarning = 0;

function send(peer: Peer | undefined, frame: Frame): void {
  if (!peer || peer.ws.readyState !== WebSocket.OPEN) return;
  if (peer.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    // A slow/partitioned consumer must not grow relay memory without bound.
    // Closing is recoverable: the browser client reconnects and receives the
    // newest cached state instead of an obsolete backlog.
    try { peer.ws.close(1013, "slow consumer"); } catch { peer.ws.terminate(); }
    return;
  }
  try { peer.ws.send(JSON.stringify(frame)); } catch { /* close cleanup owns failure */ }
}
function broadcast(room: Room, frame: Frame, exceptPeerId?: string): void {
  for (const peer of room.peers.values()) if (peer.id !== exceptPeerId) send(peer, frame);
}
function errorFrame(code: string, message: string, extra: Record<string, unknown> = {}): Frame {
  return { t: "error", code, message, ...extra };
}
function cleanName(raw: unknown): string {
  return String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32) || "player";
}
function cleanCid(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  return CID_PATTERN.test(value) ? value : null;
}
function makeRoomCode(rooms: Map<string, Room>): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let code = "";
    for (let index = 0; index < 5; index += 1) code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return `Z${Date.now().toString(36).toUpperCase().slice(-6)}`;
}
function worldFrame(world: WorldState | null): Frame | null {
  return world ? { t: "world", ...world } : null;
}
function authorityFrame(room: Room): Frame {
  return {
    t: "authority", host: room.hostId, generation: room.generation,
    epoch: room.authorityEpoch, world: worldFrame(room.world),
  };
}
function setAuthority(room: Room, hostId: string | null): void {
  if (room.hostId === hostId) return;
  room.hostId = hostId;
  room.authorityEpoch += 1;
  room.authorityGrantedAt = Date.now();
  room.touch();
}
function chooseNextHost(room: Room, excluding: string): string | null {
  for (const id of room.peers.keys()) if (id !== excluding) return id;
  return null;
}

function handleJoin(peer: Peer, msg: Frame): void {
  if (msg.v !== PROTOCOL_VERSION) {
    send(peer, errorFrame("bad_version", `Protocol v${String(msg.v ?? "?")} is unsupported; relay requires v${PROTOCOL_VERSION}.`));
    return;
  }
  const gameId = String(msg.game ?? "");
  if (!GAME_ID_PATTERN.test(gameId)) {
    send(peer, errorFrame("bad_game", "join.game must be a lowercase harness game id (3-64 chars)."));
    return;
  }
  const mode = msg.mode === "single" ? "single" : "rooms";
  const wantsCreate = Boolean(msg.create);
  const wantsResume = Boolean(msg.resume);
  const requestedCode = mode === "single" ? "" : String(msg.room ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (mode === "rooms" && requestedCode && !ROOM_CODE_PATTERN.test(requestedCode)) {
    send(peer, errorFrame("bad_room", "Room codes use 4-12 unambiguous uppercase letters/digits."));
    return;
  }

  let rooms = games.get(gameId);
  if (!rooms) { rooms = new Map(); games.set(gameId, rooms); }
  const key = mode === "single" ? SINGLE_ROOM_KEY : requestedCode;
  let room = key ? rooms.get(key) : undefined;
  if (!room && requestedCode && !wantsCreate && !wantsResume && mode === "rooms") {
    send(peer, errorFrame("room_not_found", `No room ${requestedCode} is open.`));
    if (!rooms.size) games.delete(gameId);
    return;
  }
  let created = false;
  if (!room) {
    if (rooms.size >= MAX_ROOMS_PER_GAME) { send(peer, errorFrame("too_many_rooms", "This game has reached its room cap.")); return; }
    const newKey = mode === "single" ? SINGLE_ROOM_KEY : (requestedCode || makeRoomCode(rooms));
    room = new Room(newKey, mode);
    rooms.set(newKey, room);
    created = true;
  } else if (room.peers.size >= MAX_PEERS_PER_ROOM) {
    send(peer, errorFrame("room_full", `Room is full (${MAX_PEERS_PER_ROOM} peers).`));
    return;
  }

  peer.game = gameId;
  peer.room = room;
  peer.name = cleanName(msg.name);
  peer.cid = cleanCid(msg.cid) ?? `cid-${crypto.randomUUID()}`;
  room.peers.set(peer.id, peer);
  room.touch();
  if (room.hostId === null) setAuthority(room, peer.id);
  if (created && room.mode === "single" && !room.world) restoreDurableWorld(room, gameId, peer);

  send(peer, {
    t: "welcome", v: PROTOCOL_VERSION, you: peer.id, cid: peer.cid,
    mode, room: room.publicCode, created, host: room.hostId,
    generation: room.generation, epoch: room.authorityEpoch,
    peers: [...room.peers.values()].filter((other) => other.id !== peer.id).map((other) => ({
      id: other.id, name: other.name, cid: other.cid,
      s: room.playerStates.get(other.id)?.s ?? null,
      ts: room.playerStates.get(other.id)?.ts ?? null,
      pt: room.playerStates.get(other.id)?.pt ?? null,
      pr: room.playerStates.get(other.id)?.pr ?? null,
      presence: room.presences.get(other.id)?.s ?? null,
      presenceTs: room.presences.get(other.id)?.ts ?? null,
    })),
    world: worldFrame(room.world), serverTs: Date.now(),
  });
  broadcast(room, { t: "peer-join", peer: { id: peer.id, name: peer.name, cid: peer.cid } }, peer.id);
}

function handleFrame(peer: Peer, msg: Frame): void {
  const room = peer.room;
  switch (msg.t) {
    case "event": {
      const type = typeof msg.e === "string" ? msg.e.slice(0, 64) : "";
      const id = typeof msg.id === "string" && EVENT_ID_PATTERN.test(msg.id) ? msg.id : "";
      if (!room || !type || !id) { send(peer, errorFrame("bad_event", "event requires room, id and type.")); return; }
      const frame: Frame = { t: "event", id, from: peer.id, cid: peer.cid, e: type, d: msg.d ?? null, ts: Date.now() };
      const targetId = typeof msg.to === "string" ? msg.to : null;
      if (targetId) {
        const resolvedTargetId = targetId === "@host" ? room.hostId : targetId;
        const target = resolvedTargetId ? room.peers.get(resolvedTargetId) : undefined;
        if (target) send(target, frame);
        else send(peer, errorFrame(targetId === "@host" ? "no_host" : "bad_target", targetId === "@host"
          ? "No authoritative host is connected."
          : `Peer ${targetId} is not connected.`, { id }));
      } else broadcast(room, frame, peer.id);
      room.touch();
      return;
    }
    case "world": {
      if (!room) { send(peer, errorFrame("not_joined", "Join before publishing world state.")); return; }
      if (room.hostId !== peer.id) { send(peer, errorFrame("not_host", "Only the current host may publish world state.")); return; }
      if (msg.generation !== room.generation || msg.epoch !== room.authorityEpoch) {
        send(peer, errorFrame("stale_authority", `Expected room generation ${room.generation} authority epoch ${room.authorityEpoch}.`, {
          generation: room.generation, epoch: room.authorityEpoch,
        }));
        return;
      }
      room.stateSeq += 1;
      room.world = {
        from: peer.id, cid: peer.cid, s: msg.s ?? null, ts: Date.now(),
        generation: room.generation, epoch: room.authorityEpoch, seq: room.stateSeq,
      };
      if (room.mode === "single") room.durableDirty = true;
      room.touch();
      send(peer, { t: "world-ack", ...room.world });
      broadcast(room, worldFrame(room.world) as Frame, peer.id);
      return;
    }
    case "pstate": {
      if (!room) { send(peer, errorFrame("not_joined", "Join before publishing player state.")); return; }
      const previousTs = room.playerStates.get(peer.id)?.ts ?? 0;
      const entry: PlayerState = {
        from: peer.id, cid: peer.cid, s: msg.s ?? null,
        ts: Math.max(Date.now(), previousTs + 1),
      };
      if (typeof msg.pt === "number" && Number.isFinite(msg.pt)) entry.pt = msg.pt;
      if (msg.pr === true) entry.pr = true;
      room.playerStates.set(peer.id, entry);
      room.touch();
      broadcast(room, { t: "pstate", ...entry }, peer.id);
      return;
    }
    case "presence": {
      if (!room) { send(peer, errorFrame("not_joined", "Join before publishing presence.")); return; }
      const entry: PresenceState = { from: peer.id, cid: peer.cid, s: msg.s ?? null, ts: Date.now() };
      room.presences.set(peer.id, entry);
      room.touch();
      broadcast(room, { t: "presence", ...entry }, peer.id);
      return;
    }
    case "signal": {
      const type = typeof msg.e === "string" ? msg.e.slice(0, 64) : "";
      if (!room || !type) { send(peer, errorFrame("bad_signal", "signal requires room and type.")); return; }
      const frame: Frame = { t: "signal", from: peer.id, cid: peer.cid, e: type, d: msg.d ?? null, ts: Date.now() };
      const targetId = typeof msg.to === "string" ? msg.to : null;
      if (targetId) {
        const target = room.peers.get(targetId);
        if (target) send(target, frame);
      } else broadcast(room, frame, peer.id);
      return;
    }
    case "world-req": {
      if (!room) { send(peer, errorFrame("not_joined", "Join before requesting world state.")); return; }
      if (room.world) send(peer, worldFrame(room.world) as Frame);
      const host = room.hostId ? room.peers.get(room.hostId) : undefined;
      if (host && host.id !== peer.id) send(host, { t: "world-req", from: peer.id, cid: peer.cid });
      return;
    }
    case "yield-host": {
      if (!room) { send(peer, errorFrame("not_joined", "Join before yielding authority.")); return; }
      if (room.hostId !== peer.id) { send(peer, errorFrame("not_host", "Only the current host may yield authority.")); return; }
      if (msg.generation !== room.generation || msg.epoch !== room.authorityEpoch) {
        send(peer, errorFrame("stale_authority", "Room generation or authority epoch is stale.", {
          generation: room.generation, epoch: room.authorityEpoch,
        }));
        return;
      }
      const nextHost = chooseNextHost(room, peer.id);
      if (!nextHost) return;
      // Put the yielding peer at the back so repeated yields rotate fairly.
      room.peers.delete(peer.id);
      room.peers.set(peer.id, peer);
      setAuthority(room, nextHost);
      broadcast(room, authorityFrame(room));
      return;
    }
    case "ping":
      send(peer, { t: "pong", ts: msg.ts ?? null, serverTs: Date.now() });
      return;
    default:
      send(peer, errorFrame("unknown_frame", `Unsupported frame type '${msg.t}'.`));
  }
}

function statsPayload(): Record<string, unknown> {
  let rooms = 0;
  let clients = 0;
  for (const gameRooms of games.values()) {
    rooms += gameRooms.size;
    for (const room of gameRooms.values()) clients += room.peers.size;
  }
  return { ok: true, protocol: PROTOCOL_VERSION, uptimeSec: Math.floor(process.uptime()), games: games.size, rooms, clients, durableWorlds: durableWorlds.size };
}

const server = http.createServer((req, res) => {
  let pathname = "/";
  try { pathname = new URL(req.url ?? "/", "http://internal").pathname; } catch { /* invalid -> 404 */ }
  if (req.method === "GET" && (pathname === "/health" || pathname === "/stats")) {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(statsPayload()));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("ThreadSite multiplayer relay. WebSocket endpoint: /ws\n");
});

// permessage-deflate with a 1 KB threshold: tiny high-rate frames (25-30 Hz
// transforms, events, pings) skip compression entirely so the hot path pays
// nothing, while repetitive complete-world snapshots (tens of KB, 10-20 Hz,
// nearly identical frame-to-frame) compress hard. Context takeover stays
// enabled — it is where the 5-10x ratio on world snapshots comes from — at a
// bounded ~256 KB per direction per connection. Kill switch for ops rollback.
const DEFLATE_ENABLED = env("GAMESERVER_PERMESSAGE_DEFLATE", "1") !== "0";
const DEFLATE_OPTIONS = {
  threshold: 1024,
  zlibDeflateOptions: { level: zlib.constants.Z_DEFAULT_COMPRESSION },
  concurrencyLimit: 10,
};
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_MESSAGE_BYTES,
  // Browsers negotiate this automatically; clients that don't offer it
  // (including undici-based Node WebSockets) simply stay uncompressed.
  perMessageDeflate: DEFLATE_ENABLED ? DEFLATE_OPTIONS : false,
});
server.on("upgrade", (req, socket, head) => {
  let pathname = "/";
  try { pathname = new URL(req.url ?? "/", "http://internal").pathname; } catch { /* reject below */ }
  if (pathname !== "/ws") { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes("*")) {
    const origin = String(req.headers.origin ?? "").toLowerCase();
    if (!ALLOWED_ORIGINS.includes(origin)) { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (socket: LiveSocket) => {
  socket.isAlive = true;
  const peer: Peer = {
    id: `p-${++nextPeerSeq}`, cid: null, ws: socket, name: "player", game: null, room: null,
    limiter: new RateLimiter(RATE_PER_SECOND, RATE_BURST),
  };
  const joinTimer = setTimeout(() => { if (!peer.room) socket.close(4000, "join timeout"); }, JOIN_TIMEOUT_MS);
  socket.on("pong", () => { socket.isAlive = true; });
  socket.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) { send(peer, errorFrame("bad_frame", "Binary frames are unsupported.")); return; }
    let msg: Frame;
    try { msg = JSON.parse(data.toString("utf8")) as Frame; }
    catch { send(peer, errorFrame("bad_frame", "Frames must be JSON objects.")); return; }
    if (!msg || typeof msg !== "object" || typeof msg.t !== "string") { send(peer, errorFrame("bad_frame", "Frames need a string t.")); return; }
    if (msg.t === "join") {
      if (peer.room) send(peer, errorFrame("already_joined", "Connection already joined."));
      else { handleJoin(peer, msg); if (peer.room) clearTimeout(joinTimer); }
      return;
    }
    if (!peer.limiter.allow()) {
      const now = Date.now();
      if (now - lastRateWarning > 1000) { lastRateWarning = now; console.warn(`[threadsite-gameserver] rate_limited peer=${peer.id}`); }
      send(peer, errorFrame("rate_limited", "Frame rate exceeded; slow down.", { id: typeof msg.id === "string" ? msg.id : null }));
      return;
    }
    handleFrame(peer, msg);
  });
  socket.on("close", () => {
    clearTimeout(joinTimer);
    const room = peer.room;
    if (!room || !peer.game) return;
    const wasHost = room.hostId === peer.id;
    room.peers.delete(peer.id);
    room.playerStates.delete(peer.id);
    room.presences.delete(peer.id);
    room.touch();
    broadcast(room, { t: "peer-leave", id: peer.id, cid: peer.cid });
    if (wasHost) {
      setAuthority(room, room.peers.keys().next().value ?? null);
      broadcast(room, authorityFrame(room));
    }
    // An ARENA that just emptied keeps its world on disk even if the RAM room
    // is swept or the relay dies before the next interval flush.
    if (room.mode === "single" && !room.peers.size && room.durableDirty && room.world) {
      room.durableDirty = false;
      void persistWorld(peer.game, room.world.s);
    }
  });
  socket.on("error", () => undefined);
});

const heartbeat = setInterval(() => {
  for (const socket of wss.clients as Set<LiveSocket>) {
    if (socket.isAlive === false) socket.terminate();
    else { socket.isAlive = false; socket.ping(); }
  }
}, 30_000);
heartbeat.unref();

const sweeper = setInterval(() => {
  for (const [gameId, rooms] of games) {
    for (const [key, room] of rooms) if (!room.peers.size && Date.now() - room.lastActivity >= ROOM_TTL_MS) rooms.delete(key);
    if (!rooms.size) games.delete(gameId);
  }
}, 30_000);
sweeper.unref();

// Sockets stay alive when a host tab freezes: browsers answer WebSocket pings
// without waking throttled JS, and pre-watchdog clients never yield, so a
// silent host would hold authority forever and every joiner would restore a
// frozen world that never advances. The relay can't see game state, but it
// sees publications: a host silent past HOST_STALL_MS while another peer waits
// is demoted to guest and authority moves to that peer. The authority
// broadcast carries the cached world, so the successor restores and resumes,
// and the demoted peer's next publish fails `stale_authority`. A lone stalled
// host is left alone (nobody is waiting; churn would help no one).
const hostWatchdog = setInterval(() => {
  const now = Date.now();
  for (const [gameId, rooms] of games) {
    for (const room of rooms.values()) {
      const hostId = room.hostId;
      if (!hostId || room.peers.size < 2) continue;
      const lastProgress = Math.max(room.authorityGrantedAt, room.world?.ts ?? 0);
      if (now - lastProgress < HOST_STALL_MS) continue;
      const nextHost = chooseNextHost(room, hostId);
      if (!nextHost) continue;
      // Rotate the stalled host behind its successor so repeated stalls spread
      // authority fairly instead of ping-ponging between two frozen tabs.
      const stalled = room.peers.get(hostId);
      if (stalled) {
        room.peers.delete(hostId);
        room.peers.set(hostId, stalled);
      }
      setAuthority(room, nextHost);
      broadcast(room, authorityFrame(room));
      console.warn(`[threadsite-gameserver] host_stalled game=${gameId} room=${room.key} peer=${hostId} silent=${now - lastProgress}ms authority->${nextHost}`);
    }
  }
}, 2_000);
hostWatchdog.unref();

// Hosts publish at 10-20 Hz; disk must not. Coalesce dirty ARENA worlds to one
// atomic write per game per interval. Disk persistence is independent of RAM
// room lifetime: the sweeper may drop the empty room, the file stays.
const durableFlush = setInterval(() => { void Promise.all(flushDurableRooms()); }, PERSIST_INTERVAL_MS);
durableFlush.unref();

await loadDurableWorlds();
server.listen(PORT, HOST, () => {
  console.log(`[threadsite-gameserver] listening on ${HOST}:${PORT} (protocol v${PROTOCOL_VERSION}, /ws)`);
  console.log(`[threadsite-gameserver] durable arena worlds -> ${STATE_DIR} every ${PERSIST_INTERVAL_MS}ms`);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // Flush dirty ARENA worlds before tearing anything down; bounded so a hung
  // disk still exits (the interval already kept on-disk state at most one
  // interval stale).
  await Promise.race([
    Promise.allSettled(flushDurableRooms()),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS).unref()),
  ]);
  const bye = { t: "bye", reason: "shutdown" };
  for (const rooms of games.values()) for (const room of rooms.values()) broadcast(room, bye);
  for (const socket of wss.clients) socket.close(1001, "server shutdown");
  server.close(() => process.exit(0));
  // Idle keep-alive HTTP connections (health checks) would otherwise keep
  // server.close() pending forever; drop them, and keep the exit fallback
  // reffed so nothing else can strand a draining process either.
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
