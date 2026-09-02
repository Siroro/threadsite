// Type declarations for the ThreadSite Multiplayer Protocol v3 browser client
// (threadsite-net.js). The payload envelopes — from/cid/seq/ts — are typed
// exactly; the application-defined `state`/`data` contents are intentionally
// `any`, because each game defines its own shapes.

/** Wire protocol version this client speaks; must match the relay. */
export const PROTOCOL_VERSION: number;

/**
 * Connection status values. Typed as plain strings (not literals) on purpose:
 * authored code copying a constant (`let s = NET_STATUS.CONNECTING`) widens
 * to `string` instead of pinning a singleton literal type.
 */
export const NET_STATUS: {
  readonly CONNECTING: string;
  readonly ONLINE: string;
  readonly RECONNECTING: string;
  readonly DEGRADED: string;
  readonly CLOSED: string;
};

/** Relay/client error carrying a stable machine-readable code. */
export class ThreadSiteNetError extends Error {
  name: "ThreadSiteNetError";
  code: string;
}

/** A peer in the room. `id` is the live per-connection identity; `cid` is stable for reconnect/reload within the current browser tab session. */
export interface NetPeer {
  id: string;
  name: string | null;
  cid: string | null;
}

/** onPlayerState payload: another player's newest self-published state. */
export interface NetPlayerState {
  /** Sender's live per-connection peer id — use for active avatars, routing, and self-filtering. */
  from: string;
  cid: string | null;
  /** Game-defined state the peer published via publishPlayerState(). */
  state: any;
  /** Relay receive time, epoch ms. Compare/order it against net.serverNow(), never Date.now(). */
  ts: number | null;
}

/** onEvent payload: a sequenced application event, already deduped by seq. */
export interface NetEvent {
  from: string;
  cid: string | null;
  type: string;
  data: any;
  /** Sender's sequence number (event id) — keep handlers idempotent by seq. */
  seq: number | null;
  ts: number | null;
}

/** onState payload: a room snapshot from a peer or the relay's late-joiner cache. */
export interface NetSnapshot {
  from: string;
  cid: string | null;
  state: any;
  /** Relay receive time — discard snapshots older than the newest seen from the same source. */
  ts: number | null;
}

/** Every currently connected peer's newest self-published state. */
export interface NetPlayerStateEntry {
  cid: string | null;
  id: string;
  state: any;
}

export interface ThreadSiteNetOptions {
  /** Tenant id — pass NET_CONFIG.game unchanged. */
  game?: string;
  /** Relay WebSocket URL — pass NET_CONFIG.url unchanged. */
  url?: string;
  /** Pass-through from spreading NET_CONFIG; the client pins the protocol itself. */
  protocol?: number;
  /** "single": one shared arena for the whole game, no room codes. Default "rooms". */
  mode?: "single" | "rooms";
  /** Room code to join (e.g. ThreadSiteNet.roomFromUrl()); null hosts fresh. */
  room?: string | null;
  /** True to host a new room; the code lands in `net.room`. */
  createRoom?: boolean;
  /** Display name for this peer (max 32 chars). */
  name?: string;
  /** Default true: keep retrying with backoff after drops. */
  autoReconnect?: boolean;
  /** Default 10000: how long connect() waits before rejecting. */
  connectTimeoutMs?: number;
  /** publishPlayerState coalescing rate, 1-60 (default 15). */
  pstateHz?: number;
  onStatus?: ((status: string, detail: unknown) => void) | null;
  onPeers?: ((peers: NetPeer[]) => void) | null;
  onPlayerState?: ((playerState: NetPlayerState) => void) | null;
  onEvent?: ((event: NetEvent) => void) | null;
  onState?: ((snapshot: NetSnapshot) => void) | null;
  onHostChange?: ((hostId: string | null, isHost: boolean) => void) | null;
  onStateRequest?: ((from: string) => void) | null;
}

export class ThreadSiteNet {
  /** Connect and join a room; resolves once the room is joined. */
  static connect(options?: ThreadSiteNetOptions): Promise<ThreadSiteNet>;
  /** Room code from the page URL's "#room=CODE" fragment, or null. */
  static roomFromUrl(): string | null;

  constructor(options?: ThreadSiteNetOptions);

  /** Resolves to the connected client; rejects on unreachable relay / bad room. */
  opened: Promise<ThreadSiteNet>;

  game: string;
  url: string;
  mode: "single" | "rooms";
  requestedRoom: string;
  createRoom: boolean;
  name: string;
  autoReconnect: boolean;
  connectTimeoutMs: number;

  /** Callbacks are plain mutable properties — reassignable after connecting. */
  onStatus: ((status: string, detail: unknown) => void) | null;
  onPeers: ((peers: NetPeer[]) => void) | null;
  onPlayerState: ((playerState: NetPlayerState) => void) | null;
  onEvent: ((event: NetEvent) => void) | null;
  onState: ((snapshot: NetSnapshot) => void) | null;
  onHostChange: ((hostId: string | null, isHost: boolean) => void) | null;
  onStateRequest: ((from: string) => void) | null;

  /** Current NET_STATUS value. */
  readonly status: string;
  /** Other peers in the room, excluding yourself. */
  readonly peers: NetPeer[];
  /** Every currently connected peer's newest self-published state. */
  readonly playerStates: NetPlayerStateEntry[];
  /** True while this client is the room's host. */
  readonly isHost: boolean;
  /** Frames queued-but-undelivered while offline (events only; flushed on reconnect). */
  readonly queued: number;

  /** Your per-connection peer id (null before the first welcome). */
  id: string | null;
  /** Your tab-session client id — survives reconnect/reload in this tab; use peer ids for live remote entities. */
  cid: string | null;
  /** Joined room code (null in "single" mode / before welcome). */
  room: string | null;
  hostId: string | null;
  /** Latest ping round-trip time, epoch-ms (null before the first pong). */
  rtt: number | null;
  serverTimeOffset: number | null;
  /** Sync-health counters, monotonic for this client instance. */
  dropped: number;
  duplicates: number;
  rateLimited: number;

  /** Peer record (or undefined) for a stable client id. */
  peerByCid(cid: string): NetPeer | undefined;
  /** Epoch-ms of the peer's newest inbound frame (null when unknown). */
  peerLastSeen(peerId: string): number | null;
  /** True when the peer's newest update is older than maxAgeMs (default 5s). */
  isStale(peerId: string, maxAgeMs?: number): boolean;
  /** Newest event sequence number received from a peer (null when none). */
  lastSeqFrom(peerId: string): number | null;
  /** Best estimate of the relay's current time (epoch ms) for shared timers. */
  serverNow(): number;
  /** Shareable invite URL ("…#room=CODE"), or null with no room/page URL. */
  inviteUrl(): string | null;

  /** Broadcast an application event to the room (sequenced; dedupe by seq). */
  send(type: string, data?: any): void;
  /** Send an application event to one peer only. */
  sendTo(peerId: string, type: string, data?: any): void;
  /** Publish an authoritative room snapshot (hosts, 8-15 Hz, increasing tick). Never queued while offline. */
  publishState(state: any): void;
  /** Publish YOUR OWN player's state (coalesced to pstateHz; per-frame safe). Never queued while offline. */
  publishPlayerState(state: any): void;
  /** Immediately push the pending player state (e.g. after a teleport). */
  flushPlayerState(): void;
  /** A peer's newest self-published state by peer id or cid (or undefined). */
  peerState(peerIdOrCid: string): any;
  /** Ask the current host for a fresh snapshot (fires onState on reply). */
  requestState(): void;
  /** Measure RTT; the latest value is always available as `net.rtt`. */
  ping(): void;
  /** Leave the room and stop reconnecting; the socket cannot be reused. */
  close(): void;
}
