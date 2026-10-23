// ThreadSite Multiplayer Protocol v4 browser client.
// TypeScript is the source of truth; the bot build emits the zero-dependency
// threadsite-net.js and declarations vendored into generated games.
import { getPlayerIdentity } from "./threadsite-player.js";

export const PROTOCOL_VERSION = 4;
export type NetStatus = "connecting" | "online" | "reconnecting" | "degraded" | "closed";
export type NetMode = "single" | "rooms";
export type TransformSampleMode = "interpolated" | "extrapolated" | "held";

export const NET_STATUS = Object.freeze({
  CONNECTING: "connecting", ONLINE: "online", RECONNECTING: "reconnecting",
  DEGRADED: "degraded", CLOSED: "closed",
} satisfies Record<string, NetStatus>);

export interface NetPeer { id: string; name: string | null; cid: string | null }
export interface NetPlayerState<T = any> { from: string; cid: string | null; state: T; ts: number }
export interface NetEvent<T = any> { id: string; from: string; cid: string | null; type: string; data: T; ts: number }
export interface NetEphemeralEvent<T = any> { from: string; cid: string | null; type: string; data: T; ts: number }
export interface NetIntent<T = any> {
  id: string; from: string; cid: string | null; type: string;
  payload: T; runId: string | number; ts: number;
}
export interface NetRunChange { previous: string | number | null; current: string | number; tick: number }
export interface NetWorldSnapshot<T = any> {
  from: string; cid: string | null; state: T; ts: number;
  authorityGeneration: string; authorityEpoch: number; stateSeq: number;
}
export interface NetPlayerStateEntry<T = any> { id: string; cid: string | null; state: T }
export interface NetPresenceEntry<T = any> { id: string; cid: string | null; state: T }
export interface NetSave<T = unknown> { value: T | null; revision: number; updatedAt: number | null }
export interface NetScore { playerId: string; name: string; score: number; updatedAt: number }
export type NetScoreOrder = "asc" | "desc";
export interface NetLeaderboard { order: NetScoreOrder | null; entries: NetScore[] }

/** Engine-neutral 2D/3D transform. Extra game fields pass through unchanged. */
export interface NetTransform {
  x: number; y: number; z?: number; vx?: number; vy?: number; vz?: number;
  rotation?: number; angle?: number; facing?: number | string; alive?: boolean;
  runId?: string | number; [key: string]: any;
}
export interface TransformSampleInfo {
  mode: TransformSampleMode; renderTs: number; sourceTs: number; ageMs: number; samples: number;
}
export interface SampleTransformOptions {
  /** Override the adaptive 45-150 ms interpolation delay. */
  renderDelayMs?: number;
  /** Maximum velocity extrapolation when packets arrive late. Default 100 ms. */
  maxExtrapolationMs?: number;
}
export interface NetRemotePlayer<T extends NetTransform = NetTransform> {
  peer: NetPeer; transform: T; sample: TransformSampleInfo;
}
export interface SampleRemotePlayersOptions extends SampleTransformOptions {
  /** Hide a live peer whose transform stream has been silent this long. Default 2000 ms. */
  maxAgeMs?: number;
}
/** A live peer with its newest received transform: no interpolation or render delay. */
export interface NetLatestPlayer<T extends NetTransform = NetTransform> {
  peer: NetPeer; transform: T; ts: number; ageMs: number;
}
export interface LatestRemotePlayersOptions {
  /** Hide a live peer whose transform stream has been silent this long. Default 2000 ms. */
  maxAgeMs?: number;
}
export interface NetWorldState<T = any> { runId: string | number; tick: number; state: T }
export interface NetWorldEnvelope<T = any> extends NetWorldState<T> { schemaVersion: string | number }
export interface NetWorldSyncOptions<T = any> {
  /** Bump when the complete snapshot shape changes. Mismatched snapshots are ignored. */
  schemaVersion: string | number;
  /** Capture the complete authoritative world. Called only while this client is host. */
  capture: () => NetWorldState<T>;
  /** Restore a complete snapshot before authoritative simulation starts or resumes. */
  restore: (world: NetWorldState<T>, snapshot: NetWorldSnapshot<NetWorldEnvelope<T>>) => void;
  /** Apply a complete accepted snapshot to guest presentation (never to host simulation). */
  present: (world: NetWorldState<T>, snapshot: NetWorldSnapshot<NetWorldEnvelope<T>>) => void;
  onAuthorityStart: (context: { epoch: number; recovered: boolean }) => void;
  onAuthorityStop: (context: { epoch: number }) => void;
  /** Complete-snapshot publication rate. Default 10 Hz, clamped to 1-30. */
  publishHz?: number;
  /** Extra game-specific validation after schema/run/tick validation. */
  validate?: (world: NetWorldState<T>) => boolean;
}
export interface NetCollectionSyncOptions<TLocal, TSnapshot> {
  getId: (snapshot: TSnapshot) => string | number;
  create: (snapshot: TSnapshot, id: string | number) => TLocal;
  update: (entity: TLocal, snapshot: TSnapshot, id: string | number) => void;
  remove: (entity: TLocal, id: string | number) => void;
  /**
   * Present the listed numeric fields interpolated between the last two
   * snapshots instead of stepping at snapshot rate. The controller writes the
   * smooth keys onto each entity at render time, so with `smooth` set the
   * `update` callback must not copy those keys itself — it owns the discrete
   * fields (hp, kind, flags), the controller owns position between snapshots.
   */
  smooth?: NetCollectionSmoothOptions<TSnapshot>;
}
export interface NetCollectionSmoothOptions<TSnapshot> {
  /** Numeric snapshot keys the controller blends between snapshots. */
  keys: (keyof TSnapshot & string)[];
  /**
   * Displacement across the smooth keys above which an entity lands at its
   * newest position unblended — teleports, spawns, large corrections.
   * Default 10.
   */
  snapDistance?: number;
  /**
   * Override the adaptive render delay. Default: 1.25 x the measured snapshot
   * arrival interval, clamped to 50-200 ms.
   */
  renderDelayMs?: number;
}
/** Live link diagnostics from `net.stats`, sized for a HUD readout. */
export interface NetLinkStats {
  /** Round-trip to the relay in ms (null before the first pong). */
  rtt: number | null;
  /** Measured relay-time transit jitter in ms. */
  jitterMs: number;
  /** Connected peers excluding this client. */
  peers: number;
  /** Measured complete-world cadence in Hz (null before two worlds arrive). */
  worldHz: number | null;
  /** Size of the last sent (host) or received (guest) world frame in bytes. */
  lastWorldBytes: number | null;
  /** Periodic frames dropped so far by the client-side send budget. */
  budgetDroppedFrames: number;
}
export type AuthoritativeSessionOptions<T = any> = Omit<ThreadSiteNetOptions,
  "world" | "mode" | "onWorld" | "onWorldRequest" | "onAuthorityAcquired" | "onAuthorityLost"> & {
  /** Shared arena by default; use rooms when the game exposes room codes. */
  mode?: NetMode;
  world: NetWorldSyncOptions<T>;
};
export interface ThreadSiteNetOptions {
  /** Tenant id; spread NET_CONFIG rather than inventing one. */
  game?: string;
  /** Relay WebSocket URL; spread NET_CONFIG rather than inventing one. */
  url?: string;
  /** NET_CONFIG protocol guard. */
  protocol?: number;
  /** `single` joins one game-wide arena; `rooms` uses invite codes. */
  mode?: NetMode;
  /** Existing room to join. Use roomFromUrl() for invite links. */
  room?: string | null;
  /** Create a fresh code-addressed room. */
  createRoom?: boolean;
  name?: string;
  /** Private 256-bit lowercase hex credential. Normally generated and stored in localStorage.
   * Never put it in shared state, URLs, presence, or events. Not a Discord identity.
   */
  playerToken?: string;
  autoReconnect?: boolean;
  connectTimeoutMs?: number;
  /** Coalesced transform/player-state rate, 1-60 Hz. Default 25. */
  transformHz?: number;
  /** Reliable-event lifetime through a disconnect, 250-30000 ms. Default 3000. */
  eventTtlMs?: number;
  /** Automatically yield host authority when the tab is hidden. Default true. */
  autoYieldOnHidden?: boolean;
  /** Safe, high-level complete-world replication lifecycle. */
  world?: NetWorldSyncOptions;
  onStatus?: ((status: NetStatus, detail: unknown) => void) | null;
  onPeers?: ((peers: NetPeer[]) => void) | null;
  /** @internal */ onPlayerState?: ((playerState: NetPlayerState) => void) | null;
  /** @internal */ onEvent?: ((event: NetEvent) => void) | null;
  /** @internal */ onEphemeral?: ((event: NetEphemeralEvent) => void) | null;
  /** @internal */ onPresence?: ((presence: NetPlayerState) => void) | null;
  /** @internal */ onWorld?: ((snapshot: NetWorldSnapshot) => void) | null;
  /** @internal */ onWorldRequest?: ((from: string) => void) | null;
  /** @internal */ onAuthorityAcquired?: ((snapshot: NetWorldSnapshot | null, authorityEpoch: number) => void) | null;
  /** @internal */ onAuthorityLost?: ((authorityEpoch: number) => void) | null;
}

type WireFrame = { t: string; [key: string]: any };
type TransformPoint = { state: NetTransform; ts: number; tick: number };
type ReliableFrame = { frame: WireFrame; expiresAt: number };
type RecentEvent = ReliableFrame & { id: string; retried: boolean };
type Timer = ReturnType<typeof setTimeout>;

// 256 KB with relay headroom (relay default 264 KB): worlds with hundreds of
// entities at 10-20 Hz fit without frame_too_large, while the cap still stops
// runaway frames well before relay memory limits.
// Client-side mirror of the relay's per-connection frame limiter, with
// headroom: every frame spends a token, and once the bucket is empty the
// periodic frames (transforms, complete worlds) are dropped with a throttled
// warning instead of flooding into the relay's own limiter. Rare reliable
// events still go through — reliability outranks pacing.
const SEND_BUDGET_PER_SECOND = 55;
const SEND_BUDGET_BURST = 100;
const MAX_FRAME_BYTES = 256 * 1024;
const OUTBOX_LIMIT = 128;
const RECENT_EVENTS = 128;
const RECENT_EVENT_IDS = 512;
const DEFAULT_TRANSFORM_HZ = 25;
const DEFAULT_EVENT_TTL_MS = 3000;
const TRANSFORM_BUFFER_SIZE = 12;
const TRANSFORM_BUFFER_WINDOW_MS = 500;
const DEFAULT_MAX_EXTRAPOLATION_MS = 100;
const MAX_BUFFERED_BYTES = 256 * 1024;
const HEARTBEAT_TIMEOUT_MS = 30_000;
const INTERPOLATED_KEYS = new Set(["x", "y", "z", "vx", "vy", "vz", "rotation", "angle", "facing"]);
const CID_STORAGE_KEY = "threadsite-session-cid-v4";
const RESUME_STORAGE_PREFIX = "threadsite-resume-room-v4:";
const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

export class ThreadSiteNetError extends Error {
  readonly code: string;
  declare cause?: unknown;
  net?: ThreadSiteNet;
  constructor(message: string, code = "error", cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ThreadSiteNetError";
    this.code = code;
  }
}

function normalizeUrl(url: unknown): string {
  const value = String(url ?? "").trim();
  if (!value) throw new ThreadSiteNetError("A relay URL is required (NET_CONFIG.url).", "bad_config");
  if (typeof location !== "undefined" && location.protocol === "https:" && value.startsWith("ws://")) {
    return `wss://${value.slice(5)}`;
  }
  return value;
}
function loadCid(): string | null {
  try {
    const existing = sessionStorage.getItem(CID_STORAGE_KEY);
    if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
    const fresh = `c-${crypto.randomUUID().replaceAll("-", "")}`;
    sessionStorage.setItem(CID_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    try { return `c-${crypto.randomUUID().replaceAll("-", "")}`; } catch { return null; }
  }
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function isTransform(value: unknown): value is NetTransform {
  if (!value || typeof value !== "object") return false;
  const transform = value as Partial<NetTransform>;
  return finite(transform.x) && finite(transform.y);
}
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function byteLength(value: string): number { return encoder?.encode(value).length ?? value.length; }
function randomToken(): string {
  try { return crypto.randomUUID().replaceAll("-", ""); }
  catch { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`; }
}
function loadResumeRoom(game: string): string | null {
  try {
    const value = sessionStorage.getItem(`${RESUME_STORAGE_PREFIX}${game}`);
    return value && /^[A-Z0-9]{4,12}$/.test(value) ? value : null;
  } catch { return null; }
}
function saveResumeRoom(game: string, room: string | null): void {
  try {
    const key = `${RESUME_STORAGE_PREFIX}${game}`;
    if (room) sessionStorage.setItem(key, room); else sessionStorage.removeItem(key);
  } catch { /* storage is optional */ }
}

function playerIdentity(game: string, supplied?: string): { token: string | null; persistent: boolean } {
  if (supplied !== undefined && !/^[a-f0-9]{64}$/.test(supplied)) throw new ThreadSiteNetError("playerToken must be 64 lowercase hex characters.", "bad_config");
  return getPlayerIdentity(game, supplied);
}

export class ThreadSiteNet {
  static roomFromUrl(): string | null {
    if (typeof location === "undefined") return null;
    return /[#&]room=([A-Za-z0-9]{4,12})/.exec(location.hash || "")?.[1]?.toUpperCase() ?? null;
  }
  static connect(options: ThreadSiteNetOptions = {}): Promise<ThreadSiteNet> { return new ThreadSiteNet(options).opened; }
  static createAuthoritativeSession<T>(options: AuthoritativeSessionOptions<T>): Promise<ThreadSiteNet> {
    return ThreadSiteNet.connect({
      ...options,
      mode: options.mode ?? "single",
      transformHz: options.transformHz ?? 25,
      world: { publishHz: options.world.publishHz ?? 10, ...options.world },
    });
  }

  readonly opened: Promise<ThreadSiteNet>;
  readonly game: string;
  readonly url: string;
  readonly autoReconnect: boolean;
  readonly connectTimeoutMs: number;
  readonly eventTtlMs: number;
  readonly autoYieldOnHidden: boolean;
  /** @internal */ worldSync: NetWorldSyncController | null;
  mode: NetMode;
  requestedRoom: string;
  createRoom: boolean;
  name: string;

  onStatus: ((status: NetStatus, detail: unknown) => void) | null;
  onPeers: ((peers: NetPeer[]) => void) | null;
  /** @internal */ onPlayerState: ((playerState: NetPlayerState) => void) | null;
  /** @internal */ onEvent: ((event: NetEvent) => void) | null;
  /** @internal */ onEphemeral: ((event: NetEphemeralEvent) => void) | null;
  /** @internal */ onPresence: ((presence: NetPlayerState) => void) | null;
  /** @internal */ onWorld: ((snapshot: NetWorldSnapshot) => void) | null;
  /** @internal */ onWorldRequest: ((from: string) => void) | null;
  /** @internal */ onAuthorityAcquired: ((snapshot: NetWorldSnapshot | null, authorityEpoch: number) => void) | null;
  /** @internal */ onAuthorityLost: ((authorityEpoch: number) => void) | null;

  readonly transforms: NetTransforms;
  readonly authority: NetAuthority;
  readonly world: NetWorld;
  readonly clock: NetClock;
  readonly events: NetEvents;
  readonly intents: NetIntents;
  readonly presence: NetPresence;
  readonly entities: NetEntities;
  readonly run: NetRun;
  readonly saves: NetSaves;
  readonly leaderboards: NetLeaderboards;
  private readonly playerIdentity: { token: string | null; persistent: boolean };
  private storagePlayerId: string | null = null;
  private readonly storageRequests = new Map<string, { resolve: (value: any) => void; reject: (error: ThreadSiteNetError) => void; timer: Timer }>();

  id: string | null = null;
  cid: string | null = loadCid();
  room: string | null = null;
  /** @internal */ hostId: string | null = null;
  /** @internal */ authorityEpoch = 0;
  /** @internal */ authorityGeneration: string | null = null;
  rtt: number | null = null;
  serverTimeOffset: number | null = null;
  duplicates = 0;
  rateLimited = 0;
  droppedTransient = 0;
  /** Periodic frames dropped by the client-side send budget (see net.stats). */
  budgetDroppedFrames = 0;
  private worldIntervalMs = 0;
  private lastWorldArrivalAt: number | null = null;
  private lastWorldBytesValue: number | null = null;
  private sendTokens = SEND_BUDGET_BURST;
  private sendTokensUpdatedAt = Date.now();
  private lastBudgetWarnAt = 0;

  private readonly transformIntervalMs: number;
  private readonly peersById = new Map<string, NetPeer>();
  private readonly statesByPeer = new Map<string, any>();
  private readonly lastSeenByPeer = new Map<string, number>();
  private readonly transformBuffers = new Map<string, TransformPoint[]>();
  private readonly transformInfo = new Map<string, TransformSampleInfo>();
  private readonly appliedEventIds = new Set<string>();
  private readonly recentEvents: RecentEvent[] = [];
  private outbox: ReliableFrame[] = [];
  private eventCounter = 0;
  private readonly eventInstance = randomToken();
  private transformTick = 0;
  private pendingPlayerState: { state: any; transformTick: number | null; reset: boolean } | null = null;
  private playerStateTimer: Timer | null = null;
  private socket: WebSocket | null = null;
  private currentStatus: NetStatus = NET_STATUS.CONNECTING;
  private attempt = 0;
  private reconnectTimer: Timer | null = null;
  private heartbeatTimer: Timer | null = null;
  private lastPingTs = 0;
  private lastPongAt = 0;
  private manuallyClosed = false;
  private openedSettled = false;
  private resolveOpened!: (net: ThreadSiteNet) => void;
  private rejectOpened!: (error: ThreadSiteNetError) => void;
  private latestWorld: NetWorldSnapshot | null = null;
  private latestWorldKey: [number, number] = [-1, -1];
  private lastPublishedWorld: any = undefined;
  private jitterMs = 0;
  private lastTransformArrival: { relayTs: number; localTs: number } | null = null;
  /** True once the welcome's cached world and authority have been processed. */
  private bootstrapDone = false;
  /** @internal True when this client's host authority began from an existing snapshot. */
  worldRestored = false;
  private readonly visibilityHandler: () => void;
  private readonly onlineHandler: () => void;
  private resumeRequested = false;
  private hasJoined = false;
  private yieldPending = false;

  constructor(options: ThreadSiteNetOptions = {}) {
    const game = String(options.game ?? "").trim();
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(game)) {
      throw new ThreadSiteNetError(`Invalid game id '${game}' — use NET_CONFIG.game unchanged.`, "bad_config");
    }
    this.game = game;
    this.playerIdentity = playerIdentity(game, options.playerToken);
    if (options.protocol !== undefined && options.protocol !== PROTOCOL_VERSION) {
      throw new ThreadSiteNetError(`NET_CONFIG protocol ${options.protocol} does not match client v${PROTOCOL_VERSION}.`, "bad_config");
    }
    this.url = normalizeUrl(options.url);
    this.mode = options.mode === "single" ? "single" : "rooms";
    this.requestedRoom = this.mode === "rooms" && options.room
      ? String(options.room).toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
    this.createRoom = this.mode === "rooms" && Boolean(options.createRoom);
    this.name = String(options.name ?? "player").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32) || "player";
    this.autoReconnect = options.autoReconnect !== false;
    this.connectTimeoutMs = Math.max(1000, Number(options.connectTimeoutMs) || 10_000);
    this.eventTtlMs = clamp(Number(options.eventTtlMs) || DEFAULT_EVENT_TTL_MS, 250, 30_000);
    this.autoYieldOnHidden = options.autoYieldOnHidden !== false;
    this.transformIntervalMs = Math.round(1000 / clamp(Number(options.transformHz) || DEFAULT_TRANSFORM_HZ, 1, 60));
    this.onStatus = options.onStatus ?? null;
    this.onPeers = options.onPeers ?? null;
    this.onPlayerState = options.onPlayerState ?? null;
    this.onEvent = options.onEvent ?? null;
    this.onEphemeral = options.onEphemeral ?? null;
    this.onPresence = options.onPresence ?? null;
    this.onWorld = options.onWorld ?? null;
    this.onWorldRequest = options.onWorldRequest ?? null;
    this.onAuthorityAcquired = options.onAuthorityAcquired ?? null;
    this.onAuthorityLost = options.onAuthorityLost ?? null;
    if (options.world && (options.onWorld || options.onWorldRequest || options.onAuthorityAcquired || options.onAuthorityLost)) {
      throw new ThreadSiteNetError("Use the world lifecycle option or raw world/authority callbacks, not both.", "bad_world_sync");
    }
    this.resumeRequested = Boolean(this.requestedRoom && loadResumeRoom(this.game) === this.requestedRoom);
    this.opened = new Promise((resolve, reject) => {
      this.resolveOpened = resolve;
      this.rejectOpened = (error) => { error.net = this; reject(error); };
    });
    this.opened.catch(() => undefined);
    this.visibilityHandler = () => {
      if (this.autoYieldOnHidden && document.hidden && this.isHost && this.peers.length > 0) this.yieldHost();
    };
    this.onlineHandler = () => {
      if (this.manuallyClosed || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      this.connectSocket();
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.visibilityHandler);
    if (typeof window !== "undefined") window.addEventListener("online", this.onlineHandler);
    this.transforms = new NetTransforms(this);
    this.authority = new NetAuthority(this);
    this.world = new NetWorld(this);
    this.clock = new NetClock(this);
    this.events = new NetEvents(this);
    this.intents = new NetIntents(this);
    this.presence = new NetPresence(this);
    this.entities = new NetEntities();
    this.run = new NetRun(this);
    this.saves = new NetSaves(this);
    this.leaderboards = new NetLeaderboards(this);
    this.worldSync = null;
    if (options.world) this.syncWorld(options.world);
    this.connectSocket();
  }

  get status(): NetStatus { return this.currentStatus; }
  /** Public leaderboard identity; separate from live peer IDs and never a credential. */
  get playerId(): string | null { return this.storagePlayerId; }
  /** @internal */ get persistentIdentity(): boolean { return this.playerIdentity.persistent; }

  /** @internal Online RPC only. Writes are never queued or replayed after an ambiguous failure. */
  storageRequest<T>(request: Record<string, unknown>): Promise<T> {
    if (this.manuallyClosed || this.status !== NET_STATUS.ONLINE || this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ThreadSiteNetError("Player storage requires an online relay. Keep solo play available.", "storage_offline"));
    }
    if (!this.storagePlayerId) return Promise.reject(new ThreadSiteNetError("This relay or browser does not support player persistence.", "storage_unsupported"));
    if (this.storageRequests.size >= 16 || this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      return Promise.reject(new ThreadSiteNetError("Too many outstanding requests or a busy connection.", "storage_busy"));
    }
    const id = `storage.${this.eventInstance}.${++this.eventCounter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.storageRequests.delete(id);
        reject(new ThreadSiteNetError("Storage acknowledgement timed out. Read the save before retrying a write.", "storage_uncertain"));
      }, 10_000);
      this.storageRequests.set(id, { resolve, reject, timer });
      try { this.sendFrame({ ...request, t: "storage", id }, true); }
      catch (error) { clearTimeout(timer); this.storageRequests.delete(id); reject(error); }
    });
  }

  private rejectStorageRequests(): void {
    for (const request of this.storageRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new ThreadSiteNetError("Connection closed before acknowledgement. Read the save before retrying a write.", "storage_uncertain"));
    }
    this.storageRequests.clear();
    this.storagePlayerId = null;
  }
  /**
   * Live link diagnostics for HUD display: round-trip, transit jitter, peer
   * count, measured complete-world cadence, last world-frame size, and
   * send-budget drops. Surface it (or a subset) near the clock so lag reports
   * can be triaged at a glance.
   */
  get stats(): NetLinkStats {
    return {
      rtt: this.rtt,
      jitterMs: this.jitterMs,
      peers: this.peersById.size,
      worldHz: this.worldIntervalMs > 0 ? 1000 / this.worldIntervalMs : null,
      lastWorldBytes: this.lastWorldBytesValue,
      budgetDroppedFrames: this.budgetDroppedFrames,
    };
  }
  /**
   * True once the relay welcome has been fully processed, including its cached
   * world snapshot and initial authority. Authoritative publishing stays
   * blocked (`not_ready`) until then, so a freshly elected host can never
   * overwrite a persisted/restored world before restoring it.
   */
  get bootstrapped(): boolean { return this.bootstrapDone; }
  get peers(): NetPeer[] { return [...this.peersById.values()]; }
  get playerStates(): NetPlayerStateEntry[] {
    return [...this.statesByPeer].map(([id, state]) => ({ id, cid: this.peersById.get(id)?.cid ?? null, state }));
  }
  /** @internal */ get isHost(): boolean { return this.id !== null && this.hostId === this.id; }
  get queued(): number { this.pruneOutbox(); return this.outbox.length; }
  peerState(peerId: string): any { return this.statesByPeer.get(peerId); }
  peerLastSeen(peerId: string): number | null { return this.lastSeenByPeer.get(peerId) ?? null; }
  isStale(peerId: string, maxAgeMs = 5000): boolean {
    const lastSeen = this.lastSeenByPeer.get(peerId);
    return lastSeen === undefined || Date.now() - lastSeen > maxAgeMs;
  }
  /** @internal */ serverNow(): number { return Date.now() + (this.serverTimeOffset ?? 0); }
  inviteUrl(): string | null {
    if (typeof location === "undefined" || this.mode === "single" || !this.room) return null;
    return `${location.origin}${location.pathname}${location.search}#room=${this.room}`;
  }

  /** @internal Install through `world.sync()` or the authoritative-session preset. */
  syncWorld<T>(options: NetWorldSyncOptions<T>): NetWorldSyncController<T> {
    if (this.worldSync) throw new ThreadSiteNetError("World synchronization is already configured.", "world_sync_exists");
    if (this.onWorld || this.onWorldRequest || this.onAuthorityAcquired || this.onAuthorityLost) {
      throw new ThreadSiteNetError("Clear raw world/authority callbacks before installing world synchronization.", "bad_world_sync");
    }
    const controller = new NetWorldSyncController<T>(this, options);
    this.worldSync = controller;
    return controller;
  }

  /** @internal Use `events.sendReliable()`. */
  emit(type: string, data: any = null): string { return this.emitEvent(null, type, data); }
  /** @internal Use `events.sendReliable()`. */
  emitTo(peerId: string, type: string, data: any = null): string {
    if (!this.peersById.has(peerId) && peerId !== this.id) throw new ThreadSiteNetError(`Peer ${peerId} is not connected.`, "bad_target");
    return this.emitEvent(peerId, type, data);
  }
  /** @internal Used by the intent facade. */
  emitToAuthority(type: string, data: any = null): string {
    if (!this.hostId) throw new ThreadSiteNetError("No authoritative host is connected.", "no_host");
    return this.emitEvent("@host", type, data);
  }
  /** @internal Use `events.sendEphemeral()`. */
  emitEphemeral(type: string, data: any = null, peerId: string | null = null): void {
    const eventType = String(type).trim().slice(0, 64);
    if (!eventType) throw new ThreadSiteNetError("Ephemeral event type is required.", "bad_signal");
    if (peerId !== null && !this.peersById.has(peerId) && peerId !== this.id) {
      throw new ThreadSiteNetError(`Peer ${peerId} is not connected.`, "bad_target");
    }
    const frame: WireFrame = { t: "signal", e: eventType, d: data };
    if (peerId !== null) frame.to = peerId;
    this.sendFrame(frame, true);
  }
  /** @internal Use `presence.set()`. */
  publishPresence(state: any): void {
    this.presence._setLocal(state ?? null);
    this.sendFrame({ t: "presence", s: state ?? null }, true);
  }
  /** @internal Complete worlds are owned by the world lifecycle. */
  publishWorld(state: any): void {
    if (!this.bootstrapDone) {
      throw new ThreadSiteNetError(
        "Bootstrap is not complete; process the welcome world (restore it in onAuthorityAcquired/onAuthorityStart) before publishing.",
        "not_ready",
      );
    }
    if (!this.isHost) throw new ThreadSiteNetError("Only the current host may publish world state.", "not_host");
    if (!this.authorityGeneration) throw new ThreadSiteNetError("No active room generation is available.", "stale_authority");
    this.lastPublishedWorld = state ?? null;
    this.sendFrame({
      t: "world", generation: this.authorityGeneration,
      epoch: this.authorityEpoch, s: this.lastPublishedWorld,
    }, true);
  }
  /** @internal World requests are automatic. */
  requestWorld(): void { this.sendFrame({ t: "world-req" }, true); }
  /** @internal Use transforms or presence. */
  publishPlayerState(state: any): void { this.queuePlayerState(state ?? null, null, false); }
  /** @internal Use `transforms.publish()`. */
  publishTransform(transform: NetTransform): void {
    if (!isTransform(transform)) throw new ThreadSiteNetError("publishTransform requires finite x and y.", "bad_transform");
    this.transformTick += 1;
    this.queuePlayerState({ ...transform }, this.transformTick, false);
  }
  /** @internal Use `transforms.teleport()`. */
  publishTeleport(transform: NetTransform): void {
    if (!isTransform(transform)) throw new ThreadSiteNetError("publishTeleport requires finite x and y.", "bad_transform");
    this.transformTick += 1;
    this.queuePlayerState({ ...transform }, this.transformTick, true);
    this.flushPlayerState();
  }
  /** @internal */ flushPlayerState(): void {
    const pending = this.pendingPlayerState;
    if (!pending) return;
    this.pendingPlayerState = null;
    const frame: WireFrame = { t: "pstate", s: pending.state };
    if (pending.transformTick !== null) frame.pt = pending.transformTick;
    if (pending.reset) frame.pr = true;
    this.sendFrame(frame, true);
  }

  /** @internal Use `transforms.sample()`. */
  sampleTransform<T extends NetTransform = NetTransform>(peerId: string, options: SampleTransformOptions = {}): T | null {
    const buffer = this.transformBuffers.get(peerId);
    if (!buffer?.length) return null;
    // Remote motion is rendered one interpolation window behind relay time:
    // at least 45 ms (tight on low-jitter links, where the old 100 ms floor
    // read as lag) growing with measured transit jitter, hard-capped at 150.
    const delay = options.renderDelayMs === undefined ? clamp(45 + this.jitterMs * 3, 45, 150) : clamp(options.renderDelayMs, 0, 500);
    const renderTs = this.serverNow() - delay;
    const maxExtrapolation = clamp(options.maxExtrapolationMs ?? DEFAULT_MAX_EXTRAPOLATION_MS, 0, 250);
    let before: TransformPoint | undefined;
    let after: TransformPoint | undefined;
    for (const point of buffer) {
      if (point.ts <= renderTs) before = point;
      if (point.ts >= renderTs) { after = point; break; }
    }
    let result: NetTransform;
    let mode: TransformSampleMode;
    let sourceTs: number;
    if (before && after && before !== after && after.ts > before.ts) {
      const alpha = clamp((renderTs - before.ts) / (after.ts - before.ts), 0, 1);
      result = interpolateTransform(before.state, after.state, alpha);
      mode = "interpolated"; sourceTs = renderTs;
    } else {
      const latest = before ?? after ?? buffer[buffer.length - 1];
      if (!latest) return null;
      const extrapolation = clamp(renderTs - latest.ts, 0, maxExtrapolation);
      result = extrapolation > 0 ? extrapolateTransform(latest.state, extrapolation / 1000) : { ...latest.state };
      mode = extrapolation > 0 ? "extrapolated" : "held"; sourceTs = latest.ts;
    }
    this.transformInfo.set(peerId, {
      mode, renderTs, sourceTs,
      ageMs: Math.max(0, this.serverNow() - (buffer[buffer.length - 1]?.ts ?? sourceTs)), samples: buffer.length,
    });
    return result as T;
  }
  /** @internal */ transformSampleInfo(peerId: string): TransformSampleInfo | null { return this.transformInfo.get(peerId) ?? null; }
  /** @internal Use `transforms.sampleAll()`. */
  sampleRemotePlayers<T extends NetTransform = NetTransform>(options: SampleRemotePlayersOptions = {}): NetRemotePlayer<T>[] {
    const maxAgeMs = clamp(options.maxAgeMs ?? 2000, 100, 30_000);
    const result: NetRemotePlayer<T>[] = [];
    for (const peer of this.peersById.values()) {
      const transform = this.sampleTransform<T>(peer.id, options);
      const sample = this.transformSampleInfo(peer.id);
      if (transform && sample && sample.ageMs <= maxAgeMs) result.push({ peer, transform, sample });
    }
    return result;
  }
  /** @internal Use `transforms.latest()`. */
  latestTransform<T extends NetTransform = NetTransform>(peerId: string): T | null {
    const newest = this.transformBuffers.get(peerId)?.at(-1);
    return newest ? ({ ...newest.state } as T) : null;
  }
  /** @internal Use `transforms.latestAll()`. */
  latestRemotePlayers<T extends NetTransform = NetTransform>(options: LatestRemotePlayersOptions = {}): NetLatestPlayer<T>[] {
    const maxAgeMs = clamp(options.maxAgeMs ?? 2000, 100, 30_000);
    const result: NetLatestPlayer<T>[] = [];
    for (const peer of this.peersById.values()) {
      const newest = this.transformBuffers.get(peer.id)?.at(-1);
      if (!newest) continue;
      const ageMs = Math.max(0, this.serverNow() - newest.ts);
      if (ageMs <= maxAgeMs) result.push({ peer, transform: { ...newest.state } as T, ts: newest.ts, ageMs });
    }
    return result;
  }
  /** @internal */ latestWorldSnapshot(): NetWorldSnapshot | null { return this.latestWorld; }

  /** @internal Use `world.yieldAuthority()`. */
  yieldHost(finalWorld: any = this.lastPublishedWorld): boolean {
    if (!this.isHost || !this.authorityGeneration || this.peers.length === 0 || this.yieldPending) return false;
    if (finalWorld !== undefined) this.publishWorld(finalWorld);
    this.yieldPending = true;
    this.sendFrame({
      t: "yield-host", generation: this.authorityGeneration, epoch: this.authorityEpoch,
    }, true);
    return true;
  }
  /** @internal */ ping(): void {
    this.lastPingTs = Date.now();
    this.sendFrame({ t: "ping", ts: this.lastPingTs }, true);
  }
  close(): void {
    this.manuallyClosed = true;
    this.rejectStorageRequests();
    this.flushPlayerState();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.playerStateTimer) clearInterval(this.playerStateTimer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.visibilityHandler);
    if (typeof window !== "undefined") window.removeEventListener("online", this.onlineHandler);
    this.worldSync?.dispose();
    try { this.socket?.close(1000, "client left"); } catch { /* closing */ }
    this.setStatus(NET_STATUS.CLOSED, null);
  }

  private emitEvent(to: string | null, type: string, data: any): string {
    const eventType = String(type).trim().slice(0, 64);
    if (!eventType) throw new ThreadSiteNetError("Event type is required.", "bad_event");
    this.eventCounter += 1;
    const id = `${this.cid ?? "anon"}.${this.eventInstance}.${this.eventCounter.toString(36)}`.slice(0, 128);
    const frame: WireFrame = { t: "event", id, e: eventType, d: data };
    if (to !== null) frame.to = to;
    const event = { id, frame, expiresAt: Date.now() + this.eventTtlMs, retried: false };
    this.recentEvents.push(event);
    while (this.recentEvents.length > RECENT_EVENTS) this.recentEvents.shift();
    this.sendReliable(event);
    return id;
  }
  private queuePlayerState(state: any, transformTick: number | null, reset: boolean): void {
    this.pendingPlayerState = { state, transformTick, reset };
    if (this.playerStateTimer) return;
    this.flushPlayerState();
    this.playerStateTimer = setInterval(() => this.flushPlayerState(), this.transformIntervalMs);
  }
  private sendReliable(item: ReliableFrame): void {
    if (Date.now() >= item.expiresAt) return;
    if (this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.pruneOutbox();
      if (this.outbox.length >= OUTBOX_LIMIT) this.outbox.shift();
      this.outbox.push(item);
      return;
    }
    this.sendFrame(item.frame, true);
  }
  private sendFrame(frame: WireFrame, transient: boolean): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      if (!transient) this.sendReliable({ frame, expiresAt: Date.now() + this.eventTtlMs });
      return;
    }
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.droppedTransient += 1;
      return;
    }
    let payload: string;
    try { payload = JSON.stringify(frame); }
    catch (error) { throw new ThreadSiteNetError("Frame is not JSON-serializable.", "bad_frame", error); }
    const size = byteLength(payload);
    if (size > MAX_FRAME_BYTES) throw new ThreadSiteNetError(`Frame is ${size} bytes; keep frames under ${MAX_FRAME_BYTES}.`, "frame_too_large");
    if (!this.takeSendToken() && (frame.t === "pstate" || frame.t === "world")) {
      // The high-rate periodic frames pace down first; reliable events are
      // rare and must not be silently lost.
      this.budgetDroppedFrames += 1;
      const now = Date.now();
      if (now - this.lastBudgetWarnAt > 5000) {
        this.lastBudgetWarnAt = now;
        console.warn(`[threadsite-net] send budget reached (${SEND_BUDGET_PER_SECOND}/s sustained): dropping ${frame.t} frames — reduce transformHz/publishHz or event volume`);
      }
      return;
    }
    if (frame.t === "world") this.lastWorldBytesValue = size;
    try { this.socket.send(payload); }
    catch (error) { throw new ThreadSiteNetError("Send failed; the connection is closing.", "send_failed", error); }
  }

  /** @internal Token bucket pacing sends just under the relay's frame limiter. */
  private takeSendToken(): boolean {
    const now = Date.now();
    this.sendTokens = Math.min(SEND_BUDGET_BURST, this.sendTokens + (now - this.sendTokensUpdatedAt) * SEND_BUDGET_PER_SECOND / 1000);
    this.sendTokensUpdatedAt = now;
    if (this.sendTokens < 1) return false;
    this.sendTokens -= 1;
    return true;
  }

  /** @internal Track measured complete-world cadence for `net.stats`. */
  private noteWorldFrame(): void {
    const now = Date.now();
    if (this.lastWorldArrivalAt !== null) {
      const gap = now - this.lastWorldArrivalAt;
      if (gap > 0 && gap < 2000) this.worldIntervalMs = this.worldIntervalMs === 0 ? gap : this.worldIntervalMs + (gap - this.worldIntervalMs) * 0.2;
    }
    this.lastWorldArrivalAt = now;
  }

  private connectSocket(): void {
    if (this.manuallyClosed) return;
    this.setStatus(this.attempt === 0 ? NET_STATUS.CONNECTING : NET_STATUS.RECONNECTING, null);
    let socket: WebSocket;
    try { socket = new WebSocket(this.url); }
    catch (error) { this.failOrRetry(new ThreadSiteNetError(`Could not open ${this.url}.`, "bad_url", error)); return; }
    this.socket = socket;
    const failTimer = setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        try { socket.close(); } catch { /* ignored */ }
        this.failOrRetry(new ThreadSiteNetError(`Relay at ${this.url} did not answer in time.`, "connect_timeout"));
      }
    }, this.connectTimeoutMs);
    socket.onopen = () => this.sendFrame({
      t: "join", v: PROTOCOL_VERSION, game: this.game, mode: this.mode,
      room: this.requestedRoom || null,
      create: this.createRoom || (!this.requestedRoom && this.mode === "rooms"),
      resume: this.hasJoined || this.resumeRequested,
      name: this.name, cid: this.cid, playerToken: this.playerIdentity.token,
    }, true);
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as WireFrame;
        if (frame && typeof frame.t === "string") {
          if (frame.t === "world" || frame.t === "world-ack") {
            this.lastWorldBytesValue = String(event.data).length;
            this.noteWorldFrame();
          }
          this.handleFrame(frame, failTimer);
        }
      } catch (error) { console.error("[threadsite-net] inbound frame failed:", error); }
    };
    socket.onclose = (event) => {
      clearTimeout(failTimer);
      this.rejectStorageRequests();
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        const wasOnline = this.id !== null;
        const lostAuthorityEpoch = this.isHost ? this.authorityEpoch : null;
        this.id = null; this.hostId = null; this.yieldPending = false;
        this.bootstrapDone = false; this.worldRestored = false;
        this.peersById.clear(); this.statesByPeer.clear(); this.transformBuffers.clear(); this.socket = null;
      if (lostAuthorityEpoch !== null) this.onAuthorityLost?.(lostAuthorityEpoch);
      if (this.manuallyClosed) { this.setStatus(NET_STATUS.CLOSED, null); return; }
      if (!wasOnline) this.failOrRetry(new ThreadSiteNetError(`Relay at ${this.url} refused the connection (${event.code}).`, "connect_failed"));
      else { this.setStatus(NET_STATUS.RECONNECTING, event.code); this.scheduleReconnect(); }
    };
    socket.onerror = () => undefined;
  }

  private handleFrame(frame: WireFrame, failTimer: Timer): void {
    switch (frame.t) {
      case "welcome": {
        this.storagePlayerId = frame.persistence?.version === 1 && typeof frame.persistence.playerId === "string" ? frame.persistence.playerId : null;
        this.id = String(frame.you); this.cid = typeof frame.cid === "string" ? frame.cid : this.cid;
        this.mode = frame.mode === "single" ? "single" : "rooms";
        this.room = this.mode === "rooms" && typeof frame.room === "string" ? frame.room : null;
        this.requestedRoom = this.room ?? ""; this.createRoom = false;
        this.hasJoined = true; this.resumeRequested = false; saveResumeRoom(this.game, this.room);
        const recoveryWorld = this.adoptGeneration(String(frame.generation ?? ""));
        this.peersById.clear(); this.statesByPeer.clear(); this.transformBuffers.clear();
        for (const raw of Array.isArray(frame.peers) ? frame.peers : []) this.acceptWelcomePeer(raw);
        if (finite(frame.serverTs)) this.serverTimeOffset = frame.serverTs - Date.now();
        const world = frame.world ? this.parseWorld(frame.world) : null;
        this.applyAuthority(frame.host ?? null, Number(frame.epoch) || 0, world, true);
        this.presence._resend();
        clearTimeout(failTimer); this.attempt = 0; this.setStatus(NET_STATUS.ONLINE, null);
        this.lastPongAt = Date.now();
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
          if (Date.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
            try { this.socket?.close(4001, "heartbeat timeout"); } catch { /* reconnect path owns cleanup */ }
            return;
          }
          this.ping();
        }, 10_000); this.ping();
        if (!this.openedSettled) { this.openedSettled = true; this.resolveOpened(this); }
        this.flushOutbox();
        // Resolve connect() first. Initial callbacks often close over the
        // `net` variable being assigned by await; synchronous delivery here
        // would hit its temporal dead zone.
        queueMicrotask(() => {
          if (world) this.acceptWorld(world, true);
          // Bootstrap completes before authority callbacks run: the world
          // lifecycle's restore-then-publish sequence must be unblocked, while
          // any earlier publish (which would wipe a restored world) throws.
          this.bootstrapDone = true;
          if (this.isHost) {
            const acquired = world ?? recoveryWorld;
            this.worldRestored = acquired !== null;
            this.authority._acquire(acquired, this.authorityEpoch);
            this.onAuthorityAcquired?.(acquired, this.authorityEpoch);
          }
          this.emitPeers();
        });
        return;
      }
      case "peer-join": {
        const peer = frame.peer as NetPeer | undefined;
        if (peer?.id) this.peersById.set(peer.id, { id: peer.id, name: peer.name ?? null, cid: peer.cid ?? null });
        this.emitPeers(); return;
      }
      case "peer-leave": this.removePeer(String(frame.id)); this.emitPeers(); return;
      case "authority": {
        const recoveryWorld = this.adoptGeneration(String(frame.generation ?? ""));
        const world = frame.world ? this.parseWorld(frame.world) : (this.latestWorld ?? recoveryWorld);
        this.applyAuthority(frame.host ?? null, Number(frame.epoch) || 0, world, false);
        if (world) this.acceptWorld(world, true); return;
      }
      case "pstate": this.acceptPlayerState(frame); return;
      case "event": this.acceptEvent(frame); return;
      case "signal": this.acceptEphemeral(frame); return;
      case "presence": this.acceptPresence(frame); return;
      case "world": { const world = this.parseWorld(frame); if (world) this.acceptWorld(world, false); return; }
      case "world-ack": { const world = this.parseWorld(frame); if (world) this.acceptWorld(world, false, false); return; }
      case "world-req": this.onWorldRequest?.(String(frame.from)); return;
      case "pong":
        this.lastPongAt = Date.now(); this.flushOutbox();
        if (finite(frame.ts) && frame.ts === this.lastPingTs) {
          this.rtt = Date.now() - frame.ts;
          if (finite(frame.serverTs)) this.serverTimeOffset = frame.serverTs + this.rtt / 2 - Date.now();
        }
        return;
      case "storage-result": {
        const request = this.storageRequests.get(frame.id);
        if (!request) return;
        clearTimeout(request.timer); this.storageRequests.delete(frame.id);
        if (frame.ok === true) request.resolve(frame.result);
        else request.reject(new ThreadSiteNetError(String(frame.message ?? "Persistence request failed."), String(frame.code ?? "storage_unavailable")));
        return;
      }
      case "error": {
        const request = this.storageRequests.get(frame.id);
        if (request) {
          clearTimeout(request.timer); this.storageRequests.delete(frame.id);
          request.reject(new ThreadSiteNetError(String(frame.message), String(frame.code)));
          return;
        }
        this.handleError(frame); return;
      }
    }
  }

  private acceptWelcomePeer(raw: WireFrame): void {
    const id = String(raw.id ?? ""); if (!id) return;
    this.peersById.set(id, { id, name: raw.name ?? null, cid: raw.cid ?? null });
    this.lastSeenByPeer.set(id, Date.now());
    if (raw.s !== undefined && raw.s !== null) this.statesByPeer.set(id, raw.s);
    if (raw.presence !== undefined && raw.presence !== null) {
      this.presence._accept({ from: id, cid: raw.cid ?? null, state: raw.presence, ts: finite(raw.presenceTs) ? raw.presenceTs : 0 });
    }
    if (isTransform(raw.s) && finite(raw.ts)) this.addTransform(id, raw.s, raw.ts, finite(raw.pt) ? raw.pt : 0, raw.pr === true);
  }
  private acceptPlayerState(frame: WireFrame): void {
    const peerId = String(frame.from ?? ""); if (!peerId || !finite(frame.ts)) return;
    this.statesByPeer.set(peerId, frame.s); this.lastSeenByPeer.set(peerId, Date.now());
    if (isTransform(frame.s) && finite(frame.pt)) this.addTransform(peerId, frame.s, frame.ts, frame.pt, frame.pr === true);
    this.onPlayerState?.({ from: peerId, cid: frame.cid ?? null, state: frame.s, ts: frame.ts });
  }
  private acceptPresence(frame: WireFrame): void {
    const from = String(frame.from ?? "");
    if (!from || !finite(frame.ts)) return;
    const presence = { from, cid: frame.cid ?? null, state: frame.s, ts: frame.ts };
    this.lastSeenByPeer.set(from, Date.now()); this.presence._accept(presence);
    this.onPresence?.(presence);
  }
  private acceptEphemeral(frame: WireFrame): void {
    const from = String(frame.from ?? "");
    const type = String(frame.e ?? "");
    if (!from || !type || !finite(frame.ts)) return;
    const event: NetEphemeralEvent = { from, cid: frame.cid ?? null, type, data: frame.d, ts: frame.ts };
    this.lastSeenByPeer.set(from, Date.now()); this.events._acceptEphemeral(event); this.onEphemeral?.(event);
  }
  private addTransform(peerId: string, state: NetTransform, ts: number, tick: number, reset = false): void {
    const buffer = reset ? [] : (this.transformBuffers.get(peerId) ?? []);
    const latest = buffer[buffer.length - 1];
    if (latest && latest.state.runId !== undefined && state.runId !== undefined && latest.state.runId !== state.runId) buffer.length = 0;
    if (latest && (tick <= latest.tick || ts < latest.ts)) return;
    const now = Date.now();
    if (this.lastTransformArrival) {
      const transitDelta = (now - this.lastTransformArrival.localTs) - (ts - this.lastTransformArrival.relayTs);
      this.jitterMs += (Math.abs(transitDelta) - this.jitterMs) * 0.1;
    }
    this.lastTransformArrival = { relayTs: ts, localTs: now };
    buffer.push({ state: { ...state }, ts, tick });
    while (buffer.length > TRANSFORM_BUFFER_SIZE || ts - (buffer[0]?.ts ?? ts) > TRANSFORM_BUFFER_WINDOW_MS) buffer.shift();
    this.transformBuffers.set(peerId, buffer);
  }
  private acceptEvent(frame: WireFrame): void {
    const id = typeof frame.id === "string" ? frame.id : "";
    const from = String(frame.from ?? "");
    const dedupeKey = `${from}\u0000${id}`;
    if (!id || !from || this.appliedEventIds.has(dedupeKey) || !finite(frame.ts)) {
      if (id && this.appliedEventIds.has(dedupeKey)) this.duplicates += 1;
      return;
    }
    this.appliedEventIds.add(dedupeKey);
    while (this.appliedEventIds.size > RECENT_EVENT_IDS) {
      const oldest = this.appliedEventIds.values().next().value as string | undefined;
      if (oldest) this.appliedEventIds.delete(oldest); else break;
    }
    this.lastSeenByPeer.set(from, Date.now());
    const event = { id, from, cid: frame.cid ?? null, type: String(frame.e ?? ""), data: frame.d, ts: frame.ts };
    this.intents._accept(event); this.events._acceptReliable(event); this.onEvent?.(event);
  }
  private parseWorld(frame: WireFrame): NetWorldSnapshot | null {
    if (!finite(frame.ts) || !finite(frame.epoch) || !finite(frame.seq)
      || typeof frame.generation !== "string" || !frame.generation || typeof frame.from !== "string") return null;
    return {
      from: frame.from, cid: frame.cid ?? null, state: frame.s, ts: frame.ts,
      authorityGeneration: frame.generation, authorityEpoch: frame.epoch, stateSeq: frame.seq,
    };
  }
  private acceptWorld(world: NetWorldSnapshot, allowPriorEpoch: boolean, emit = true): void {
    if (world.authorityGeneration !== this.authorityGeneration) return;
    const [epoch, seq] = this.latestWorldKey;
    if (!allowPriorEpoch && world.authorityEpoch < this.authorityEpoch) return;
    if (world.authorityEpoch < epoch || (world.authorityEpoch === epoch && world.stateSeq <= seq)) return;
    this.latestWorld = world; this.latestWorldKey = [world.authorityEpoch, world.stateSeq];
    if (emit) { this.world._accept(world); this.onWorld?.(world); }
  }
  private adoptGeneration(generation: string): NetWorldSnapshot | null {
    if (!generation) return null;
    if (this.authorityGeneration === null) { this.authorityGeneration = generation; return null; }
    if (this.authorityGeneration === generation) return null;
    const recovery = this.latestWorld;
    this.authorityGeneration = generation; this.authorityEpoch = 0;
    this.latestWorld = null; this.latestWorldKey = [-1, -1];
    return recovery;
  }
  private applyAuthority(hostId: string | null, epoch: number, world: NetWorldSnapshot | null, initial: boolean): void {
    if (epoch < this.authorityEpoch) return;
    const wasHost = this.isHost; const previousEpoch = this.authorityEpoch;
    this.hostId = hostId; this.authorityEpoch = epoch; this.yieldPending = false;
    const nowHost = this.isHost;
    if (!initial && wasHost && !nowHost) { this.authority._lose(previousEpoch); this.onAuthorityLost?.(previousEpoch); }
    if (!initial && !wasHost && nowHost) {
      this.worldRestored = world !== null;
      this.authority._acquire(world, epoch); this.onAuthorityAcquired?.(world, epoch);
    }
  }
  private removePeer(peerId: string): void {
    this.peersById.delete(peerId); this.statesByPeer.delete(peerId); this.lastSeenByPeer.delete(peerId);
    this.transformBuffers.delete(peerId); this.transformInfo.delete(peerId);
    this.presence._remove(peerId);
  }
  private handleError(frame: WireFrame): void {
    const code = String(frame.code ?? "error");
    const error = new ThreadSiteNetError(String(frame.message ?? "Relay rejected a frame."), code);
    if (code === "rate_limited") {
      this.rateLimited += 1; this.setStatus(NET_STATUS.DEGRADED, code); this.setStatus(NET_STATUS.ONLINE, null);
      if (typeof frame.id === "string") this.retryEvent(frame.id); return;
    }
    if (["room_not_found", "bad_version", "bad_game", "bad_room", "room_full", "too_many_rooms", "project_deleted"].includes(code)) {
      if (!this.openedSettled) { this.openedSettled = true; this.rejectOpened(error); }
      this.manuallyClosed = true; try { this.socket?.close(4000, code); } catch { /* ignored */ }
      this.setStatus(NET_STATUS.CLOSED, code); return;
    }
    console.warn("[threadsite-net]", code, error.message);
  }
  private retryEvent(id: string): void {
    const event = this.recentEvents.find((candidate) => candidate.id === id);
    if (!event || event.retried || Date.now() >= event.expiresAt) return;
    event.retried = true; event.frame.retry = true;
    setTimeout(() => this.sendReliable(event), 250);
  }
  private flushOutbox(): void {
    this.pruneOutbox(); const queued = this.outbox; this.outbox = [];
    for (const item of queued) this.sendReliable(item);
  }
  private pruneOutbox(): void { const now = Date.now(); this.outbox = this.outbox.filter((item) => item.expiresAt > now); }
  private emitPeers(): void {
    try { this.onPeers?.(this.peers); } catch (error) { console.error("[threadsite-net] onPeers failed:", error); }
  }
  private setStatus(status: NetStatus, detail: unknown): void {
    if (this.currentStatus === status) return; this.currentStatus = status;
    try { this.onStatus?.(status, detail); } catch (error) { console.error("[threadsite-net] onStatus failed:", error); }
  }
  private failOrRetry(error: ThreadSiteNetError): void {
    if (!this.openedSettled) { this.openedSettled = true; this.rejectOpened(error); }
    if (this.manuallyClosed) return;
    if (this.autoReconnect) { this.setStatus(NET_STATUS.RECONNECTING, error.code); this.scheduleReconnect(); }
    else this.setStatus(NET_STATUS.CLOSED, error.code);
  }
  private scheduleReconnect(): void {
    if (this.manuallyClosed || this.reconnectTimer) return;
    this.attempt += 1;
    const backoff = Math.min(8000, 500 * 2 ** Math.min(this.attempt, 4));
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connectSocket(); }, backoff * (0.7 + Math.random() * 0.6));
  }
}

/** Personal JSON checkpoint slots. CAS revisions prevent stale tabs overwriting newer progress. */
export class NetSaves {
  constructor(private readonly net: ThreadSiteNet) {}
  get available(): boolean { return this.net.status === NET_STATUS.ONLINE && this.net.playerId !== null; }
  /** False if storage is blocked or a caller supplies its own credential. */
  get identityPersistent(): boolean { return this.net.persistentIdentity; }
  get<T = unknown>(slot: string): Promise<NetSave<T>> {
    return this.net.storageRequest({ op: "save.get", slot });
  }
  set<T>(slot: string, value: T, revision: number): Promise<NetSave<T>> {
    return this.net.storageRequest({ op: "save.set", slot, value, revision });
  }
  delete(slot: string, revision: number): Promise<NetSave<null>> {
    return this.net.storageRequest({ op: "save.delete", slot, revision });
  }
}

/** Public per-game personal bests. Scores are client-reported, not cheat-proof. */
export class NetLeaderboards {
  constructor(private readonly net: ThreadSiteNet) {}
  submit(board: string, score: number, options: { order?: NetScoreOrder } = {}): Promise<NetScore> {
    return this.net.storageRequest({ op: "board.submit", board, score, order: options.order ?? "desc" });
  }
  list(board: string, options: { limit?: number } = {}): Promise<NetLeaderboard> {
    return this.net.storageRequest({ op: "board.list", board, limit: options.limit ?? 10 });
  }
}

/**
 * Local transform publication plus remote transform reads.
 *
 * sample*() is time-shifted for smooth rendering.
 * latest*() returns the newest received peer transform and is appropriate
 * for host gameplay checks that need the freshest observed player position.
 *
 * Peer transforms are still client-reported input: the host remains
 * authoritative over gameplay outcomes.
 */
export class NetTransforms {
  constructor(private readonly net: ThreadSiteNet) {}
  publish(transform: NetTransform): void { this.net.publishTransform(transform); }
  teleport(transform: NetTransform): void { this.net.publishTeleport(transform); }
  /**
   * Rendering-only time-shifted transform for one remote peer: interpolated
   * 45-150 ms in the past (adaptive to transit jitter), extrapolating at
   * most 100 ms past the newest sample. Never resolve gameplay from a
   * sample; see `latest()`.
   */
  sample<T extends NetTransform = NetTransform>(peerId: string, options: SampleTransformOptions = {}): T | null {
    return this.net.sampleTransform<T>(peerId, options);
  }
  /** Rendering-only sweep of live remote peers; see `sample()`. */
  sampleAll<T extends NetTransform = NetTransform>(options: SampleRemotePlayersOptions = {}): NetRemotePlayer<T>[] {
    return this.net.sampleRemotePlayers<T>(options);
  }
  /** Rendering-only alive filter over `sampleAll()`; see `sample()`. */
  listAlive<T extends NetTransform = NetTransform>(options: SampleRemotePlayersOptions = {}): NetRemotePlayer<T>[] {
    return this.sampleAll<T>(options).filter(({ transform }) => transform.alive !== false);
  }
  /** Rendering-only nearest-player query built on `listAlive()`; see `sample()`. */
  nearest<T extends NetTransform = NetTransform>(x: number, y: number, options: SampleRemotePlayersOptions = {}): NetRemotePlayer<T> | null {
    let nearest: NetRemotePlayer<T> | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of this.listAlive<T>(options)) {
      const distance = (candidate.transform.x - x) ** 2 + (candidate.transform.y - y) ** 2;
      if (distance < nearestDistance) { nearest = candidate; nearestDistance = distance; }
    }
    return nearest;
  }
  /**
   * The newest received transform for one peer — no interpolation,
   * extrapolation, or render delay.
   *
   * Use this rather than sample() for host-side AI/range/interaction checks
   * when the game does not maintain its own canonical guest-player position.
   * It is still peer-reported input, so validate it with game-specific
   * tolerances and never blindly trust claimed outcomes.
   *
   * Returns null until that peer has published a transform.
   */
  latest<T extends NetTransform = NetTransform>(peerId: string): T | null {
    return this.net.latestTransform<T>(peerId);
  }
  /**
   * Live peers with a recent newest transform.
   * Peers that have not published yet or exceed maxAgeMs are omitted.
   */
  latestAll<T extends NetTransform = NetTransform>(options: LatestRemotePlayersOptions = {}): NetLatestPlayer<T>[] {
    return this.net.latestRemotePlayers<T>(options);
  }
  flush(): void { this.net.flushPlayerState(); }
  info(peerId: string): TransformSampleInfo | null { return this.net.transformSampleInfo(peerId); }
}

export class NetAuthority {
  private readonly acquireHandlers = new Set<(snapshot: NetWorldSnapshot | null, epoch: number) => void>();
  private readonly loseHandlers = new Set<(epoch: number) => void>();
  constructor(private readonly net: ThreadSiteNet) {}
  isHost(): boolean { return this.net.isHost; }
  /**
   * False until the relay welcome — including its cached or persisted world —
   * has been processed. Authoritative publishing throws `not_ready` before
   * this flips true, so restored arenas cannot be wiped by an eager host.
   */
  get ready(): boolean { return this.net.bootstrapped; }
  epoch(): number { return this.net.authorityEpoch; }
  generation(): string | null { return this.net.authorityGeneration; }
  yield(): boolean { return this.net.worldSync?.yieldAuthority() ?? this.net.yieldHost(); }
  onAcquire(handler: (snapshot: NetWorldSnapshot | null, epoch: number) => void): Unsubscribe {
    this.acquireHandlers.add(handler); return () => this.acquireHandlers.delete(handler);
  }
  onLose(handler: (epoch: number) => void): Unsubscribe {
    this.loseHandlers.add(handler); return () => this.loseHandlers.delete(handler);
  }
  _acquire(snapshot: NetWorldSnapshot | null, epoch: number): void {
    for (const handler of this.acquireHandlers) safeCall(() => handler(snapshot, epoch), "authority acquire handler");
  }
  _lose(epoch: number): void {
    for (const handler of this.loseHandlers) safeCall(() => handler(epoch), "authority lose handler");
  }
}

export class NetWorld {
  private readonly handlers = new Set<(snapshot: NetWorldSnapshot) => void>();
  constructor(private readonly net: ThreadSiteNet) {}
  sync<T>(options: NetWorldSyncOptions<T>): NetWorldSyncController<T> { return this.net.syncWorld(options); }
  latest<T = any>(): NetWorldSnapshot<T> | null { return this.net.latestWorldSnapshot() as NetWorldSnapshot<T> | null; }
  /** The newest accepted complete world; alias of `latest()`. */
  get snapshot(): NetWorldSnapshot | null { return this.net.latestWorldSnapshot(); }
  /**
   * True when this client's host authority began from an existing snapshot
   * (relay cache or the relay's persisted arena world) rather than a fresh
   * world — check it inside `onAuthorityAcquired`/`onAuthorityStart`.
   */
  get restored(): boolean { return this.net.worldRestored; }
  get generation(): string | null { return this.net.authorityGeneration; }
  get epoch(): number { return this.net.authorityEpoch; }
  publishNow(): boolean { return this.net.worldSync?.publishNow() ?? false; }
  yieldAuthority(): boolean { return this.net.worldSync?.yieldAuthority() ?? false; }
  /** Publish one complete world immediately (host only, raw lifecycle only). */
  publish(state: any): void { this.net.publishWorld(state); }
  /** Publish a brand-new world, replacing any restored/cached one (raw lifecycle only). */
  reset(state: any): void { this.net.worldRestored = false; this.net.publishWorld(state); }
  onSnapshot<T = any>(handler: (snapshot: NetWorldSnapshot<T>) => void): Unsubscribe {
    const raw = handler as (snapshot: NetWorldSnapshot) => void;
    this.handlers.add(raw); return () => this.handlers.delete(raw);
  }
  _accept(snapshot: NetWorldSnapshot): void {
    for (const handler of this.handlers) safeCall(() => handler(snapshot), "world snapshot handler");
  }
}

export class NetClock {
  constructor(private readonly net: ThreadSiteNet) {}
  now(): number { return this.net.serverNow(); }
  after(ms: number): number { return this.now() + Math.max(0, Number(ms) || 0); }
  elapsed(startTs: number): number { return Math.max(0, this.now() - startTs); }
  remaining(targetTs: number): number { return Math.max(0, targetTs - this.now()); }
}

type Unsubscribe = () => void;
export class NetEvents {
  private readonly reliableHandlers = new Map<string, Set<(event: NetEvent) => void>>();
  private readonly ephemeralHandlers = new Map<string, Set<(event: NetEphemeralEvent) => void>>();
  private readonly ephemeralLastSent = new Map<string, number>();
  private readonly ephemeralPending = new Map<string, { type: string; data: any; peerId: string | null }>();
  private readonly ephemeralTimers = new Map<string, Timer>();
  constructor(private readonly net: ThreadSiteNet) {}
  sendReliable(type: string, data: any = null, peerId: string | null = null): string {
    return peerId ? this.net.emitTo(peerId, type, data) : this.net.emit(type, data);
  }
  sendEphemeral(type: string, data: any = null, peerId: string | null = null): void {
    const eventType = cleanTypedName(type, "event");
    const key = `${peerId ?? "*"}\u0000${eventType}`;
    const elapsed = Date.now() - (this.ephemeralLastSent.get(key) ?? 0);
    if (elapsed >= 50) { this.sendEphemeralNow(key, eventType, data, peerId); return; }
    this.ephemeralPending.set(key, { type: eventType, data, peerId });
    if (this.ephemeralTimers.has(key)) return;
    this.ephemeralTimers.set(key, setTimeout(() => {
      this.ephemeralTimers.delete(key);
      const pending = this.ephemeralPending.get(key);
      if (!pending) return;
      this.ephemeralPending.delete(key);
      this.sendEphemeralNow(key, pending.type, pending.data, pending.peerId);
    }, 50 - elapsed));
  }
  onReliable(type: string, handler: (event: NetEvent) => void): Unsubscribe {
    return addTypedHandler(this.reliableHandlers, type, handler);
  }
  onEphemeral(type: string, handler: (event: NetEphemeralEvent) => void): Unsubscribe {
    return addTypedHandler(this.ephemeralHandlers, type, handler);
  }
  _acceptReliable(event: NetEvent): void { callTypedHandlers(this.reliableHandlers, event.type, event); }
  _acceptEphemeral(event: NetEphemeralEvent): void { callTypedHandlers(this.ephemeralHandlers, event.type, event); }
  private sendEphemeralNow(key: string, type: string, data: any, peerId: string | null): void {
    this.ephemeralLastSent.set(key, Date.now());
    safeCall(() => this.net.emitEphemeral(type, data, peerId), "ephemeral send");
  }
}

export class NetIntents {
  private readonly handlers = new Map<string, Set<(intent: NetIntent) => void>>();
  constructor(private readonly net: ThreadSiteNet) {}
  send<T>(type: string, payload: T): string {
    const intentType = cleanTypedName(type, "intent");
    const runId = this.net.run.current;
    if (runId === null) throw new ThreadSiteNetError("Start/synchronize a world run before sending an intent.", "no_active_run");
    return this.net.emitToAuthority(`@intent:${intentType}`, { runId, payload });
  }
  on<T = any>(type: string, handler: (intent: NetIntent<T>) => void): Unsubscribe {
    return addTypedHandler(this.handlers, cleanTypedName(type, "intent"), handler as (intent: NetIntent) => void);
  }
  _accept(event: NetEvent): void {
    if (!event.type.startsWith("@intent:") || !this.net.isHost) return;
    const type = event.type.slice(8);
    const data = event.data as { runId?: unknown; payload?: unknown } | null;
    const currentRun = this.net.run.current;
    if (!data || currentRun === null || data.runId !== currentRun) return;
    const intent: NetIntent = {
      id: event.id, from: event.from, cid: event.cid, type,
      payload: data.payload, runId: currentRun, ts: event.ts,
    };
    callTypedHandlers(this.handlers, type, intent);
  }
}

export class NetPresence {
  private readonly remote = new Map<string, NetPresenceEntry>();
  private readonly handlers = new Set<(presence: NetPlayerState) => void>();
  private localState: any = undefined;
  constructor(private readonly net: ThreadSiteNet) {}
  set<T>(state: T): void { this.net.publishPresence(state); }
  get<T = any>(peerId: string): T | undefined { return this.remote.get(peerId)?.state as T | undefined; }
  list<T = any>(): NetPresenceEntry<T>[] { return [...this.remote.values()] as NetPresenceEntry<T>[]; }
  onChange(handler: (presence: NetPlayerState) => void): Unsubscribe {
    this.handlers.add(handler); return () => this.handlers.delete(handler);
  }
  _setLocal(state: any): void { this.localState = state; }
  _resend(): void { if (this.localState !== undefined) this.net.publishPresence(this.localState); }
  _accept(presence: NetPlayerState): void {
    this.remote.set(presence.from, { id: presence.from, cid: presence.cid, state: presence.state });
    for (const handler of this.handlers) safeCall(() => handler(presence), "presence handler");
  }
  _remove(peerId: string): void { this.remote.delete(peerId); }
}

export class NetRun {
  private currentRun: string | number | null = null;
  private currentRunTick: number | null = null;
  private readonly handlers = new Set<(change: NetRunChange) => void>();
  constructor(private readonly net: ThreadSiteNet) {}
  get current(): string | number | null { return this.currentRun ?? this.net.worldSync?.currentRunId ?? null; }
  get tick(): number | null { return this.currentRunTick ?? this.net.worldSync?.currentTick ?? null; }
  isCurrent(runId: unknown): boolean { return this.current !== null && runId === this.current; }
  onChanged(handler: (change: NetRunChange) => void): Unsubscribe {
    this.handlers.add(handler); return () => this.handlers.delete(handler);
  }
  _accept(runId: string | number, tick: number): void {
    const previous = this.currentRun;
    this.currentRun = runId; this.currentRunTick = tick;
    if (previous === runId) return;
    const change = { previous, current: runId, tick };
    for (const handler of this.handlers) safeCall(() => handler(change), "run change handler");
  }
}

export class NetEntities {
  /**
   * Register one stable-ID presentation collection. The controller owns the
   * entity map: iterate `collection.values()` for per-frame presentation and
   * do not maintain a second parallel entity map unless the game truly needs
   * one.
   */
  syncCollection<TLocal, TSnapshot>(name: string, options: NetCollectionSyncOptions<TLocal, TSnapshot>): NetCollectionSync<TLocal, TSnapshot> {
    return new NetCollectionSync(name, options);
  }
}

export class NetCollectionSync<TLocal, TSnapshot> {
  private readonly entities = new Map<string, { id: string | number; entity: TLocal }>();
  private prevSnapshot: { at: number; byId: Map<string, TSnapshot> } | null = null;
  private curSnapshot: { at: number; byId: Map<string, TSnapshot> } | null = null;
  private intervalMs = 0;
  readonly name: string;
  constructor(name: string, private readonly options: NetCollectionSyncOptions<TLocal, TSnapshot>) {
    this.name = cleanTypedName(name, "collection");
  }
  apply(snapshots: readonly TSnapshot[]): void {
    const incoming = new Map<string, TSnapshot>();
    for (const snapshot of snapshots) {
      const id = this.options.getId(snapshot);
      if (!(typeof id === "string" || finite(id))) throw new ThreadSiteNetError(`${this.name} snapshot has an invalid id.`, "bad_entity_id");
      const key = `${typeof id}:${String(id)}`;
      if (incoming.has(key)) throw new ThreadSiteNetError(`${this.name} snapshot repeats id ${String(id)}.`, "duplicate_entity_id");
      incoming.set(key, snapshot);
      const existing = this.entities.get(key);
      if (existing) this.options.update(existing.entity, snapshot, id);
      else this.entities.set(key, { id, entity: this.options.create(snapshot, id) });
    }
    for (const [key, existing] of this.entities) {
      if (incoming.has(key)) continue;
      this.options.remove(existing.entity, existing.id); this.entities.delete(key);
    }
    if (!this.options.smooth) return;
    const now = Date.now();
    if (this.curSnapshot) {
      const gap = now - this.curSnapshot.at;
      if (gap > 0 && gap < 2000) this.intervalMs = this.intervalMs === 0 ? gap : this.intervalMs + (gap - this.intervalMs) * 0.2;
    }
    this.prevSnapshot = this.curSnapshot ?? { at: now, byId: incoming };
    this.curSnapshot = { at: now, byId: incoming };
  }
  get(id: string | number): TLocal | undefined {
    this.refreshSmooth();
    return this.entities.get(`${typeof id}:${String(id)}`)?.entity;
  }
  /** All live local entities — the per-frame presentation iteration point. */
  values(): TLocal[] {
    this.refreshSmooth();
    return [...this.entities.values()].map(({ entity }) => entity);
  }
  clear(): void {
    for (const { id, entity } of this.entities.values()) this.options.remove(entity, id);
    this.entities.clear();
    this.prevSnapshot = null;
    this.curSnapshot = null;
    this.intervalMs = 0;
  }
  /**
   * Blend the smooth keys between the last two snapshots and write them onto
   * the live entities. Rendering at `now - delay` (delay tracking the measured
   * snapshot cadence) keeps every read between two authoritative positions, so
   * nothing ever snaps: new entities, missing history, and displacements past
   * `snapDistance` land unblended, everything else interpolates regardless of
   * speed. No extrapolation past the newest snapshot — a late snapshot holds
   * the newest position instead of predicting one.
   */
  private refreshSmooth(): void {
    const smooth = this.options.smooth;
    const current = this.curSnapshot;
    if (!smooth || !current) return;
    const previous = this.prevSnapshot;
    const delay = smooth.renderDelayMs !== undefined
      ? clamp(smooth.renderDelayMs, 16, 300)
      : clamp(Math.round(this.intervalMs * 1.25), 50, 200);
    const renderTs = Date.now() - delay;
    const snapDistance = smooth.snapDistance ?? 10;
    for (const [key, { entity }] of this.entities) {
      const cur = current.byId.get(key);
      if (cur == null || typeof entity !== "object" || entity === null) continue;
      const target = entity as Record<string, unknown>;
      const prev = previous?.byId.get(key);
      let alpha = 1;
      if (prev != null && previous && current.at > previous.at) {
        alpha = clamp((renderTs - previous.at) / (current.at - previous.at), 0, 1);
        if (alpha < 1) {
          let displacement = 0;
          for (const name of smooth.keys) {
            const from = Number(prev[name]);
            const to = Number(cur[name]);
            if (Number.isFinite(from) && Number.isFinite(to)) displacement += (to - from) * (to - from);
          }
          if (Math.sqrt(displacement) > snapDistance) alpha = 1;
        }
      }
      for (const name of smooth.keys) {
        const to = Number(cur[name]);
        if (!Number.isFinite(to)) continue;
        if (alpha >= 1) { target[name] = to; continue; }
        const from = Number(prev?.[name]);
        if (!Number.isFinite(from)) { target[name] = to; continue; }
        target[name] = from + (to - from) * alpha;
      }
    }
  }
}

function cleanTypedName(value: string, label: string): string {
  const name = String(value).trim().slice(0, 48);
  if (!/^[A-Za-z0-9_.:-]+$/.test(name)) throw new ThreadSiteNetError(`${label} type is invalid.`, `bad_${label}`);
  return name;
}
function addTypedHandler<T>(map: Map<string, Set<(value: T) => void>>, type: string, handler: (value: T) => void): Unsubscribe {
  const key = cleanTypedName(type, "event");
  const handlers = map.get(key) ?? new Set<(value: T) => void>();
  handlers.add(handler); map.set(key, handlers);
  return () => { handlers.delete(handler); if (!handlers.size) map.delete(key); };
}
function callTypedHandlers<T>(map: Map<string, Set<(value: T) => void>>, type: string, value: T): void {
  for (const handler of map.get(type) ?? []) safeCall(() => handler(value), `${type} handler`);
}
function safeCall(callback: () => void, label: string): void {
  try { callback(); } catch (error) { console.error(`[threadsite-net] ${label} failed:`, error); }
}

/**
 * Owns the easy-to-get-wrong authority lifecycle for a complete shared world.
 * It restores before starting a new host, publishes periodically, serves late
 * join requests, presents accepted snapshots only to guests, and stops the
 * host loop immediately when authority is lost.
 */
export class NetWorldSyncController<T = any> {
  private timer: Timer | null = null;
  private disposed = false;
  private lastPresented: { runId: string | number; tick: number } | null = null;
  private readonly previousWorld: ThreadSiteNet["onWorld"];
  private readonly previousRequest: ThreadSiteNet["onWorldRequest"];
  private readonly previousAcquired: ThreadSiteNet["onAuthorityAcquired"];
  private readonly previousLost: ThreadSiteNet["onAuthorityLost"];
  private readonly worldHandler: ThreadSiteNet["onWorld"];
  private readonly requestHandler: ThreadSiteNet["onWorldRequest"];
  private readonly acquiredHandler: ThreadSiteNet["onAuthorityAcquired"];
  private readonly lostHandler: ThreadSiteNet["onAuthorityLost"];

  constructor(private readonly net: ThreadSiteNet, private readonly options: NetWorldSyncOptions<T>) {
    if (options.schemaVersion === undefined || options.schemaVersion === null || options.schemaVersion === "") {
      throw new ThreadSiteNetError("world.schemaVersion is required.", "bad_world_sync");
    }
    this.previousWorld = net.onWorld;
    this.previousRequest = net.onWorldRequest;
    this.previousAcquired = net.onAuthorityAcquired;
    this.previousLost = net.onAuthorityLost;
    this.worldHandler = (snapshot) => {
      this.previousWorld?.(snapshot);
      if (this.net.isHost) return;
      const decoded = this.decode(snapshot, false);
      if (decoded) {
        try { this.options.present(decoded, snapshot as NetWorldSnapshot<NetWorldEnvelope<T>>); }
        catch (error) { console.error("[threadsite-net] world.present failed:", error); }
      }
    };
    this.requestHandler = (from) => {
      this.previousRequest?.(from);
      if (this.net.isHost) this.publishNow();
    };
    this.acquiredHandler = (snapshot, epoch) => {
      this.previousAcquired?.(snapshot, epoch);
      this.stopTimer();
      const decoded = snapshot ? this.decode(snapshot, true) : null;
      try {
        if (decoded && snapshot) this.options.restore(decoded, snapshot as NetWorldSnapshot<NetWorldEnvelope<T>>);
        this.options.onAuthorityStart({ epoch, recovered: decoded !== null });
      } catch (error) {
        console.error("[threadsite-net] world authority startup failed:", error);
        this.net.yieldHost();
        return;
      }
      this.publishNow();
      const interval = Math.round(1000 / clamp(Number(this.options.publishHz) || 10, 1, 30));
      this.timer = setInterval(() => this.publishNow(), interval);
    };
    this.lostHandler = (epoch) => {
      this.stopTimer();
      try { this.options.onAuthorityStop({ epoch }); }
      catch (error) { console.error("[threadsite-net] world.onAuthorityStop failed:", error); }
      this.previousLost?.(epoch);
    };
    net.onWorld = this.worldHandler;
    net.onWorldRequest = this.requestHandler;
    net.onAuthorityAcquired = this.acquiredHandler;
    net.onAuthorityLost = this.lostHandler;
  }

  get currentRunId(): string | number | null { return this.lastPresented?.runId ?? null; }
  get currentTick(): number | null { return this.lastPresented?.tick ?? null; }

  /** Publish a fresh complete world immediately when host. */
  publishNow(): boolean {
    if (this.disposed || !this.net.isHost) return false;
    const envelope = this.captureEnvelope();
    if (!envelope) return false;
    try { this.net.publishWorld(envelope); }
    catch (error) { console.error("[threadsite-net] complete-world publish failed:", error); return false; }
    this.lastPresented = { runId: envelope.runId, tick: envelope.tick };
    this.net.run._accept(envelope.runId, envelope.tick);
    return true;
  }

  /** Publish the final complete world and ask the relay to migrate authority. */
  yieldAuthority(): boolean {
    if (this.disposed || !this.net.isHost) return false;
    const envelope = this.captureEnvelope();
    if (!envelope || !this.net.yieldHost(envelope)) return false;
    this.lastPresented = { runId: envelope.runId, tick: envelope.tick };
    this.net.run._accept(envelope.runId, envelope.tick);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.stopTimer();
    if (this.net.onWorld === this.worldHandler) this.net.onWorld = this.previousWorld;
    if (this.net.onWorldRequest === this.requestHandler) this.net.onWorldRequest = this.previousRequest;
    if (this.net.onAuthorityAcquired === this.acquiredHandler) this.net.onAuthorityAcquired = this.previousAcquired;
    if (this.net.onAuthorityLost === this.lostHandler) this.net.onAuthorityLost = this.previousLost;
    if (this.net.worldSync === this) this.net.worldSync = null;
  }

  private decode(snapshot: NetWorldSnapshot, allowEqual: boolean): NetWorldState<T> | null {
    const envelope = snapshot.state as Partial<NetWorldEnvelope<T>> | null;
    if (!envelope || typeof envelope !== "object" || envelope.schemaVersion !== this.options.schemaVersion) return null;
    const world: NetWorldState<T> = { runId: envelope.runId as string | number, tick: Number(envelope.tick), state: envelope.state as T };
    if (!this.validWorld(world)) return null;
    if (!allowEqual && this.lastPresented?.runId === world.runId && world.tick <= this.lastPresented.tick) return null;
    this.lastPresented = { runId: world.runId, tick: world.tick };
    this.net.run._accept(world.runId, world.tick);
    return world;
  }
  private validWorld(world: NetWorldState<T> | null | undefined): world is NetWorldState<T> {
    if (!world || !Number.isSafeInteger(world.tick) || world.tick < 0) return false;
    if (!(typeof world.runId === "string" ? world.runId.length > 0 : finite(world.runId))) return false;
    try { return this.options.validate?.(world) !== false; }
    catch (error) { console.error("[threadsite-net] world.validate failed:", error); return false; }
  }
  private captureEnvelope(): NetWorldEnvelope<T> | null {
    let captured: NetWorldState<T>;
    try { captured = this.options.capture(); }
    catch (error) { console.error("[threadsite-net] world.capture failed:", error); return null; }
    if (!this.validWorld(captured)) {
      console.error("[threadsite-net] world.capture returned an invalid runId/tick/state.");
      return null;
    }
    return { schemaVersion: this.options.schemaVersion, ...captured };
  }
  private stopTimer(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}

function interpolateTransform(a: NetTransform, b: NetTransform, alpha: number): NetTransform {
  // Discrete fields (alive, animation, runId, string facing) switch only when
  // their sample time is reached; do not leak a future death/run transition.
  const result: NetTransform = { ...a };
  for (const key of INTERPOLATED_KEYS) {
    const av = a[key]; const bv = b[key];
    if (finite(av) && finite(bv)) result[key] = av + (bv - av) * alpha;
  }
  return result;
}
function extrapolateTransform(state: NetTransform, seconds: number): NetTransform {
  const result = { ...state };
  if (finite(state.vx)) result.x += state.vx * seconds;
  if (finite(state.vy)) result.y += state.vy * seconds;
  if (finite(state.z) && finite(state.vz)) result.z = state.z + state.vz * seconds;
  return result;
}
