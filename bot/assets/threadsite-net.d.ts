export declare const PROTOCOL_VERSION = 4;
export type NetStatus = "connecting" | "online" | "reconnecting" | "degraded" | "closed";
export type NetMode = "single" | "rooms";
export type TransformSampleMode = "interpolated" | "extrapolated" | "held";
export declare const NET_STATUS: Readonly<{
    CONNECTING: "connecting";
    ONLINE: "online";
    RECONNECTING: "reconnecting";
    DEGRADED: "degraded";
    CLOSED: "closed";
}>;
export interface NetPeer {
    id: string;
    name: string | null;
    cid: string | null;
}
export interface NetPlayerState<T = any> {
    from: string;
    cid: string | null;
    state: T;
    ts: number;
}
export interface NetEvent<T = any> {
    id: string;
    from: string;
    cid: string | null;
    type: string;
    data: T;
    ts: number;
}
export interface NetEphemeralEvent<T = any> {
    from: string;
    cid: string | null;
    type: string;
    data: T;
    ts: number;
}
export interface NetIntent<T = any> {
    id: string;
    from: string;
    cid: string | null;
    type: string;
    payload: T;
    runId: string | number;
    ts: number;
}
export interface NetRunChange {
    previous: string | number | null;
    current: string | number;
    tick: number;
}
export interface NetWorldSnapshot<T = any> {
    from: string;
    cid: string | null;
    state: T;
    ts: number;
    authorityGeneration: string;
    authorityEpoch: number;
    stateSeq: number;
}
export interface NetPlayerStateEntry<T = any> {
    id: string;
    cid: string | null;
    state: T;
}
export interface NetPresenceEntry<T = any> {
    id: string;
    cid: string | null;
    state: T;
}
export interface NetSave<T = unknown> {
    value: T | null;
    revision: number;
    updatedAt: number | null;
}
/** Engine-neutral 2D/3D transform. Extra game fields pass through unchanged. */
export interface NetTransform {
    x: number;
    y: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    rotation?: number;
    angle?: number;
    facing?: number | string;
    alive?: boolean;
    runId?: string | number;
    [key: string]: any;
}
export interface TransformSampleInfo {
    mode: TransformSampleMode;
    renderTs: number;
    sourceTs: number;
    ageMs: number;
    samples: number;
}
export interface SampleTransformOptions {
    /** Override the adaptive 45-150 ms interpolation delay. */
    renderDelayMs?: number;
    /** Maximum velocity extrapolation when packets arrive late. Default 100 ms. */
    maxExtrapolationMs?: number;
}
export interface NetRemotePlayer<T extends NetTransform = NetTransform> {
    peer: NetPeer;
    transform: T;
    sample: TransformSampleInfo;
}
export interface SampleRemotePlayersOptions extends SampleTransformOptions {
    /** Hide a live peer whose transform stream has been silent this long. Default 2000 ms. */
    maxAgeMs?: number;
}
/** A live peer with its newest received transform: no interpolation or render delay. */
export interface NetLatestPlayer<T extends NetTransform = NetTransform> {
    peer: NetPeer;
    transform: T;
    ts: number;
    ageMs: number;
}
export interface LatestRemotePlayersOptions {
    /** Hide a live peer whose transform stream has been silent this long. Default 2000 ms. */
    maxAgeMs?: number;
}
export interface NetWorldState<T = any> {
    runId: string | number;
    tick: number;
    state: T;
}
export interface NetWorldEnvelope<T = any> extends NetWorldState<T> {
    schemaVersion: string | number;
}
export interface NetWorldSyncOptions<T = any> {
    /** Bump when the complete snapshot shape changes. Mismatched snapshots are ignored. */
    schemaVersion: string | number;
    /** Capture the complete authoritative world. Called only while this client is host. */
    capture: () => NetWorldState<T>;
    /** Restore a complete snapshot before authoritative simulation starts or resumes. */
    restore: (world: NetWorldState<T>, snapshot: NetWorldSnapshot<NetWorldEnvelope<T>>) => void;
    /** Apply a complete accepted snapshot to guest presentation (never to host simulation). */
    present: (world: NetWorldState<T>, snapshot: NetWorldSnapshot<NetWorldEnvelope<T>>) => void;
    onAuthorityStart: (context: {
        epoch: number;
        recovered: boolean;
    }) => void;
    onAuthorityStop: (context: {
        epoch: number;
    }) => void;
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
export type AuthoritativeSessionOptions<T = any> = Omit<ThreadSiteNetOptions, "world" | "mode" | "onWorld" | "onWorldRequest" | "onAuthorityAcquired" | "onAuthorityLost"> & {
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
    /** Automatically yield host authority when the tab is hidden. Default true.
     * The yield also fires when a peer joins an already-hidden host and is
     * retried until it is actually sent, so a hidden tab never keeps authority
     * over waiting peers — but hands off at most once per hidden period, so
     * hidden tabs cannot ping-pong authority between each other.
     */
    autoYieldOnHidden?: boolean;
    /** Safe, high-level complete-world replication lifecycle. */
    world?: NetWorldSyncOptions;
    onStatus?: ((status: NetStatus, detail: unknown) => void) | null;
    onPeers?: ((peers: NetPeer[]) => void) | null;
}
export declare class ThreadSiteNetError extends Error {
    readonly code: string;
    cause?: unknown;
    net?: ThreadSiteNet;
    constructor(message: string, code?: string, cause?: unknown);
}
export declare class ThreadSiteNet {
    static roomFromUrl(): string | null;
    static connect(options?: ThreadSiteNetOptions): Promise<ThreadSiteNet>;
    static createAuthoritativeSession<T>(options: AuthoritativeSessionOptions<T>): Promise<ThreadSiteNet>;
    readonly opened: Promise<ThreadSiteNet>;
    readonly game: string;
    readonly url: string;
    readonly autoReconnect: boolean;
    readonly connectTimeoutMs: number;
    readonly eventTtlMs: number;
    readonly autoYieldOnHidden: boolean;
    mode: NetMode;
    requestedRoom: string;
    createRoom: boolean;
    name: string;
    onStatus: ((status: NetStatus, detail: unknown) => void) | null;
    onPeers: ((peers: NetPeer[]) => void) | null;
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
    private readonly playerIdentity;
    private storagePlayerId;
    private readonly storageRequests;
    id: string | null;
    cid: string | null;
    room: string | null;
    rtt: number | null;
    serverTimeOffset: number | null;
    duplicates: number;
    rateLimited: number;
    droppedTransient: number;
    /** Periodic frames dropped by the client-side send budget (see net.stats). */
    budgetDroppedFrames: number;
    private worldIntervalMs;
    private lastWorldArrivalAt;
    private lastWorldBytesValue;
    private sendTokens;
    private sendTokensUpdatedAt;
    private lastBudgetWarnAt;
    private readonly transformIntervalMs;
    private readonly peersById;
    private readonly statesByPeer;
    private readonly lastSeenByPeer;
    private readonly transformBuffers;
    private readonly transformInfo;
    private readonly appliedEventIds;
    private readonly recentEvents;
    private outbox;
    private eventCounter;
    private readonly eventInstance;
    private transformTick;
    private pendingPlayerState;
    private playerStateTimer;
    private socket;
    private currentStatus;
    private attempt;
    private reconnectTimer;
    private heartbeatTimer;
    private lastPingTs;
    private lastPongAt;
    private manuallyClosed;
    private openedSettled;
    private resolveOpened;
    private rejectOpened;
    private latestWorld;
    private latestWorldKey;
    private lastPublishedWorld;
    private jitterMs;
    private lastTransformArrival;
    /** True once the welcome's cached world and authority have been processed. */
    private bootstrapDone;
    private readonly visibilityHandler;
    private readonly onlineHandler;
    private resumeRequested;
    private hasJoined;
    private yieldPending;
    private hiddenYieldDone;
    private metronome;
    private reconnectDueAt;
    constructor(options?: ThreadSiteNetOptions);
    get status(): NetStatus;
    /** Public leaderboard identity; separate from live peer IDs and never a credential. */
    get playerId(): string | null;
    private rejectStorageRequests;
    /**
     * Live link diagnostics for HUD display: round-trip, transit jitter, peer
     * count, measured complete-world cadence, last world-frame size, and
     * send-budget drops. Surface it (or a subset) near the clock so lag reports
     * can be triaged at a glance.
     */
    get stats(): NetLinkStats;
    /**
     * True once the relay welcome has been fully processed, including its cached
     * world snapshot and initial authority. Authoritative publishing stays
     * blocked (`not_ready`) until then, so a freshly elected host can never
     * overwrite a persisted/restored world before restoring it.
     */
    get bootstrapped(): boolean;
    get peers(): NetPeer[];
    get playerStates(): NetPlayerStateEntry[];
    get queued(): number;
    peerState(peerId: string): any;
    peerLastSeen(peerId: string): number | null;
    isStale(peerId: string, maxAgeMs?: number): boolean;
    inviteUrl(): string | null;
    /**
     * A hidden tab must not keep authority while peers wait. One sent yield per
     * hidden period: the background tick retries until a yield actually goes
     * out, then stops — repeated handoffs would ping-pong authority between
     * hidden tabs. Becoming visible or a peer joining re-arms the handoff.
     */
    private maybeYieldForHiddenTab;
    /** Foreground return: refresh liveness and shared state immediately. */
    private resumeFromHiddenTab;
    /**
     * One-second supervisor behind the worker metronome. Visible tabs need
     * nothing here — their own intervals already run at full rate. A hidden
     * tab's throttled timers would otherwise stall the authority-yield retry,
     * the heartbeat and reconnect backoff, so this compensates while hidden.
     */
    private backgroundTick;
    close(): void;
    private emitEvent;
    private queuePlayerState;
    private sendReliable;
    private sendFrame;
    private connectSocket;
    private handleFrame;
    private acceptWelcomePeer;
    private acceptPlayerState;
    private acceptPresence;
    private acceptEphemeral;
    private addTransform;
    private acceptEvent;
    private parseWorld;
    private acceptWorld;
    private adoptGeneration;
    private applyAuthority;
    private removePeer;
    private handleError;
    private retryEvent;
    private flushOutbox;
    private pruneOutbox;
    private emitPeers;
    private setStatus;
    private failOrRetry;
    private scheduleReconnect;
}
/** Personal JSON checkpoint slots. CAS revisions prevent stale tabs overwriting newer progress. */
export declare class NetSaves {
    private readonly net;
    constructor(net: ThreadSiteNet);
    get available(): boolean;
    /** False if storage is blocked or a caller supplies its own credential. */
    get identityPersistent(): boolean;
    get<T = unknown>(slot: string): Promise<NetSave<T>>;
    set<T>(slot: string, value: T, revision: number): Promise<NetSave<T>>;
    delete(slot: string, revision: number): Promise<NetSave<null>>;
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
export declare class NetTransforms {
    private readonly net;
    constructor(net: ThreadSiteNet);
    publish(transform: NetTransform): void;
    teleport(transform: NetTransform): void;
    /**
     * Rendering-only time-shifted transform for one remote peer: interpolated
     * 45-150 ms in the past (adaptive to transit jitter), extrapolating at
     * most 100 ms past the newest sample. Never resolve gameplay from a
     * sample; see `latest()`.
     */
    sample<T extends NetTransform = NetTransform>(peerId: string, options?: SampleTransformOptions): T | null;
    /** Rendering-only sweep of live remote peers; see `sample()`. */
    sampleAll<T extends NetTransform = NetTransform>(options?: SampleRemotePlayersOptions): NetRemotePlayer<T>[];
    /** Rendering-only alive filter over `sampleAll()`; see `sample()`. */
    listAlive<T extends NetTransform = NetTransform>(options?: SampleRemotePlayersOptions): NetRemotePlayer<T>[];
    /** Rendering-only nearest-player query built on `listAlive()`; see `sample()`. */
    nearest<T extends NetTransform = NetTransform>(x: number, y: number, options?: SampleRemotePlayersOptions): NetRemotePlayer<T> | null;
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
    latest<T extends NetTransform = NetTransform>(peerId: string): T | null;
    /**
     * Live peers with a recent newest transform.
     * Peers that have not published yet or exceed maxAgeMs are omitted.
     */
    latestAll<T extends NetTransform = NetTransform>(options?: LatestRemotePlayersOptions): NetLatestPlayer<T>[];
    flush(): void;
    info(peerId: string): TransformSampleInfo | null;
}
export declare class NetAuthority {
    private readonly net;
    private readonly acquireHandlers;
    private readonly loseHandlers;
    constructor(net: ThreadSiteNet);
    isHost(): boolean;
    /**
     * False until the relay welcome — including its cached or persisted world —
     * has been processed. Authoritative publishing throws `not_ready` before
     * this flips true, so restored arenas cannot be wiped by an eager host.
     */
    get ready(): boolean;
    epoch(): number;
    generation(): string | null;
    yield(): boolean;
    onAcquire(handler: (snapshot: NetWorldSnapshot | null, epoch: number) => void): Unsubscribe;
    onLose(handler: (epoch: number) => void): Unsubscribe;
    _acquire(snapshot: NetWorldSnapshot | null, epoch: number): void;
    _lose(epoch: number): void;
}
export declare class NetWorld {
    private readonly net;
    private readonly handlers;
    constructor(net: ThreadSiteNet);
    sync<T>(options: NetWorldSyncOptions<T>): NetWorldSyncController<T>;
    latest<T = any>(): NetWorldSnapshot<T> | null;
    /** The newest accepted complete world; alias of `latest()`. */
    get snapshot(): NetWorldSnapshot | null;
    /**
     * True when this client's host authority began from an existing snapshot
     * (relay cache or the relay's persisted arena world) rather than a fresh
     * world — check it inside `onAuthorityAcquired`/`onAuthorityStart`.
     */
    get restored(): boolean;
    get generation(): string | null;
    get epoch(): number;
    publishNow(): boolean;
    yieldAuthority(): boolean;
    /** Publish one complete world immediately (host only, raw lifecycle only). */
    publish(state: any): void;
    /** Publish a brand-new world, replacing any restored/cached one (raw lifecycle only). */
    reset(state: any): void;
    onSnapshot<T = any>(handler: (snapshot: NetWorldSnapshot<T>) => void): Unsubscribe;
    _accept(snapshot: NetWorldSnapshot): void;
}
export declare class NetClock {
    private readonly net;
    constructor(net: ThreadSiteNet);
    now(): number;
    after(ms: number): number;
    elapsed(startTs: number): number;
    remaining(targetTs: number): number;
}
type Unsubscribe = () => void;
export declare class NetEvents {
    private readonly net;
    private readonly reliableHandlers;
    private readonly ephemeralHandlers;
    private readonly ephemeralLastSent;
    private readonly ephemeralPending;
    private readonly ephemeralTimers;
    constructor(net: ThreadSiteNet);
    sendReliable(type: string, data?: any, peerId?: string | null): string;
    sendEphemeral(type: string, data?: any, peerId?: string | null): void;
    onReliable(type: string, handler: (event: NetEvent) => void): Unsubscribe;
    onEphemeral(type: string, handler: (event: NetEphemeralEvent) => void): Unsubscribe;
    _acceptReliable(event: NetEvent): void;
    _acceptEphemeral(event: NetEphemeralEvent): void;
    private sendEphemeralNow;
}
export declare class NetIntents {
    private readonly net;
    private readonly handlers;
    constructor(net: ThreadSiteNet);
    send<T>(type: string, payload: T): string;
    on<T = any>(type: string, handler: (intent: NetIntent<T>) => void): Unsubscribe;
    _accept(event: NetEvent): void;
}
export declare class NetPresence {
    private readonly net;
    private readonly remote;
    private readonly handlers;
    private localState;
    constructor(net: ThreadSiteNet);
    set<T>(state: T): void;
    get<T = any>(peerId: string): T | undefined;
    list<T = any>(): NetPresenceEntry<T>[];
    onChange(handler: (presence: NetPlayerState) => void): Unsubscribe;
    _setLocal(state: any): void;
    _resend(): void;
    _accept(presence: NetPlayerState): void;
    _remove(peerId: string): void;
}
export declare class NetRun {
    private readonly net;
    private currentRun;
    private currentRunTick;
    private readonly handlers;
    constructor(net: ThreadSiteNet);
    get current(): string | number | null;
    get tick(): number | null;
    isCurrent(runId: unknown): boolean;
    onChanged(handler: (change: NetRunChange) => void): Unsubscribe;
    _accept(runId: string | number, tick: number): void;
}
export declare class NetEntities {
    /**
     * Register one stable-ID presentation collection. The controller owns the
     * entity map: iterate `collection.values()` for per-frame presentation and
     * do not maintain a second parallel entity map unless the game truly needs
     * one.
     */
    syncCollection<TLocal, TSnapshot>(name: string, options: NetCollectionSyncOptions<TLocal, TSnapshot>): NetCollectionSync<TLocal, TSnapshot>;
}
export declare class NetCollectionSync<TLocal, TSnapshot> {
    private readonly options;
    private readonly entities;
    private prevSnapshot;
    private curSnapshot;
    private intervalMs;
    readonly name: string;
    constructor(name: string, options: NetCollectionSyncOptions<TLocal, TSnapshot>);
    apply(snapshots: readonly TSnapshot[]): void;
    get(id: string | number): TLocal | undefined;
    /** All live local entities — the per-frame presentation iteration point. */
    values(): TLocal[];
    clear(): void;
    /**
     * Blend the smooth keys between the last two snapshots and write them onto
     * the live entities. Rendering at `now - delay` (delay tracking the measured
     * snapshot cadence) keeps every read between two authoritative positions, so
     * nothing ever snaps: new entities, missing history, and displacements past
     * `snapDistance` land unblended, everything else interpolates regardless of
     * speed. No extrapolation past the newest snapshot — a late snapshot holds
     * the newest position instead of predicting one.
     */
    private refreshSmooth;
}
/**
 * Owns the easy-to-get-wrong authority lifecycle for a complete shared world.
 * It restores before starting a new host, publishes periodically, serves late
 * join requests, presents accepted snapshots only to guests, and stops the
 * host loop immediately when authority is lost.
 */
export declare class NetWorldSyncController<T = any> {
    private readonly net;
    private readonly options;
    private timer;
    private disposed;
    private lastPresented;
    private readonly previousWorld;
    private readonly previousRequest;
    private readonly previousAcquired;
    private readonly previousLost;
    private readonly worldHandler;
    private readonly requestHandler;
    private readonly acquiredHandler;
    private readonly lostHandler;
    constructor(net: ThreadSiteNet, options: NetWorldSyncOptions<T>);
    get currentRunId(): string | number | null;
    get currentTick(): number | null;
    /** Publish a fresh complete world immediately when host. */
    publishNow(): boolean;
    /** Publish the final complete world and ask the relay to migrate authority. */
    yieldAuthority(): boolean;
    dispose(): void;
    private decode;
    private validWorld;
    private captureEnvelope;
    private stopTimer;
}
export {};
