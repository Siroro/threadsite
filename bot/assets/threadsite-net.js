// ThreadSite Multiplayer Protocol v3 — browser client.
//
// Harness-provided library, regenerated every turn. Treat it as a dependency:
// import it from your own game modules, wrap it, extend it — but do not edit or
// delete this file. Pair it with the harness-owned `net-config.js` next to it:
//
//   import { NET_CONFIG } from "./net-config.js";
//   import { ThreadSiteNet } from "./threadsite-net.js";
//
//   const net = await ThreadSiteNet.connect({
//     ...NET_CONFIG,
//     room: "AB3CK",            // or createRoom: true to host a fresh room
//     // mode: "single",         // single-server game: everyone joins one shared
//     //                          // arena; skip room codes and lobbies entirely
//     name: "Capy23",
//     onPeers: (peers) => refreshLobby(peers),
//     onPlayerState: (ps) => updateRemotePlayer(ps),   // {from, cid, state, ts}
//     onEvent: (ev) => applyRemoteEvent(ev),           // {from, cid, type, data, seq}
//     onState: (snap) => applySharedWorld(snap.state),
//     onHostChange: (hostId, isHost) => setLocalAuthority(isHost),
//     onStatus: (status, detail) => showNetStatus(status),
//   });
//
// `connect()` resolves once the room is joined. If the relay is unreachable it
// rejects after `connectTimeoutMs` (default 10s) — catch that and keep the game
// playable solo; when `autoReconnect` is on (default) the client keeps retrying
// in the background and fires onStatus("reconnecting"/"online") if it comes up.
//
// ## Sync guarantees built into this client (v3)
//
// - **Two-level identity.** Every live connection has a unique peer id used
//   for routing and active avatars. `cid` is tab-session continuity metadata
//   (kept in sessionStorage) so reconnects/reloads in the same tab can reattach
//   persistent player data without collapsing simultaneous tabs.
// - **Throttled player-state publishing.** `publishPlayerState()` coalesces to
//   `pstateHz` (default 15 Hz, newest state wins) so the game loop can call it
//   every render frame without flooding the relay's rate limiter. Call
//   `net.flushPlayerState()` to push important changes immediately. Player and
//   world state are NEVER queued while offline: after a reconnect they would
//   be stale snapshots rubber-banding peers and burning rate-limit budget.
//   Only sequenced application events (send/sendTo) queue through a drop.
// - **Sequenced events.** Every `send()`/`sendTo()` event is stamped with a
//   monotonic `seq` (event id) the receiver can dedupe by. WebSocket delivery
//   is ordered per connection, so no automatic gap-resend exists — if the
//   relay rate-limits one of your events, the exact event is requeued once and
//   re-delivered marked as a retry (`r: 1`) so handlers stay idempotent by seq.
//   Counters: `net.dropped` (out-of-order arrivals), `net.duplicates`
//   (re-deliveries suppressed).
// - **Offline outbox.** Event frames sent while the socket is down (up to 256)
//   are queued and flushed on reconnect in order, so events fired during a blip
//   still arrive.
// - **Frame-size guard.** Oversized frames throw `frame_too_large` locally
//   instead of silently killing the connection at the relay.
// - **Staleness tracking.** `net.peerLastSeen(id)` / `net.isStale(id, ms)` tell
//   you how fresh a peer's last update is, so you can grey out or drop frozen
//   avatars; `onPlayerState` payloads carry the relay's receive timestamp `ts`.
// - **Server clock.** `net.serverNow()` approximates the relay's clock: seeded
//   immediately from the welcome frame's `serverTs` and refined on every
//   ping/pong. `net.rtt` holds the round-trip time.
//
// Which sync model fits your game (player-owned entities vs host-authoritative
// shared worlds), how to interpolate remote players, and the host's
// responsibilities are defined in the project AGENTS.md multiplayer guide —
// it is the authoritative source; this file only documents the transport API.
//
// Invite links: after hosting, build a shareable URL with net.inviteUrl() (the
// current page URL plus "#room=CODE"). On load, pass ThreadSiteNet.roomFromUrl()
// as `room` so visitors auto-join the host's room instead of typing the code.
// Single-server games skip all of this — everyone connects with mode: "single".

export const PROTOCOL_VERSION = 3;

/**
 * @type {{CONNECTING: string, ONLINE: string, RECONNECTING: string, DEGRADED: string, CLOSED: string}}
 */
// The JSDoc type is load-bearing for the publish type-check gate: Object.freeze
// preserves each value's literal type, so authored code copying a constant
// (`let status = NET_STATUS.CONNECTING`) would be pinned to that singleton
// string and fail validation on assigning or comparing another status. Typed
// as plain strings, copies widen to `string` like any other string value.
export const NET_STATUS = Object.freeze({
  CONNECTING: "connecting",
  ONLINE: "online",
  RECONNECTING: "reconnecting",
  DEGRADED: "degraded",
  CLOSED: "closed",
});

// Keep comfortably under the relay's default 64 KiB max frame size.
const MAX_FRAME_BYTES = 60 * 1024;
const RECENT_EVENTS = 128; // events remembered for rate-limit requeue
const RECENT_APPLIED = 256; // applied event ids remembered per peer for dedupe
const OUTBOX_LIMIT = 256; // event frames queued while offline
const PSTATE_HZ_DEFAULT = 15;

export class ThreadSiteNetError extends Error {
  constructor(message, code = "error", cause) {
    super(message);
    this.name = "ThreadSiteNetError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function normalizeUrl(url) {
  const value = String(url ?? "").trim();
  if (!value) throw new ThreadSiteNetError("A relay URL is required (NET_CONFIG.url).", "bad_config");
  // Serving from HTTPS while configured with ws:// would be blocked by the
  // browser, so upgrade the scheme automatically.
  if (typeof location !== "undefined" && location.protocol === "https:" && value.startsWith("ws://")) {
    return `wss://${value.slice("ws://".length)}`;
  }
  return value;
}

const CID_STORAGE_KEY = "threadsite-session-cid";

function loadCid() {
  try {
    const storage = typeof sessionStorage !== "undefined" ? sessionStorage : null;
    const existing = storage?.getItem(CID_STORAGE_KEY);
    if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
    const fresh = `c-${crypto.randomUUID().replace(/-/g, "")}`;
    storage?.setItem(CID_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    // Storage unavailable: still send a unique id for this page instance.
    try { return `c-${crypto.randomUUID().replace(/-/g, "")}`; } catch { return null; }
  }
}

const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

function byteLength(str) {
  if (textEncoder) return textEncoder.encode(str).length;
  return str.length; // close enough as a fallback guard
}

export class ThreadSiteNet {
  /**
   * Room code from the current page URL's "#room=CODE" fragment, or null when
   * the URL carries none. Use it at startup so invite links auto-join the room:
   *
   *   const net = await ThreadSiteNet.connect({
   *     ...NET_CONFIG,
   *     room: ThreadSiteNet.roomFromUrl(),   // null is fine: falls back to hosting
   *     createRoom: !ThreadSiteNet.roomFromUrl(),
   *     name: playerName,
   *   });
   */
  static roomFromUrl() {
    if (typeof location === "undefined") return null;
    const match = /[#&]room=([A-Za-z0-9]{4,12})/.exec(location.hash || "");
    return match ? match[1].toUpperCase() : null;
  }

  /**
   * @typedef {object} ThreadSiteNetOptions
   * @property {string} [game]               Tenant id — pass NET_CONFIG.game unchanged.
   * @property {string} [url]                Relay WebSocket URL — pass NET_CONFIG.url.
   * @property {"single"|"rooms"} [mode]     "single": one shared arena, no room codes.
   * @property {string} [room]               Room code to join, e.g. ThreadSiteNet.roomFromUrl().
   * @property {boolean} [createRoom]        True to host a new room; code lands in net.room.
   * @property {string} [name]               Display name for this peer (max ~32 chars).
   * @property {boolean} [autoReconnect]     Default true: retry with backoff after drops.
   * @property {number} [connectTimeoutMs]   Default 10000.
   * @property {number} [pstateHz]           publishPlayerState coalescing rate 1-60, default 15.
   * @property {(status: string, detail?: any) => any} [onStatus]
   * @property {(peers: any[]) => any} [onPeers]
   * @property {(playerState: any) => any} [onPlayerState]
   * @property {(event: any) => any} [onEvent]
   * @property {(snapshot: any) => any} [onState]
   * @property {(hostId: string, isHost: boolean) => any} [onHostChange]
   * @property {(from: string) => any} [onStateRequest]
   */

  /**
   * Connect to the shared relay and join a room.
   *
   * opts (all optional except game/url, usually spread from NET_CONFIG):
   *   game, url, protocol   — from NET_CONFIG; do not hardcode your own values.
   *   mode                  — "single": everyone joins this game's one shared
   *                           arena (no room codes, no lobby needed). Default
   *                           (or "rooms"): code-addressed rooms.
   *   room                  — room code to join ("AB3CK"), e.g. from an invite
   *                           link (ThreadSiteNet.roomFromUrl()). Mutually
   *                           exclusive with createRoom and with mode "single".
   *   createRoom            — true to host a new room; find the code in net.room.
   *   name                  — display name for this peer (max ~32 chars).
   *   pstateHz              — publishPlayerState coalescing rate, 1-60
   *                           (default 15). The game loop may call it per frame.
   *   autoReconnect         — default true: keep retrying with backoff after drops.
   *   connectTimeoutMs      — default 10000: how long connect() waits before rejecting.
   *   onStatus(status, detail), onPeers(peers), onEvent({from, cid, type, data, seq}),
   *   onState({from, state}), onHostChange(hostId, isHost), onStateRequest(from)
   *
   * @param {ThreadSiteNetOptions} [opts]
   */
  static connect(opts = {}) {
    const net = new ThreadSiteNet(opts);
    return net.opened;
  }

  /**
   * Usually created via ThreadSiteNet.connect(); the options are identical.
   *
   * @param {ThreadSiteNetOptions} [opts]
   */
  constructor(opts = {}) {
    if (!opts || typeof opts !== "object") throw new ThreadSiteNetError("connect options object required.", "bad_config");
    const game = String(opts.game ?? "").trim();
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(game)) {
      throw new ThreadSiteNetError(`Invalid game id '${game}' — use NET_CONFIG.game unchanged.`, "bad_config");
    }
    this.game = game;
    this.url = normalizeUrl(opts.url);
    this.mode = String(opts.mode ?? "rooms").toLowerCase() === "single" ? "single" : "rooms";
    this.requestedRoom = this.mode === "single"
      ? ""
      : (opts.room ? String(opts.room).toUpperCase().replace(/[^A-Z0-9]/g, "") : "");
    this.createRoom = this.mode === "single" ? false : Boolean(opts.createRoom);
    this.name = String(opts.name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32) || "player";
    this.autoReconnect = opts.autoReconnect !== false;
    this.connectTimeoutMs = Math.max(1000, Number(opts.connectTimeoutMs) || 10_000);
    const pstateHz = Number(opts.pstateHz) || PSTATE_HZ_DEFAULT;
    this._pstateIntervalMs = Math.max(Math.round(1000 / 60), Math.min(Math.round(1000 / 1), Math.round(1000 / pstateHz)));

    // Callbacks are plain mutable properties, so games can also reassign e.g.
    // `net.onEvent = fn` after connecting.
    this.onStatus = opts.onStatus ?? null;
    this.onPeers = opts.onPeers ?? null;
    this.onPlayerState = opts.onPlayerState ?? null;
    this.onEvent = opts.onEvent ?? null;
    this.onState = opts.onState ?? null;
    this.onHostChange = opts.onHostChange ?? null;
    this.onStateRequest = opts.onStateRequest ?? null;

    this.id = null;
    this.cid = loadCid();
    this.room = null;
    this.hostId = null;
    this.rtt = null;
    this.serverTimeOffset = null; // relay clock minus local clock, ms
    // Sync health counters, all monotonic for this client instance.
    this.dropped = 0; // events that arrived out of order (older than one seen)
    this.duplicates = 0; // re-deliveries suppressed by seq dedupe
    this.rateLimited = 0; // frames the relay rejected for exceeding its rate

    this._peers = new Map();
    this._peerStates = new Map(); // peerId -> newest live state; cid is reconnect metadata
    this._peerLastSeen = new Map(); // peerId -> epoch ms of newest inbound frame
    this._lastSeqByPeer = new Map(); // peerId -> newest event seq seen (for stats)
    this._appliedSeqsByPeer = new Map(); // peerId -> Set of applied event ids (dedupe)
    this._recentEvents = []; // [{seq, e, d}] ring of recently sent events
    this._outbox = []; // event frames queued while the socket is down
    this._seq = 0;
    this._pendingPstate = null;
    this._pstateTimer = 0;
    this._ws = null;
    this._status = NET_STATUS.CONNECTING;
    this._attempt = 0;
    this._reconnectTimer = 0;
    this._heartbeatTimer = 0;
    this._lastPingTs = 0;
    this._manuallyClosed = false;
    this.openedSettled = false;

    this.opened = new Promise((resolve, reject) => {
      this._resolveOpened = resolve;
      this._rejectOpened = (error) => {
        error.net = this;
        reject(error);
      };
    });
    this.opened.catch(() => undefined); // avoid unhandled rejection for awaited-later callers

    this._connect();
  }

  get status() {
    return this._status;
  }

  /** Other peers in the room: [{ id, name, cid }], excluding yourself. */
  get peers() {
    return [...this._peers.values()];
  }

  /**
   * Every currently connected peer's newest self-published state. Live
   * entries are keyed by peer id so simultaneous tabs never collapse.
   */
  get playerStates() {
    return [...this._peerStates.entries()].map(([id, state]) => {
      const peer = this._peers.get(id);
      return { cid: peer?.cid ?? null, id, state };
    });
  }

  get isHost() {
    return this.id !== null && this.hostId === this.id;
  }

  /** Peer record (or undefined) for a stable client id. */
  peerByCid(cid) {
    for (const peer of this._peers.values()) {
      if (peer.cid === cid) return peer;
    }
    return undefined;
  }

  /**
   * Epoch-ms timestamp of the newest inbound frame from a peer (null when
   * unknown). Use with isStale() to grey out frozen avatars.
   */
  peerLastSeen(peerId) {
    return this._peerLastSeen.get(peerId) ?? null;
  }

  /** True when a peer's newest update is older than maxAgeMs (default 5s). */
  isStale(peerId, maxAgeMs = 5000) {
    const lastSeen = this._peerLastSeen.get(peerId);
    return lastSeen === undefined || Date.now() - lastSeen > maxAgeMs;
  }

  /** Newest event sequence number received from a peer (null when none). */
  lastSeqFrom(peerId) {
    return this._lastSeqByPeer.get(peerId) ?? null;
  }

  /**
   * Best estimate of the relay's current time (epoch ms), or the local clock
   * before the first welcome. Seeded from the welcome's serverTs and refined
   * on every ping/pong. Use for shared timers so every client agrees on
   * "when" without syncing their own clocks.
   */
  serverNow() {
    return Date.now() + (this.serverTimeOffset ?? 0);
  }

  /**
   * Total queued-but-undelivered event frames while offline (events you called
   * send()/sendTo() for during a drop; they flush automatically on reconnect).
   * Player/world state frames are never queued — they are transient and the
   * newest one republishes itself.
   */
  get queued() {
    return this._outbox.length;
  }

  /**
   * Shareable invite URL for the current room: the page's own URL with the
   * room code in the hash ("...#room=AB3CK"). Recipients auto-join when the
   * game passes ThreadSiteNet.roomFromUrl() as `room` at startup. Returns
   * null when there is no page URL (non-browser context) or no room yet.
   */
  inviteUrl() {
    if (typeof location === "undefined" || !this.room) return null;
    const base = `${location.origin}${location.pathname}${location.search}`;
    return `${base}#room=${this.room}`;
  }

  /**
   * Broadcast an application event to the rest of the room. Fire-and-forget
   * from your code's perspective: the library stamps a sequence number (event
   * id receivers dedupe by), remembers the event in case the relay
   * rate-limits it and it must be requeued, and queues it through brief
   * disconnects (bounded outbox).
   */
  send(type, data) {
    this._sendSequenced(String(type), data ?? null, null);
  }

  /**
   * Send an application event to one peer only (e.g. a direct hit or a
   * question to the host). Same sequencing/retry guarantees as send().
   */
  sendTo(peerId, type, data) {
    this._sendSequenced(String(type), data ?? null, String(peerId));
  }

  /**
   * Publish an authoritative room snapshot. The relay stores the newest one
   * (stamped with its receive time) and hands it to late joiners and
   * reconnecting clients, so hosts should call this regularly (8-15 Hz) and
   * include a monotonically increasing tick. Receivers can discard snapshots
   * whose ts is older than the newest they have seen from the same source.
   * Never queued while offline: a delayed snapshot would be stale on arrival —
   * the next tick publishes a fresher one instead.
   */
  publishState(state) {
    this._send({ t: "state", s: state ?? null }, { transient: true });
  }

  /**
   * Self-published player state: broadcast YOUR OWN responsive local state. Coalesced to
   * `pstateHz` (default 15 Hz) — safe to call every render frame; the newest
   * state always wins. No host round trip — controls stay local. Never queued
   * while offline: replaying a stale transform after reconnect would
   * rubber-band the player; the local simulation keeps running and the next
   * flush carries the current transform.
   */
  publishPlayerState(state) {
    this._pendingPstate = state ?? null;
    if (this._pstateTimer) return;
    this._pstateTimer = setInterval(() => this._flushPstate(), this._pstateIntervalMs);
  }

  /** Immediately push the pending player state (e.g. after a teleport). */
  flushPlayerState() {
    if (this._pendingPstate !== null) this._flushPstate();
  }

  /** Newest self-published state of one live peer id or cid (or undefined). */
  peerState(peerIdOrCid) {
    if (this._peerStates.has(peerIdOrCid)) return this._peerStates.get(peerIdOrCid);
    const peer = this.peerByCid(peerIdOrCid);
    return peer ? this._peerStates.get(peer.id) : undefined;
  }

  /** Ask the current host for a fresh snapshot (fires onState when it replies). */
  requestState() {
    this._send({ t: "state-req" }, { transient: true });
  }

  /** Measure round-trip time; the latest value is always available as net.rtt. */
  ping() {
    this._lastPingTs = Date.now();
    this._send({ t: "ping", ts: this._lastPingTs }, { transient: true });
  }

  /** Leave the room and stop reconnecting. The socket cannot be reused afterwards. */
  close() {
    this._manuallyClosed = true;
    this.flushPlayerState();
    clearTimeout(this._reconnectTimer);
    clearInterval(this._heartbeatTimer);
    if (this._pstateTimer) {
      clearInterval(this._pstateTimer);
      this._pstateTimer = 0;
    }
    if (this._ws) {
      try {
        this._ws.close(1000, "client left");
      } catch {
        // already closing
      }
    }
    this._setStatus(NET_STATUS.CLOSED);
  }

  // ---- internals -----------------------------------------------------------

  _sendSequenced(type, data, to) {
    this._seq += 1;
    const seq = this._seq;
    // Ring buffer exists for the rate-limit requeue path: if the relay drops a
    // frame, its echoed seq identifies the exact event to resend (r: 1).
    this._recentEvents.push({ seq, e: type, d: data, to });
    while (this._recentEvents.length > RECENT_EVENTS) this._recentEvents.shift();
    const frame = { t: "event", e: type, d: data, seq };
    if (to !== null) frame.to = to;
    this._send(frame);
  }

  _flushPstate() {
    if (this._pendingPstate === null) return;
    const state = this._pendingPstate;
    this._pendingPstate = null;
    this._send({ t: "pstate", s: state }, { transient: true });
  }

  // options.transient marks state-like frames (pstate/state/ping): while the
  // socket is down they are dropped, not queued — only reliable sequenced
  // events outlive a disconnect, and the newest state republishes itself.
  _send(frame, options = {}) {
    if (this._ws === null || this._ws.readyState !== 1) {
      if (options.transient) return;
      // Offline: queue (bounded, in order) and flush after the next welcome.
      // Note this never swallows the join frame itself — that is sent from
      // ws.onopen, when the socket is freshly open.
      if (this._outbox.length < OUTBOX_LIMIT) {
        this._outbox.push(frame);
      } else {
        this._outbox.shift();
        this._outbox.push(frame);
      }
      return;
    }
    let payload;
    try {
      payload = JSON.stringify(frame);
    } catch (error) {
      throw new ThreadSiteNetError("Frame is not JSON-serializable.", "bad_frame", error);
    }
    if (byteLength(payload) > MAX_FRAME_BYTES) {
      // Oversized frames would get the socket killed by the relay (close 1009)
      // with no application-visible error — fail loudly here instead.
      throw new ThreadSiteNetError(
        `Frame is ${byteLength(payload)} bytes; keep frames under ~${MAX_FRAME_BYTES} (send compact deltas, never asset data).`,
        "frame_too_large",
      );
    }
    try {
      this._ws.send(payload);
    } catch (error) {
      throw new ThreadSiteNetError("Send failed; the connection is closing.", "send_failed", error);
    }
  }

  _setStatus(status, detail) {
    if (this._status === status) return;
    this._status = status;
    if (this.onStatus) {
      try {
        this.onStatus(status, detail ?? null);
      } catch (error) {
        console.error("[threadsite-net] onStatus handler failed:", error);
      }
    }
  }

  _connect() {
    if (this._manuallyClosed) return;
    this._setStatus(this._attempt === 0 ? NET_STATUS.CONNECTING : NET_STATUS.RECONNECTING);
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (error) {
      this._failOrRetry(new ThreadSiteNetError(`Could not open ${this.url}.`, "bad_url", error));
      return;
    }
    this._ws = ws;

    const failTimer = setTimeout(() => {
      if (ws.readyState !== 1) {
        try {
          ws.close();
        } catch {
          // ignore
        }
        this._failOrRetry(new ThreadSiteNetError(`Relay at ${this.url} did not answer in time.`, "connect_timeout"));
      }
    }, this.connectTimeoutMs);

    ws.onopen = () => {
      this._send({
        t: "join",
        v: PROTOCOL_VERSION,
        game: this.game,
        mode: this.mode === "single" ? "single" : null,
        room: this.requestedRoom || null,
        create: this.createRoom || (!this.requestedRoom && this.mode !== "single"),
        name: this.name,
        cid: this.cid,
      });
    };

    ws.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return; // the relay only sends valid JSON; ignore anything else
      }
      if (!frame || typeof frame !== "object") return;
      try {
        this._handleFrame(frame, failTimer);
      } catch (error) {
        console.error("[threadsite-net] handler failed:", error);
      }
    };

    ws.onclose = (event) => {
      clearTimeout(failTimer);
      clearInterval(this._heartbeatTimer);
      const wasOnline = this.id !== null;
      this.id = null;
      this._peers.clear();
      this._ws = null;
      if (this._manuallyClosed) {
        this._setStatus(NET_STATUS.CLOSED);
        return;
      }
      if (!wasOnline) {
        this._failOrRetry(new ThreadSiteNetError(`Relay at ${this.url} refused the connection (${event.code}).`, "connect_failed"));
        return;
      }
      this._setStatus(NET_STATUS.RECONNECTING);
      this._scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose follows with the actionable code; nothing to do here.
    };
  }

  _handleFrame(frame, failTimer) {
    switch (frame.t) {
      case "welcome": {
        const firstJoin = this.id === null;
        this.id = frame.you;
        this.cid = frame.cid ?? this.cid;
        this.room = frame.room;
        this.mode = frame.mode === "single" ? "single" : "rooms";
        // Reconnects rejoin the exact room we were in, rather than hosting a
        // fresh one when the original join used createRoom.
        this.requestedRoom = this.mode === "single" ? "" : frame.room;
        this.createRoom = false;
        this.hostId = frame.host;
        this._peers.clear();
        this._peerStates.clear();
        this._peerLastSeen.clear();
        this._lastSeqByPeer.clear();
        this._appliedSeqsByPeer.clear();
        for (const peer of frame.peers ?? []) {
          this._peers.set(peer.id, { id: peer.id, name: peer.name, cid: peer.cid ?? null });
          if (peer.s !== null && peer.s !== undefined) this._peerStates.set(peer.id, peer.s);
          this._peerLastSeen.set(peer.id, Date.now());
        }
        // Bootstrap the server clock from the welcome immediately — one-way
        // (no RTT to halve yet), so it is accurate to within network latency —
        // then refine with a ping right away instead of waiting for the first
        // 10s heartbeat. serverNow() is usable from the first frame on.
        if (typeof frame.serverTs === "number") {
          this.serverTimeOffset = frame.serverTs - Date.now();
        }
        this.ping();
        clearTimeout(failTimer);
        this._attempt = 0;
        this._setStatus(NET_STATUS.ONLINE);
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = setInterval(() => {
          if (this._ws?.readyState === 1 && this.id !== null) this.ping();
          else clearInterval(this._heartbeatTimer);
        }, 10_000);
        if (firstJoin && !this.openedSettled) {
          this.openedSettled = true;
          this._resolveOpened(this);
        }
        // Both first joins and reconnects resync from the room's newest snapshot.
        if (frame.s && frame.s.s !== null && frame.s.s !== undefined && this.onState) {
          this.onState({ from: frame.s.from, cid: frame.s.cid ?? null, state: frame.s.s, ts: frame.s.ts ?? null });
        }
        // Flush anything queued while we were offline, in order.
        const outbox = this._outbox;
        this._outbox = [];
        for (const queued of outbox) this._send(queued);
        this._emitPeers();
        if (this.onHostChange) this.onHostChange(this.hostId, this.isHost);
        return;
      }
      case "peer-join":
        this.hostId = frame.host ?? this.hostId;
        if (frame.peer) {
          this._peers.set(frame.peer.id, { id: frame.peer.id, name: frame.peer.name, cid: frame.peer.cid ?? null });
          this._peerLastSeen.set(frame.peer.id, Date.now());
        }
        this._emitPeers();
        if (frame.host && this.onHostChange) this.onHostChange(this.hostId, this.isHost);
        return;
      case "peer-leave": {
        this._peers.delete(frame.id);
        this._peerLastSeen.delete(frame.id);
        this._lastSeqByPeer.delete(frame.id);
        this._appliedSeqsByPeer.delete(frame.id);
        this._peerStates.delete(frame.id); // live cache follows live peer ids; cid remains continuity metadata
        const migrated = frame.host !== undefined && frame.host !== this.hostId;
        this.hostId = frame.host ?? null;
        this._emitPeers();
        if (migrated && this.onHostChange) this.onHostChange(this.hostId, this.isHost);
        return;
      }
      case "pstate": {
        const cid = frame.cid ?? null;
        this._peerStates.set(frame.from, frame.s);
        this._touchPeer(frame.from);
        if (this.onPlayerState) {
          this.onPlayerState({ from: frame.from, cid, state: frame.s, ts: frame.ts ?? null });
        }
        return;
      }
      case "event":
        this._receiveSequenced(frame);
        return;
      case "state":
        if (this.onState) this.onState({ from: frame.from, cid: frame.cid ?? null, state: frame.s, ts: frame.ts ?? null });
        return;
      case "state-req":
        if (this.onStateRequest) this.onStateRequest(frame.from);
        return;
      case "pong":
        if (typeof frame.ts === "number" && frame.ts === this._lastPingTs) {
          this.rtt = Date.now() - frame.ts;
          if (typeof frame.sts === "number") {
            // Offset so serverNow() ≈ the relay's clock; halve RTT for one-way.
            this.serverTimeOffset = frame.sts + this.rtt / 2 - Date.now();
          }
        }
        return;
      case "error": {
        const error = new ThreadSiteNetError(frame.message || "Relay rejected a frame.", frame.code || "error");
        if (frame.code === "room_not_found") {
          // The room is gone (expired or never existed). Retrying cannot fix
          // this, so surface it to the game instead of looping forever.
          if (this.id === null && !this.openedSettled) {
            this.openedSettled = true;
            this._rejectOpened(error);
          } else {
            console.warn("[threadsite-net]", error.code, error.message);
          }
          this._manuallyClosed = true;
          clearTimeout(this._reconnectTimer);
          clearInterval(this._heartbeatTimer);
          if (this._ws) {
            try {
              this._ws.close(4000, "room gone");
            } catch {
              // already closing
            }
          }
          this._setStatus(NET_STATUS.CLOSED, "room_not_found");
          return;
        }
        if (frame.code === "rate_limited") {
          this.rateLimited += 1;
          this._setStatus(NET_STATUS.DEGRADED, "rate_limited");
          this._setStatus(NET_STATUS.ONLINE); // back to online on the next frame
          // If the relay echoed the dropped frame's seq, requeue that exact
          // event once so rate limiting cannot silently eat game events.
          if (typeof frame.seq === "number") this._requeueBySeq(frame.seq);
          return;
        }
        if (frame.code === "bad_version") {
          // Fatal mismatch: the relay speaks a different protocol version.
          if (this.id === null && !this.openedSettled) {
            this.openedSettled = true;
            this._rejectOpened(error);
          } else {
            console.error("[threadsite-net]", error.code, error.message);
          }
          this._manuallyClosed = true;
          this._setStatus(NET_STATUS.CLOSED, "bad_version");
          return;
        }
        if (this.id === null) this._failOrRetry(error);
        else console.warn("[threadsite-net]", error.code, error.message);
        return;
      }
      case "bye":
        console.info("[threadsite-net] relay said bye:", frame.reason ?? "shutdown");
        return;
      default:
        return;
    }
  }

  _touchPeer(peerId) {
    this._peerLastSeen.set(peerId, Date.now());
  }

  _receiveSequenced(frame) {
    const peerId = frame.from;
    this._touchPeer(peerId);
    const seq = typeof frame.seq === "number" ? frame.seq : null;
    if (seq !== null) {
      // WebSocket delivery is ordered per connection and the relay never
      // reorders per sender, so there is no gap detection or resend: seq is an
      // event id. Applied ids are remembered (bounded) so a retried event —
      // e.g. one the relay rate-limited and the sender requeued — is delivered
      // exactly once, and a re-delivery of an already-applied id never
      // double-applies. A retry can legitimately arrive AFTER newer seqs.
      const applied = this._appliedSeqsByPeer.get(peerId);
      if (applied !== undefined && applied.has(seq)) {
        this.duplicates += 1;
        return;
      }
      this._rememberAppliedSeq(peerId, seq, applied);
      if (seq <= (this._lastSeqByPeer.get(peerId) ?? -Infinity)) this.dropped += 1; // late arrival
      else this._lastSeqByPeer.set(peerId, seq);
    }
    if (this.onEvent) {
      this.onEvent({ from: peerId, cid: frame.cid ?? null, type: frame.e, data: frame.d, seq, ts: frame.ts ?? null });
    }
  }

  _rememberAppliedSeq(peerId, seq, applied) {
    const set = applied ?? new Set();
    if (applied === undefined) this._appliedSeqsByPeer.set(peerId, set);
    set.add(seq);
    if (set.size <= RECENT_APPLIED) return;
    // Bound the bookkeeping: senders only retry recent seqs, so anything far
    // behind the newest id is gone for good.
    let newest = 0;
    for (const value of set) newest = Math.max(newest, value);
    for (const value of set) {
      if (value <= newest - Math.floor(RECENT_APPLIED / 2)) set.delete(value);
    }
  }

  _requeueBySeq(seq) {
    const event = this._recentEvents.find((candidate) => candidate.seq === seq);
    if (!event) return;
    // Requeue the exact original event (same audience, marked r:1 so the
    // receiver treats it as a retry and dedupes by seq).
    const resend = { t: "event", e: event.e, d: event.d, seq: event.seq, r: 1 };
    if (event.to !== null && event.to !== undefined) resend.to = event.to;
    setTimeout(() => {
      try {
        this._send(resend);
      } catch {
        // connection gone; the outbox path in _send handles it
      }
    }, 250);
  }

  _emitPeers() {
    if (this.onPeers) this.onPeers(this.peers);
  }

  _failOrRetry(error) {
    if (this.id === null && !this.openedSettled) {
      this.openedSettled = true;
      this._rejectOpened(error);
    }
    if (this._manuallyClosed) return;
    if (this.autoReconnect) {
      this._setStatus(NET_STATUS.RECONNECTING, error.code);
      this._scheduleReconnect();
    } else {
      this._setStatus(NET_STATUS.CLOSED, error.code);
    }
  }

  _scheduleReconnect() {
    if (this._manuallyClosed || this._reconnectTimer) return;
    this._attempt += 1;
    const backoff = Math.min(8000, 500 * 2 ** Math.min(this._attempt, 4));
    const delay = backoff * (0.7 + Math.random() * 0.6);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = 0;
      this._connect();
    }, delay);
  }
}
