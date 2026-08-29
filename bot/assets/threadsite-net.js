// ThreadSite Multiplayer Protocol — browser client.
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
//     onPlayerState: (ps) => updateRemotePlayer(ps.from, ps.state),
//     onEvent: (ev) => applyRemoteEvent(ev),
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
// Recommended sync model for casual games (see the project AGENTS.md guide):
// every player owns and simulates their OWN entity, so controls never travel
// through another player's machine. From your game loop call
// net.publishPlayerState({ x, y, vx, vy, anim, ... }) at 10-20 Hz, render other
// players from their newest player state (interpolating), and affect other
// players by sending them events ("I hit you") that their own client applies.
// Shared-world state (ball, NPCs) can live in net.publishState snapshots, or be
// owned by the spawning peer. The room's oldest peer is the "host" — that only
// matters if you give it shared-world ownership; losing it never affects
// anyone's controls (onHostChange reports migrations).
//
// Invite links: after hosting, build a shareable URL with net.inviteUrl() (the
// current page URL plus "#room=CODE"). On load, pass ThreadSiteNet.roomFromUrl()
// as `room` so visitors auto-join the host's room instead of typing the code.
// Single-server games skip all of this — everyone connects with mode: "single".

export const PROTOCOL_VERSION = 2;

export const NET_STATUS = Object.freeze({
  CONNECTING: "connecting",
  ONLINE: "online",
  RECONNECTING: "reconnecting",
  CLOSED: "closed",
});

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
   *   autoReconnect         — default true: keep retrying with backoff after drops.
   *   connectTimeoutMs      — default 10000: how long connect() waits before rejecting.
   *   heartbeatMs           — default 10000: protocol-level ping interval (see net.rtt).
   *   onStatus(status, detail), onPeers(peers), onEvent({from, type, data}),
   *   onState({from, state}), onHostChange(hostId, isHost), onStateRequest(from)
   */
  static connect(opts = {}) {
    const net = new ThreadSiteNet(opts);
    return net.opened;
  }

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
    this.room = null;
    this.hostId = null;
    this.rtt = null;
    this._peers = new Map();
    this._peerStates = new Map();
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

  /** Other peers in the room: [{ id, name }], excluding yourself. */
  get peers() {
    return [...this._peers.values()];
  }

  /** Every peer's newest self-published state: [{ id, state }]. */
  get playerStates() {
    return [...this._peerStates.entries()].map(([id, state]) => ({ id, state }));
  }

  get isHost() {
    return this.id !== null && this.hostId === this.id;
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

  /** Broadcast an application event to the rest of the room (fire-and-forget). */
  send(type, data) {
    this._requireOnline();
    this._send({ t: "event", e: String(type), d: data ?? null });
  }

  /** Send an application event to one peer only (e.g. a direct question to the host). */
  sendTo(peerId, type, data) {
    this._requireOnline();
    this._send({ t: "event", e: String(type), d: data ?? null, to: peerId });
  }

  /**
   * Publish an authoritative room snapshot. The relay stores the newest one and
   * hands it to late joiners, so hosts should call this regularly (8-15 Hz) and
   * include a monotonically increasing tick.
   */
  publishState(state) {
    this._requireOnline();
    this._send({ t: "state", s: state ?? null });
  }

  /**
   * Peer-owned state: broadcast YOUR OWN player's state (10-20 Hz from the game
   * loop). No host round trip — controls stay local. The relay retains the
   * newest state per peer and hands them to late joiners; other clients receive
   * it via onPlayerState.
   */
  publishPlayerState(state) {
    this._requireOnline();
    this._send({ t: "pstate", s: state ?? null });
  }

  /** Newest self-published state of one peer (or undefined until they send one). */
  peerState(peerId) {
    return this._peerStates.get(peerId);
  }

  /** Ask the current host for a fresh snapshot (fires onState when it replies). */
  requestState() {
    this._requireOnline();
    this._send({ t: "state-req" });
  }

  /** Measure round-trip time; the latest value is always available as net.rtt. */
  ping() {
    this._requireOnline();
    this._lastPingTs = Date.now();
    this._send({ t: "ping", ts: this._lastPingTs });
  }

  /** Leave the room and stop reconnecting. The socket cannot be reused afterwards. */
  close() {
    this._manuallyClosed = true;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._heartbeatTimer);
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

  _requireOnline() {
    if (this._ws?.readyState !== 1 || this.id === null) {
      throw new ThreadSiteNetError("Not connected to a room yet.", "not_online");
    }
  }

  _send(frame) {
    try {
      this._ws.send(JSON.stringify(frame));
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
      this._peerStates.clear();
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
        this.room = frame.room;
        this.mode = frame.mode === "single" ? "single" : "rooms";
        // Reconnects rejoin the exact room we were in, rather than hosting a
        // fresh one when the original join used createRoom.
        this.requestedRoom = this.mode === "single" ? "" : frame.room;
        this.createRoom = false;
        this.hostId = frame.host;
        this._peers.clear();
        this._peerStates.clear();
        for (const peer of frame.peers ?? []) {
          this._peers.set(peer.id, { id: peer.id, name: peer.name });
          if (peer.s !== null && peer.s !== undefined) this._peerStates.set(peer.id, peer.s);
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
          this.onState({ from: frame.s.from, state: frame.s.s });
        }
        this._emitPeers();
        if (this.onHostChange) this.onHostChange(this.hostId, this.isHost);
        return;
      }
      case "peer-join":
        this.hostId = frame.host ?? this.hostId;
        if (frame.peer) this._peers.set(frame.peer.id, { id: frame.peer.id, name: frame.peer.name });
        this._emitPeers();
        if (frame.host && this.onHostChange) this.onHostChange(this.hostId, this.isHost);
        return;
      case "peer-leave": {
        this._peers.delete(frame.id);
        this._peerStates.delete(frame.id);
        const migrated = frame.host !== undefined && frame.host !== this.hostId;
        this.hostId = frame.host ?? null;
        this._emitPeers();
        if (migrated && this.onHostChange) this.onHostChange(this.hostId, this.isHost);
        return;
      }
      case "pstate": {
        this._peerStates.set(frame.from, frame.s);
        if (this.onPlayerState) this.onPlayerState({ from: frame.from, state: frame.s });
        return;
      }
      case "event":
        if (this.onEvent) this.onEvent({ from: frame.from, type: frame.e, data: frame.d });
        return;
      case "state":
        if (this.onState) this.onState({ from: frame.from, state: frame.s });
        return;
      case "state-req":
        if (this.onStateRequest) this.onStateRequest(frame.from);
        return;
      case "pong":
        if (typeof frame.ts === "number" && frame.ts === this._lastPingTs) this.rtt = Date.now() - frame.ts;
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
