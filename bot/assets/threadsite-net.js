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
// - **Stable identity.** Every connection carries a persistent client id
//   (`cid`, kept in localStorage) that survives reconnects, so peers can keep
//   your avatar, score, and history attached to YOU across drops. Key game
//   state by `cid` (available as `net.cid`, on peers, and on every callback
//   payload) — never by the per-connection peer id.
// - **Throttled player-state publishing.** `publishPlayerState()` coalesces to
//   `pstateHz` (default 15 Hz, newest state wins) so the game loop can call it
//   every render frame without flooding the relay's rate limiter. Call
//   `net.flushPlayerState()` to push important changes immediately.
// - **Sequenced events with gap recovery.** Every `send()`/`sendTo()` event is
//   stamped with a monotonic `seq`. The library keeps a recent-send buffer,
//   detects sequence gaps in what it receives, asks the sender to re-transmit
//   the missing events (`resend-req`), and answers such requests itself.
//   Counters: `net.dropped` (gap-detected events), `net.resent` (recovered),
//   `net.duplicates` (out-of-order re-deliveries).
// - **Offline outbox.** Frames sent while the socket is down (up to 256) are
//   queued and flushed on reconnect in order, so events fired during a blip
//   still arrive.
// - **Frame-size guard.** Oversized frames throw `frame_too_large` locally
//   instead of silently killing the connection at the relay.
// - **Staleness tracking.** `net.peerLastSeen(id)` / `net.isStale(id, ms)` tell
//   you how fresh a peer's last update is, so you can grey out or drop frozen
//   avatars; `onPlayerState` payloads carry the relay's receive timestamp `ts`.
// - **Server clock.** `net.serverNow()` approximates the relay's clock (from
//   ping/pong offset) for shared timers; `net.rtt` holds the round-trip time.
//
// Recommended sync model for casual games (see the project AGENTS.md guide):
// every player owns and simulates their OWN entity, so controls never travel
// through another player's machine. Call net.publishPlayerState({ x, y, vx, vy,
// anim, ... }) from your game loop (it throttles internally), render other
// players from their newest player state (interpolating between the last two
// updates), and affect other players by sending them events ("I hit you") that
// their own client applies. Shared-world state (ball, NPCs) can live in
// net.publishState snapshots, or be owned by the spawning peer. The room's
// oldest peer is the "host" — that only matters if you give it shared-world
// ownership; losing it never affects anyone's controls (onHostChange reports
// migrations).
//
// Invite links: after hosting, build a shareable URL with net.inviteUrl() (the
// current page URL plus "#room=CODE"). On load, pass ThreadSiteNet.roomFromUrl()
// as `room` so visitors auto-join the host's room instead of typing the code.
// Single-server games skip all of this — everyone connects with mode: "single".

export const PROTOCOL_VERSION = 3;

export const NET_STATUS = Object.freeze({
  CONNECTING: "connecting",
  ONLINE: "online",
  RECONNECTING: "reconnecting",
  DEGRADED: "degraded",
  CLOSED: "closed",
});

// Keep comfortably under the relay's default 64 KiB max frame size.
const MAX_FRAME_BYTES = 60 * 1024;
const RECENT_EVENTS = 128; // events remembered for resend requests
const OUTBOX_LIMIT = 256; // frames queued while offline
const PSTATE_HZ_DEFAULT = 15;
const RESEND_COOLDOWN_MS = 500;

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

const CID_STORAGE_KEY = "threadsite-cid";

function loadCid() {
  if (typeof localStorage === "undefined") return null;
  try {
    const existing = localStorage.getItem(CID_STORAGE_KEY);
    if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
    const fresh = `c-${crypto.randomUUID().replace(/-/g, "")}`;
    localStorage.setItem(CID_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return null; // storage unavailable: relay mints one for us per connection
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
    this.dropped = 0; // events detected missing (gap between sequence numbers)
    this.resent = 0; // events recovered via resend-req
    this.duplicates = 0; // events re-delivered out of order / duplicated
    this.rateLimited = 0; // frames the relay rejected for exceeding its rate

    this._peers = new Map();
    this._peerStates = new Map(); // cid -> newest state (keyed by STABLE id)
    this._peerLastSeen = new Map(); // peerId -> epoch ms of newest inbound frame
    this._lastSeqByPeer = new Map(); // peerId -> newest event seq seen (first delivery)
    this._deliveredSeqsByPeer = new Map(); // peerId -> highest seq delivered, resends deduped
    this._resendAt = new Map(); // peerId -> epoch ms until which resend-req is suppressed
    this._recentEvents = []; // [{seq, e, d}] ring of recently sent events
    this._outbox = []; // frames queued while the socket is down
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
   * Every peer's newest self-published state: [{ cid, id, state }]. Keyed by
   * the stable client id, so it stays correct across peer reconnects.
   */
  get playerStates() {
    return [...this._peerStates.entries()].map(([cid, state]) => {
      const peer = this.peerByCid(cid);
      return { cid, id: peer ? peer.id : null, state };
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
   * when no pong has been answered yet. Use for shared timers so every client
   * agrees on "when" without syncing their own clocks.
   */
  serverNow() {
    return Date.now() + (this.serverTimeOffset ?? 0);
  }

  /**
   * Total queued-but-undelivered frames while offline (events you called
   * send() for during a drop; they flush automatically on reconnect).
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
   * from your code's perspective: the library stamps a sequence number,
   * remembers the event for gap-fill resends, and queues it through brief
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
   */
  publishState(state) {
    this._send({ t: "state", s: state ?? null });
  }

  /**
   * Peer-owned state: broadcast YOUR OWN player's state. Coalesced to
   * `pstateHz` (default 15 Hz) — safe to call every render frame; the newest
   * state always wins. No host round trip — controls stay local. The relay
   * retains the newest state per client (keyed by cid) and hands them to late
   * joiners; other clients receive it via onPlayerState.
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

  /** Newest self-published state of one peer id or cid (or undefined). */
  peerState(peerIdOrCid) {
    if (this._peerStates.has(peerIdOrCid)) return this._peerStates.get(peerIdOrCid);
    const peer = this._peers.get(peerIdOrCid) ?? this.peerByCid(peerIdOrCid);
    return peer ? this._peerStates.get(peer.cid) : undefined;
  }

  /** Ask the current host for a fresh snapshot (fires onState when it replies). */
  requestState() {
    this._send({ t: "state-req" });
  }

  /** Measure round-trip time; the latest value is always available as net.rtt. */
  ping() {
    this._lastPingTs = Date.now();
    this._send({ t: "ping", ts: this._lastPingTs });
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
    this._send({ t: "pstate", s: state });
  }

  _send(frame) {
    if (this._ws === null || this._ws.readyState !== 1) {
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
        this._deliveredSeqsByPeer.clear();
        this._resendAt.clear();
        for (const peer of frame.peers ?? []) {
          this._peers.set(peer.id, { id: peer.id, name: peer.name, cid: peer.cid ?? null });
          if (peer.s !== null && peer.s !== undefined && peer.cid) this._peerStates.set(peer.cid, peer.s);
          this._peerLastSeen.set(peer.id, Date.now());
        }
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
        this._deliveredSeqsByPeer.delete(frame.id);
        this._resendAt.delete(frame.id);
        // NOTE: _peerStates is keyed by cid and deliberately kept — the player
        // may reconnect and reclaim their identity and state.
        const migrated = frame.host !== undefined && frame.host !== this.hostId;
        this.hostId = frame.host ?? null;
        this._emitPeers();
        if (migrated && this.onHostChange) this.onHostChange(this.hostId, this.isHost);
        return;
      }
      case "pstate": {
        const cid = frame.cid ?? null;
        if (cid) this._peerStates.set(cid, frame.s);
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
      case "resend-req":
        this._answerResend(frame);
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
    const isResend = frame.r === 1;
    const seq = typeof frame.seq === "number" ? frame.seq : null;
    let deliver = true;
    if (seq !== null) {
      const last = this._lastSeqByPeer.get(peerId) ?? null;
      if (last !== null && !isResend) {
        if (seq > last + 1) {
          // Gap: events were lost in transit. Ask the sender to re-transmit
          // (rate-limited to one request per peer per cooldown window) while
          // still delivering what did arrive so play continues.
          const missing = seq - last - 1;
          this.dropped += missing;
          this._requestResend(peerId, last, seq);
        }
      }
      if (isResend) {
        // A recovered or requeued event: deliver only if we never saw this seq
        // from this peer, and remember it so it cannot double-apply.
        const highest = this._deliveredSeqsByPeer.get(peerId);
        if (highest !== undefined && seq <= highest) deliver = false;
        else this._deliveredSeqsByPeer.set(peerId, Math.max(highest ?? -Infinity, seq));
      }
      if (!isResend && (last === null || seq > last)) this._lastSeqByPeer.set(peerId, seq);
      if (!isResend && seq <= (last ?? -Infinity)) this.duplicates += 1;
    }
    if (deliver && this.onEvent) {
      this.onEvent({ from: peerId, cid: frame.cid ?? null, type: frame.e, data: frame.d, seq, ts: frame.ts ?? null });
    }
  }

  _requestResend(peerId, after, before) {
    const now = Date.now();
    const until = this._resendAt.get(peerId) ?? 0;
    if (now < until) return;
    this._resendAt.set(peerId, now + RESEND_COOLDOWN_MS);
    try {
      this._send({ t: "resend-req", to: peerId, after, before });
    } catch {
      // Queued for when the socket returns; best effort.
    }
  }

  _answerResend(frame) {
    const requester = frame.from;
    const after = frame.after;
    const before = frame.before;
    for (const event of this._recentEvents) {
      if (event.seq > after && event.seq < before) {
        // Marked r:1 so the receiver's gap detection does not re-trigger.
        const resend = { t: "event", e: event.e, d: event.d, seq: event.seq, r: 1 };
        if (event.to !== null && event.to !== undefined) resend.to = event.to;
        try {
          this._send(resend);
        } catch {
          // connection gone; the outbox path in _send handles it
        }
      }
    }
  }

  _requeueBySeq(seq) {
    const event = this._recentEvents.find((candidate) => candidate.seq === seq);
    if (!event) return;
    // Requeue the exact original event (same audience, marked r:1 so the
    // receiver treats it as a recovery re-delivery and dedupes by seq).
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
