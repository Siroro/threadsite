// ThreadSite Multiplayer Protocol v4 browser client.
// TypeScript is the source of truth; the bot build emits the zero-dependency
// threadsite-net.js and declarations vendored into generated games.
import { getPlayerIdentity } from "./threadsite-player.js";
export const PROTOCOL_VERSION = 4;
export const NET_STATUS = Object.freeze({
    CONNECTING: "connecting", ONLINE: "online", RECONNECTING: "reconnecting",
    DEGRADED: "degraded", CLOSED: "closed",
});
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
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;
// A hidden tab's reconnect setTimeout can be throttled minutes past its due
// time; the background tick fires it once it is this far overdue.
const RECONNECT_NUDGE_MS = 2_000;
const INTERPOLATED_KEYS = new Set(["x", "y", "z", "vx", "vy", "vz", "rotation", "angle", "facing"]);
const CID_STORAGE_KEY = "threadsite-session-cid-v4";
const RESUME_STORAGE_PREFIX = "threadsite-resume-room-v4:";
const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
export class ThreadSiteNetError extends Error {
    code;
    net;
    constructor(message, code = "error", cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "ThreadSiteNetError";
        this.code = code;
    }
}
function normalizeUrl(url) {
    const value = String(url ?? "").trim();
    if (!value)
        throw new ThreadSiteNetError("A relay URL is required (NET_CONFIG.url).", "bad_config");
    if (typeof location !== "undefined" && location.protocol === "https:" && value.startsWith("ws://")) {
        return `wss://${value.slice(5)}`;
    }
    return value;
}
function loadCid() {
    try {
        const existing = sessionStorage.getItem(CID_STORAGE_KEY);
        if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing))
            return existing;
        const fresh = `c-${crypto.randomUUID().replaceAll("-", "")}`;
        sessionStorage.setItem(CID_STORAGE_KEY, fresh);
        return fresh;
    }
    catch {
        try {
            return `c-${crypto.randomUUID().replaceAll("-", "")}`;
        }
        catch {
            return null;
        }
    }
}
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function isTransform(value) {
    if (!value || typeof value !== "object")
        return false;
    const transform = value;
    return finite(transform.x) && finite(transform.y);
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function byteLength(value) { return encoder?.encode(value).length ?? value.length; }
function randomToken() {
    try {
        return crypto.randomUUID().replaceAll("-", "");
    }
    catch {
        return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    }
}
function loadResumeRoom(game) {
    try {
        const value = sessionStorage.getItem(`${RESUME_STORAGE_PREFIX}${game}`);
        return value && /^[A-Z0-9]{4,12}$/.test(value) ? value : null;
    }
    catch {
        return null;
    }
}
function saveResumeRoom(game, room) {
    try {
        const key = `${RESUME_STORAGE_PREFIX}${game}`;
        if (room)
            sessionStorage.setItem(key, room);
        else
            sessionStorage.removeItem(key);
    }
    catch { /* storage is optional */ }
}
function playerIdentity(game, supplied) {
    if (supplied !== undefined && !/^[a-f0-9]{64}$/.test(supplied))
        throw new ThreadSiteNetError("playerToken must be 64 lowercase hex characters.", "bad_config");
    return getPlayerIdentity(game, supplied);
}
// Hidden tabs throttle timers down to ~1 Hz and, after a few minutes, to about
// once a minute — but worker timers keep running and posted messages still
// execute on the throttled main thread. This one-second metronome lets a
// hidden tab keep yielding host authority, heartbeating and reconnecting
// instead of freezing the room or silently decaying; a plain interval is the
// degraded fallback when workers are unavailable (Node, older engines) or
// blocked by page policy.
const METRONOME_INTERVAL_MS = 1000;
function createMetronome(onTick) {
    try {
        const source = `setInterval(() => postMessage(0), ${METRONOME_INTERVAL_MS});`;
        const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        const worker = new Worker(url);
        let disposed = false;
        let fallback = null;
        worker.onmessage = () => { if (!disposed)
            onTick(); };
        worker.onerror = () => {
            if (disposed || fallback)
                return;
            worker.terminate();
            URL.revokeObjectURL(url);
            fallback = createIntervalMetronome(onTick);
        };
        return {
            dispose() {
                disposed = true;
                worker.onmessage = null;
                worker.onerror = null;
                worker.terminate();
                URL.revokeObjectURL(url);
                fallback?.dispose();
            },
        };
    }
    catch {
        return createIntervalMetronome(onTick);
    }
}
function createIntervalMetronome(onTick) {
    const timer = setInterval(onTick, METRONOME_INTERVAL_MS);
    return { dispose() { clearInterval(timer); } };
}
export class ThreadSiteNet {
    static roomFromUrl() {
        if (typeof location === "undefined")
            return null;
        return /[#&]room=([A-Za-z0-9]{4,12})/.exec(location.hash || "")?.[1]?.toUpperCase() ?? null;
    }
    static connect(options = {}) { return new ThreadSiteNet(options).opened; }
    static createAuthoritativeSession(options) {
        return ThreadSiteNet.connect({
            ...options,
            mode: options.mode ?? "single",
            transformHz: options.transformHz ?? 25,
            world: { publishHz: options.world.publishHz ?? 10, ...options.world },
        });
    }
    opened;
    game;
    url;
    autoReconnect;
    connectTimeoutMs;
    eventTtlMs;
    autoYieldOnHidden;
    /** @internal */ worldSync;
    mode;
    requestedRoom;
    createRoom;
    name;
    onStatus;
    onPeers;
    /** @internal */ onPlayerState;
    /** @internal */ onEvent;
    /** @internal */ onEphemeral;
    /** @internal */ onPresence;
    /** @internal */ onWorld;
    /** @internal */ onWorldRequest;
    /** @internal */ onAuthorityAcquired;
    /** @internal */ onAuthorityLost;
    transforms;
    authority;
    world;
    clock;
    events;
    intents;
    presence;
    entities;
    run;
    saves;
    playerIdentity;
    storagePlayerId = null;
    storageRequests = new Map();
    id = null;
    cid = loadCid();
    room = null;
    /** @internal */ hostId = null;
    /** @internal */ authorityEpoch = 0;
    /** @internal */ authorityGeneration = null;
    rtt = null;
    serverTimeOffset = null;
    duplicates = 0;
    rateLimited = 0;
    droppedTransient = 0;
    /** Periodic frames dropped by the client-side send budget (see net.stats). */
    budgetDroppedFrames = 0;
    worldIntervalMs = 0;
    lastWorldArrivalAt = null;
    lastWorldBytesValue = null;
    sendTokens = SEND_BUDGET_BURST;
    sendTokensUpdatedAt = Date.now();
    lastBudgetWarnAt = 0;
    transformIntervalMs;
    peersById = new Map();
    statesByPeer = new Map();
    lastSeenByPeer = new Map();
    transformBuffers = new Map();
    transformInfo = new Map();
    appliedEventIds = new Set();
    recentEvents = [];
    outbox = [];
    eventCounter = 0;
    eventInstance = randomToken();
    transformTick = 0;
    pendingPlayerState = null;
    playerStateTimer = null;
    socket = null;
    currentStatus = NET_STATUS.CONNECTING;
    attempt = 0;
    reconnectTimer = null;
    heartbeatTimer = null;
    lastPingTs = 0;
    lastPongAt = 0;
    manuallyClosed = false;
    openedSettled = false;
    resolveOpened;
    rejectOpened;
    latestWorld = null;
    latestWorldKey = [-1, -1];
    lastPublishedWorld = undefined;
    jitterMs = 0;
    lastTransformArrival = null;
    /** True once the welcome's cached world and authority have been processed. */
    bootstrapDone = false;
    /** @internal True when this client's host authority began from an existing snapshot. */
    worldRestored = false;
    visibilityHandler;
    onlineHandler;
    resumeRequested = false;
    hasJoined = false;
    yieldPending = false;
    hiddenYieldDone = false;
    metronome = null;
    reconnectDueAt = 0;
    constructor(options = {}) {
        const game = String(options.game ?? "").trim();
        if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(game)) {
            throw new ThreadSiteNetError(`Invalid game id '${game}': use NET_CONFIG.game unchanged.`, "bad_config");
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
            if (document.hidden)
                this.maybeYieldForHiddenTab();
            else
                this.resumeFromHiddenTab();
        };
        this.onlineHandler = () => {
            if (this.manuallyClosed || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING)
                return;
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }
            this.connectSocket();
        };
        if (typeof document !== "undefined")
            document.addEventListener("visibilitychange", this.visibilityHandler);
        if (typeof window !== "undefined")
            window.addEventListener("online", this.onlineHandler);
        this.metronome = createMetronome(() => this.backgroundTick());
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
        this.worldSync = null;
        if (options.world)
            this.syncWorld(options.world);
        this.connectSocket();
    }
    get status() { return this.currentStatus; }
    /** Public leaderboard identity; separate from live peer IDs and never a credential. */
    get playerId() { return this.storagePlayerId; }
    /** @internal */ get persistentIdentity() { return this.playerIdentity.persistent; }
    /** @internal Online RPC only. Writes are never queued or replayed after an ambiguous failure. */
    storageRequest(request) {
        if (this.manuallyClosed || this.status !== NET_STATUS.ONLINE || this.socket?.readyState !== WebSocket.OPEN) {
            return Promise.reject(new ThreadSiteNetError("Player storage requires an online relay. Keep solo play available.", "storage_offline"));
        }
        if (!this.storagePlayerId)
            return Promise.reject(new ThreadSiteNetError("A private browser identity is required for player persistence.", "identity_unavailable"));
        if (this.storageRequests.size >= 16 || this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
            return Promise.reject(new ThreadSiteNetError("Too many outstanding requests or a busy connection.", "storage_busy"));
        }
        const id = `storage.${this.eventInstance}.${++this.eventCounter}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.storageRequests.delete(id);
                reject(new ThreadSiteNetError("Storage acknowledgement timed out. Read the save before retrying a write.", "storage_uncertain"));
            }, 10_000);
            this.storageRequests.set(id, { resolve, reject, timer });
            try {
                this.sendFrame({ ...request, t: "storage", id }, true);
            }
            catch (error) {
                clearTimeout(timer);
                this.storageRequests.delete(id);
                reject(error);
            }
        });
    }
    rejectStorageRequests() {
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
    get stats() {
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
    get bootstrapped() { return this.bootstrapDone; }
    get peers() { return [...this.peersById.values()]; }
    get playerStates() {
        return [...this.statesByPeer].map(([id, state]) => ({ id, cid: this.peersById.get(id)?.cid ?? null, state }));
    }
    /** @internal */ get isHost() { return this.id !== null && this.hostId === this.id; }
    get queued() { this.pruneOutbox(); return this.outbox.length; }
    peerState(peerId) { return this.statesByPeer.get(peerId); }
    peerLastSeen(peerId) { return this.lastSeenByPeer.get(peerId) ?? null; }
    isStale(peerId, maxAgeMs = 5000) {
        const lastSeen = this.lastSeenByPeer.get(peerId);
        return lastSeen === undefined || Date.now() - lastSeen > maxAgeMs;
    }
    /** @internal */ serverNow() { return Date.now() + (this.serverTimeOffset ?? 0); }
    inviteUrl() {
        if (typeof location === "undefined" || this.mode === "single" || !this.room)
            return null;
        return `${location.origin}${location.pathname}${location.search}#room=${this.room}`;
    }
    /** @internal Install through `world.sync()` or the authoritative-session preset. */
    syncWorld(options) {
        if (this.worldSync)
            throw new ThreadSiteNetError("World synchronization is already configured.", "world_sync_exists");
        if (this.onWorld || this.onWorldRequest || this.onAuthorityAcquired || this.onAuthorityLost) {
            throw new ThreadSiteNetError("Clear raw world/authority callbacks before installing world synchronization.", "bad_world_sync");
        }
        const controller = new NetWorldSyncController(this, options);
        this.worldSync = controller;
        return controller;
    }
    /** @internal Use `events.sendReliable()`. */
    emit(type, data = null) { return this.emitEvent(null, type, data); }
    /** @internal Use `events.sendReliable()`. */
    emitTo(peerId, type, data = null) {
        if (!this.peersById.has(peerId) && peerId !== this.id)
            throw new ThreadSiteNetError(`Peer ${peerId} is not connected.`, "bad_target");
        return this.emitEvent(peerId, type, data);
    }
    /** @internal Used by the intent facade. */
    emitToAuthority(type, data = null) {
        if (!this.hostId)
            throw new ThreadSiteNetError("No authoritative host is connected.", "no_host");
        return this.emitEvent("@host", type, data);
    }
    /** @internal Use `events.sendEphemeral()`. */
    emitEphemeral(type, data = null, peerId = null) {
        const eventType = String(type).trim().slice(0, 64);
        if (!eventType)
            throw new ThreadSiteNetError("Ephemeral event type is required.", "bad_signal");
        if (peerId !== null && !this.peersById.has(peerId) && peerId !== this.id) {
            throw new ThreadSiteNetError(`Peer ${peerId} is not connected.`, "bad_target");
        }
        const frame = { t: "signal", e: eventType, d: data };
        if (peerId !== null)
            frame.to = peerId;
        this.sendFrame(frame, true);
    }
    /** @internal Use `presence.set()`. */
    publishPresence(state) {
        this.presence._setLocal(state ?? null);
        this.sendFrame({ t: "presence", s: state ?? null }, true);
    }
    /** @internal Complete worlds are owned by the world lifecycle. */
    publishWorld(state) {
        if (!this.bootstrapDone) {
            throw new ThreadSiteNetError("Bootstrap is not complete; process the welcome world (restore it in onAuthorityAcquired/onAuthorityStart) before publishing.", "not_ready");
        }
        if (!this.isHost)
            throw new ThreadSiteNetError("Only the current host may publish world state.", "not_host");
        if (!this.authorityGeneration)
            throw new ThreadSiteNetError("No active room generation is available.", "stale_authority");
        // Latch only a world the relay actually received: a dropped or refused
        // frame must not become the "final world" a later yield republishes.
        if (this.sendFrame({
            t: "world", generation: this.authorityGeneration,
            epoch: this.authorityEpoch, s: state ?? null,
        }, true))
            this.lastPublishedWorld = state ?? null;
    }
    /** @internal World requests are automatic. */
    requestWorld() { this.sendFrame({ t: "world-req" }, true); }
    /** @internal Use transforms or presence. */
    publishPlayerState(state) { this.queuePlayerState(state ?? null, null, false); }
    /** @internal Use `transforms.publish()`. */
    publishTransform(transform) {
        if (!isTransform(transform))
            throw new ThreadSiteNetError("publishTransform requires finite x and y.", "bad_transform");
        this.transformTick += 1;
        this.queuePlayerState({ ...transform }, this.transformTick, false);
    }
    /** @internal Use `transforms.teleport()`. */
    publishTeleport(transform) {
        if (!isTransform(transform))
            throw new ThreadSiteNetError("publishTeleport requires finite x and y.", "bad_transform");
        this.transformTick += 1;
        this.queuePlayerState({ ...transform }, this.transformTick, true);
        this.flushPlayerState();
    }
    /** @internal */ flushPlayerState() {
        const pending = this.pendingPlayerState;
        if (!pending)
            return;
        this.pendingPlayerState = null;
        const frame = { t: "pstate", s: pending.state };
        if (pending.transformTick !== null)
            frame.pt = pending.transformTick;
        if (pending.reset)
            frame.pr = true;
        this.sendFrame(frame, true);
    }
    /** @internal Use `transforms.sample()`. */
    sampleTransform(peerId, options = {}) {
        const buffer = this.transformBuffers.get(peerId);
        if (!buffer?.length)
            return null;
        // Remote motion is rendered one interpolation window behind relay time:
        // at least 45 ms (tight on low-jitter links, where the old 100 ms floor
        // read as lag) growing with measured transit jitter, hard-capped at 150.
        const delay = options.renderDelayMs === undefined ? clamp(45 + this.jitterMs * 3, 45, 150) : clamp(options.renderDelayMs, 0, 500);
        const renderTs = this.serverNow() - delay;
        const maxExtrapolation = clamp(options.maxExtrapolationMs ?? DEFAULT_MAX_EXTRAPOLATION_MS, 0, 250);
        let before;
        let after;
        for (const point of buffer) {
            if (point.ts <= renderTs)
                before = point;
            if (point.ts >= renderTs) {
                after = point;
                break;
            }
        }
        let result;
        let mode;
        let sourceTs;
        if (before && after && before !== after && after.ts > before.ts) {
            const alpha = clamp((renderTs - before.ts) / (after.ts - before.ts), 0, 1);
            result = interpolateTransform(before.state, after.state, alpha);
            mode = "interpolated";
            sourceTs = renderTs;
        }
        else {
            const latest = before ?? after ?? buffer[buffer.length - 1];
            if (!latest)
                return null;
            const extrapolation = clamp(renderTs - latest.ts, 0, maxExtrapolation);
            result = extrapolation > 0 ? extrapolateTransform(latest.state, extrapolation / 1000) : { ...latest.state };
            mode = extrapolation > 0 ? "extrapolated" : "held";
            sourceTs = latest.ts;
        }
        this.transformInfo.set(peerId, {
            mode, renderTs, sourceTs,
            ageMs: Math.max(0, this.serverNow() - (buffer[buffer.length - 1]?.ts ?? sourceTs)), samples: buffer.length,
        });
        return result;
    }
    /** @internal */ transformSampleInfo(peerId) { return this.transformInfo.get(peerId) ?? null; }
    /** @internal Use `transforms.sampleAll()`. */
    sampleRemotePlayers(options = {}) {
        const maxAgeMs = clamp(options.maxAgeMs ?? 2000, 100, 30_000);
        const result = [];
        for (const peer of this.peersById.values()) {
            const transform = this.sampleTransform(peer.id, options);
            const sample = this.transformSampleInfo(peer.id);
            if (transform && sample && sample.ageMs <= maxAgeMs)
                result.push({ peer, transform, sample });
        }
        return result;
    }
    /** @internal Use `transforms.latest()`. */
    latestTransform(peerId) {
        const newest = this.transformBuffers.get(peerId)?.at(-1);
        return newest ? { ...newest.state } : null;
    }
    /** @internal Use `transforms.latestAll()`. */
    latestRemotePlayers(options = {}) {
        const maxAgeMs = clamp(options.maxAgeMs ?? 2000, 100, 30_000);
        const result = [];
        for (const peer of this.peersById.values()) {
            const newest = this.transformBuffers.get(peer.id)?.at(-1);
            if (!newest)
                continue;
            const ageMs = Math.max(0, this.serverNow() - newest.ts);
            if (ageMs <= maxAgeMs)
                result.push({ peer, transform: { ...newest.state }, ts: newest.ts, ageMs });
        }
        return result;
    }
    /** @internal */ latestWorldSnapshot() { return this.latestWorld; }
    /**
     * A hidden tab must not keep authority while peers wait. One sent yield per
     * hidden period: the background tick retries until a yield actually goes
     * out, then stops — repeated handoffs would ping-pong authority between
     * hidden tabs. Becoming visible or a peer joining re-arms the handoff.
     */
    maybeYieldForHiddenTab() {
        if (!this.autoYieldOnHidden || this.hiddenYieldDone)
            return;
        if (typeof document === "undefined" || !document.hidden || !this.isHost || this.peers.length === 0)
            return;
        if (this.yieldHost())
            this.hiddenYieldDone = true;
    }
    /** Foreground return: refresh liveness and shared state immediately. */
    resumeFromHiddenTab() {
        this.hiddenYieldDone = false;
        if (this.socket?.readyState === WebSocket.OPEN)
            this.ping();
        this.worldSync?.publishNow();
    }
    /**
     * One-second supervisor behind the worker metronome. Visible tabs need
     * nothing here — their own intervals already run at full rate. A hidden
     * tab's throttled timers would otherwise stall the authority-yield retry,
     * the heartbeat and reconnect backoff, so this compensates while hidden.
     */
    backgroundTick() {
        if (this.manuallyClosed)
            return;
        if (typeof document === "undefined" || !document.hidden)
            return;
        this.maybeYieldForHiddenTab();
        if (this.socket?.readyState === WebSocket.OPEN) {
            if (Date.now() - this.lastPingTs >= HEARTBEAT_INTERVAL_MS)
                this.ping();
            return;
        }
        if (this.currentStatus === NET_STATUS.RECONNECTING && this.reconnectTimer
            && Date.now() >= this.reconnectDueAt + RECONNECT_NUDGE_MS) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
            this.connectSocket();
        }
    }
    /** @internal Use `world.yieldAuthority()`. Never throws: an unsent yield
     * must not latch, so the visibility change, a joining peer or the background
     * tick retries until the frame actually goes out. */
    yieldHost(finalWorld = this.lastPublishedWorld) {
        if (!this.isHost || !this.authorityGeneration || this.peers.length === 0 || this.yieldPending)
            return false;
        // A full send buffer silently drops transient frames; refusing here keeps
        // the yield unlatched for the retry once the buffer drains.
        if (this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > MAX_BUFFERED_BYTES)
            return false;
        try {
            if (finalWorld !== undefined)
                this.publishWorld(finalWorld);
        }
        catch (error) {
            // The final world is best-effort; waiting peers must still get authority.
            console.warn("[threadsite-net] final-world publish before yield failed:", error);
        }
        let sent = false;
        try {
            sent = this.sendFrame({
                t: "yield-host", generation: this.authorityGeneration, epoch: this.authorityEpoch,
            }, true);
        }
        catch (error) {
            console.warn("[threadsite-net] authority yield failed:", error);
            return false;
        }
        if (!sent)
            return false;
        this.yieldPending = true;
        return true;
    }
    /** @internal */ ping() {
        this.lastPingTs = Date.now();
        this.sendFrame({ t: "ping", ts: this.lastPingTs }, true);
    }
    close() {
        this.manuallyClosed = true;
        if (!this.openedSettled) {
            this.openedSettled = true;
            this.rejectOpened(new ThreadSiteNetError("Client closed before the relay welcomed it.", "closed"));
        }
        this.rejectStorageRequests();
        this.flushPlayerState();
        this.detachEventSources();
        this.worldSync?.dispose();
        try {
            this.socket?.close(1000, "client left");
        }
        catch { /* closing */ }
        this.setStatus(NET_STATUS.CLOSED, null);
    }
    /** Stop owning timers, page listeners and the metronome worker; shared by
     * close() and terminal relay rejections so a dead client leaks neither. */
    detachEventSources() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.playerStateTimer) {
            clearInterval(this.playerStateTimer);
            this.playerStateTimer = null;
        }
        this.metronome?.dispose();
        this.metronome = null;
        if (typeof document !== "undefined")
            document.removeEventListener("visibilitychange", this.visibilityHandler);
        if (typeof window !== "undefined")
            window.removeEventListener("online", this.onlineHandler);
    }
    emitEvent(to, type, data) {
        const eventType = String(type).trim().slice(0, 64);
        if (!eventType)
            throw new ThreadSiteNetError("Event type is required.", "bad_event");
        this.eventCounter += 1;
        const id = `${this.cid ?? "anon"}.${this.eventInstance}.${this.eventCounter.toString(36)}`.slice(0, 128);
        const frame = { t: "event", id, e: eventType, d: data };
        if (to !== null)
            frame.to = to;
        const event = { id, frame, expiresAt: Date.now() + this.eventTtlMs, retried: false };
        this.recentEvents.push(event);
        while (this.recentEvents.length > RECENT_EVENTS)
            this.recentEvents.shift();
        this.sendReliable(event);
        return id;
    }
    queuePlayerState(state, transformTick, reset) {
        this.pendingPlayerState = { state, transformTick, reset };
        if (this.playerStateTimer)
            return;
        this.flushPlayerState();
        this.playerStateTimer = setInterval(() => {
            try {
                this.flushPlayerState();
            }
            catch (error) {
                console.error("[threadsite-net] player-state flush failed:", error);
            }
        }, this.transformIntervalMs);
    }
    sendReliable(item) {
        if (Date.now() >= item.expiresAt)
            return;
        if (this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
            this.pruneOutbox();
            if (this.outbox.length >= OUTBOX_LIMIT)
                this.outbox.shift();
            this.outbox.push(item);
            return;
        }
        this.sendFrame(item.frame, true);
    }
    /** @internal Returns true only when the frame reached the socket; false when
     * an offline transient or a full send buffer dropped it. Throws unchanged. */
    sendFrame(frame, transient) {
        if (this.socket?.readyState !== WebSocket.OPEN) {
            if (!transient)
                this.sendReliable({ frame, expiresAt: Date.now() + this.eventTtlMs });
            return false;
        }
        if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
            this.droppedTransient += 1;
            return false;
        }
        let payload;
        try {
            payload = JSON.stringify(frame);
        }
        catch (error) {
            throw new ThreadSiteNetError("Frame is not JSON-serializable.", "bad_frame", error);
        }
        const size = byteLength(payload);
        if (size > MAX_FRAME_BYTES)
            throw new ThreadSiteNetError(`Frame is ${size} bytes; keep frames under ${MAX_FRAME_BYTES}.`, "frame_too_large");
        if (!this.takeSendToken() && (frame.t === "pstate" || frame.t === "world")) {
            // The high-rate periodic frames pace down first; reliable events are
            // rare and must not be silently lost.
            this.budgetDroppedFrames += 1;
            const now = Date.now();
            if (now - this.lastBudgetWarnAt > 5000) {
                this.lastBudgetWarnAt = now;
                console.warn(`[threadsite-net] send budget reached (${SEND_BUDGET_PER_SECOND}/s sustained): dropping ${frame.t} frames; reduce transformHz/publishHz or event volume`);
            }
            return false;
        }
        if (frame.t === "world")
            this.lastWorldBytesValue = size;
        try {
            this.socket.send(payload);
        }
        catch (error) {
            throw new ThreadSiteNetError("Send failed; the connection is closing.", "send_failed", error);
        }
        return true;
    }
    /** @internal Token bucket pacing sends just under the relay's frame limiter. */
    takeSendToken() {
        const now = Date.now();
        this.sendTokens = Math.min(SEND_BUDGET_BURST, this.sendTokens + (now - this.sendTokensUpdatedAt) * SEND_BUDGET_PER_SECOND / 1000);
        this.sendTokensUpdatedAt = now;
        if (this.sendTokens < 1)
            return false;
        this.sendTokens -= 1;
        return true;
    }
    /** @internal Track measured complete-world cadence for `net.stats`. */
    noteWorldFrame() {
        const now = Date.now();
        if (this.lastWorldArrivalAt !== null) {
            const gap = now - this.lastWorldArrivalAt;
            if (gap > 0 && gap < 2000)
                this.worldIntervalMs = this.worldIntervalMs === 0 ? gap : this.worldIntervalMs + (gap - this.worldIntervalMs) * 0.2;
        }
        this.lastWorldArrivalAt = now;
    }
    connectSocket() {
        if (this.manuallyClosed)
            return;
        this.setStatus(this.attempt === 0 ? NET_STATUS.CONNECTING : NET_STATUS.RECONNECTING, null);
        let socket;
        try {
            socket = new WebSocket(this.url);
        }
        catch (error) {
            this.failOrRetry(new ThreadSiteNetError(`Could not open ${this.url}.`, "bad_url", error));
            return;
        }
        // A previous attempt may still be open or closing (the online event can
        // fire while a dying socket is CLOSING). Detach it first so its handlers
        // can never null this newer socket or reset a live connection's state.
        const previous = this.socket;
        if (previous) {
            previous.onopen = previous.onmessage = previous.onclose = previous.onerror = null;
            this.rejectStorageRequests();
            try {
                previous.close(4000, "superseded");
            }
            catch { /* already closing */ }
        }
        this.socket = socket;
        const failTimer = setTimeout(() => {
            if (socket.readyState !== WebSocket.OPEN) {
                try {
                    socket.close();
                }
                catch { /* ignored */ }
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
                const frame = JSON.parse(String(event.data));
                if (frame && typeof frame.t === "string") {
                    if (frame.t === "world" || frame.t === "world-ack") {
                        this.lastWorldBytesValue = String(event.data).length;
                        this.noteWorldFrame();
                    }
                    this.handleFrame(frame, failTimer);
                }
            }
            catch (error) {
                console.error("[threadsite-net] inbound frame failed:", error);
            }
        };
        socket.onclose = (event) => {
            clearTimeout(failTimer);
            this.rejectStorageRequests();
            if (this.heartbeatTimer)
                clearInterval(this.heartbeatTimer);
            const wasOnline = this.id !== null;
            const lostAuthorityEpoch = this.isHost ? this.authorityEpoch : null;
            this.id = null;
            this.hostId = null;
            this.yieldPending = false;
            this.hiddenYieldDone = false;
            this.bootstrapDone = false;
            this.worldRestored = false;
            this.peersById.clear();
            this.statesByPeer.clear();
            this.transformBuffers.clear();
            // Peer ids are per-connection: without this sweep a reconnect keeps
            // presence and liveness for dead ids as unreachable ghosts forever.
            this.lastSeenByPeer.clear();
            this.transformInfo.clear();
            this.presence._clear();
            this.socket = null;
            if (lostAuthorityEpoch !== null)
                this.onAuthorityLost?.(lostAuthorityEpoch);
            if (this.manuallyClosed) {
                this.setStatus(NET_STATUS.CLOSED, null);
                return;
            }
            if (!wasOnline)
                this.failOrRetry(new ThreadSiteNetError(`Relay at ${this.url} refused the connection (${event.code}).`, "connect_failed"));
            else {
                this.setStatus(NET_STATUS.RECONNECTING, event.code);
                this.scheduleReconnect();
            }
        };
        socket.onerror = () => undefined;
    }
    handleFrame(frame, failTimer) {
        switch (frame.t) {
            case "welcome": {
                if (frame.v !== PROTOCOL_VERSION || frame.persistence?.version !== 1) {
                    clearTimeout(failTimer);
                    this.handleError({ t: "error", code: "bad_version", message: "The relay returned an unsupported protocol version." });
                    return;
                }
                this.storagePlayerId = typeof frame.persistence.playerId === "string" ? frame.persistence.playerId : null;
                this.id = String(frame.you);
                this.cid = typeof frame.cid === "string" ? frame.cid : this.cid;
                this.mode = frame.mode === "single" ? "single" : "rooms";
                this.room = this.mode === "rooms" && typeof frame.room === "string" ? frame.room : null;
                this.requestedRoom = this.room ?? "";
                this.createRoom = false;
                this.hasJoined = true;
                this.resumeRequested = false;
                saveResumeRoom(this.game, this.room);
                const recoveryWorld = this.adoptGeneration(String(frame.generation ?? ""));
                this.peersById.clear();
                this.statesByPeer.clear();
                this.transformBuffers.clear();
                this.lastSeenByPeer.clear();
                this.transformInfo.clear();
                this.presence._clear();
                for (const raw of Array.isArray(frame.peers) ? frame.peers : [])
                    this.acceptWelcomePeer(raw);
                if (finite(frame.serverTs))
                    this.serverTimeOffset = frame.serverTs - Date.now();
                const world = frame.world ? this.parseWorld(frame.world) : null;
                this.applyAuthority(frame.host ?? null, Number(frame.epoch) || 0, world, true);
                this.presence._resend();
                clearTimeout(failTimer);
                this.attempt = 0;
                this.setStatus(NET_STATUS.ONLINE, null);
                this.lastPongAt = Date.now();
                if (this.heartbeatTimer)
                    clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = setInterval(() => {
                    if (Date.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
                        try {
                            this.socket?.close(4001, "heartbeat timeout");
                        }
                        catch { /* reconnect path owns cleanup */ }
                        return;
                    }
                    this.ping();
                }, HEARTBEAT_INTERVAL_MS);
                this.ping();
                if (!this.openedSettled) {
                    this.openedSettled = true;
                    this.resolveOpened(this);
                }
                this.flushOutbox();
                // Resolve connect() first. Initial callbacks often close over the
                // `net` variable being assigned by await; synchronous delivery here
                // would hit its temporal dead zone.
                queueMicrotask(() => {
                    if (world)
                        this.acceptWorld(world, true);
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
                const peer = frame.peer;
                if (peer?.id)
                    this.peersById.set(peer.id, { id: peer.id, name: peer.name ?? null, cid: peer.cid ?? null });
                this.emitPeers();
                // A host hidden before this peer joined never saw a hide-time yield,
                // and a fresh arrival deserves a live host even after an earlier
                // hidden-period yield.
                this.hiddenYieldDone = false;
                this.maybeYieldForHiddenTab();
                return;
            }
            case "peer-leave":
                this.removePeer(String(frame.id));
                this.emitPeers();
                return;
            case "authority": {
                const recoveryWorld = this.adoptGeneration(String(frame.generation ?? ""));
                const world = frame.world ? this.parseWorld(frame.world) : (this.latestWorld ?? recoveryWorld);
                this.applyAuthority(frame.host ?? null, Number(frame.epoch) || 0, world, false);
                if (world)
                    this.acceptWorld(world, true);
                return;
            }
            case "pstate":
                this.acceptPlayerState(frame);
                return;
            case "event":
                this.acceptEvent(frame);
                return;
            case "signal":
                this.acceptEphemeral(frame);
                return;
            case "presence":
                this.acceptPresence(frame);
                return;
            case "world": {
                const world = this.parseWorld(frame);
                if (world)
                    this.acceptWorld(world, false);
                return;
            }
            case "world-ack": {
                const world = this.parseWorld(frame);
                if (world)
                    this.acceptWorld(world, false, false);
                return;
            }
            case "world-req":
                this.onWorldRequest?.(String(frame.from));
                return;
            case "pong":
                this.lastPongAt = Date.now();
                this.flushOutbox();
                if (finite(frame.ts) && frame.ts === this.lastPingTs) {
                    this.rtt = Date.now() - frame.ts;
                    if (finite(frame.serverTs))
                        this.serverTimeOffset = frame.serverTs + this.rtt / 2 - Date.now();
                }
                return;
            case "storage-result": {
                const request = this.storageRequests.get(frame.id);
                if (!request)
                    return;
                clearTimeout(request.timer);
                this.storageRequests.delete(frame.id);
                if (frame.ok === true)
                    request.resolve(frame.result);
                else
                    request.reject(new ThreadSiteNetError(String(frame.message ?? "Persistence request failed."), String(frame.code ?? "storage_unavailable")));
                return;
            }
            case "error": {
                const request = this.storageRequests.get(frame.id);
                if (request) {
                    clearTimeout(request.timer);
                    this.storageRequests.delete(frame.id);
                    request.reject(new ThreadSiteNetError(String(frame.message), String(frame.code)));
                    return;
                }
                this.handleError(frame);
                return;
            }
        }
    }
    acceptWelcomePeer(raw) {
        const id = String(raw.id ?? "");
        if (!id)
            return;
        this.peersById.set(id, { id, name: raw.name ?? null, cid: raw.cid ?? null });
        this.lastSeenByPeer.set(id, Date.now());
        if (raw.s !== undefined && raw.s !== null)
            this.statesByPeer.set(id, raw.s);
        if (raw.presence !== undefined && raw.presence !== null) {
            this.presence._accept({ from: id, cid: raw.cid ?? null, state: raw.presence, ts: finite(raw.presenceTs) ? raw.presenceTs : 0 });
        }
        // Same gate as live pstate frames: only transform streams (which carry a
        // publish tick) seed the jitter buffer, never plain player states.
        if (isTransform(raw.s) && finite(raw.ts) && finite(raw.pt))
            this.addTransform(id, raw.s, raw.ts, raw.pt, raw.pr === true);
    }
    acceptPlayerState(frame) {
        const peerId = String(frame.from ?? "");
        if (!peerId || !finite(frame.ts))
            return;
        this.statesByPeer.set(peerId, frame.s);
        this.lastSeenByPeer.set(peerId, Date.now());
        if (isTransform(frame.s) && finite(frame.pt))
            this.addTransform(peerId, frame.s, frame.ts, frame.pt, frame.pr === true);
        this.onPlayerState?.({ from: peerId, cid: frame.cid ?? null, state: frame.s, ts: frame.ts });
    }
    acceptPresence(frame) {
        const from = String(frame.from ?? "");
        if (!from || !finite(frame.ts))
            return;
        const presence = { from, cid: frame.cid ?? null, state: frame.s, ts: frame.ts };
        this.lastSeenByPeer.set(from, Date.now());
        this.presence._accept(presence);
        this.onPresence?.(presence);
    }
    acceptEphemeral(frame) {
        const from = String(frame.from ?? "");
        const type = String(frame.e ?? "");
        if (!from || !type || !finite(frame.ts))
            return;
        const event = { from, cid: frame.cid ?? null, type, data: frame.d, ts: frame.ts };
        this.lastSeenByPeer.set(from, Date.now());
        this.events._acceptEphemeral(event);
        this.onEphemeral?.(event);
    }
    addTransform(peerId, state, ts, tick, reset = false) {
        const buffer = reset ? [] : (this.transformBuffers.get(peerId) ?? []);
        const latest = buffer[buffer.length - 1];
        if (latest && latest.state.runId !== undefined && state.runId !== undefined && latest.state.runId !== state.runId)
            buffer.length = 0;
        if (latest && (tick <= latest.tick || ts < latest.ts))
            return;
        const now = Date.now();
        if (this.lastTransformArrival) {
            const transitDelta = (now - this.lastTransformArrival.localTs) - (ts - this.lastTransformArrival.relayTs);
            this.jitterMs += (Math.abs(transitDelta) - this.jitterMs) * 0.1;
        }
        this.lastTransformArrival = { relayTs: ts, localTs: now };
        buffer.push({ state: { ...state }, ts, tick });
        while (buffer.length > TRANSFORM_BUFFER_SIZE || ts - (buffer[0]?.ts ?? ts) > TRANSFORM_BUFFER_WINDOW_MS)
            buffer.shift();
        this.transformBuffers.set(peerId, buffer);
    }
    acceptEvent(frame) {
        const id = typeof frame.id === "string" ? frame.id : "";
        const from = String(frame.from ?? "");
        const dedupeKey = `${from}\u0000${id}`;
        if (!id || !from || this.appliedEventIds.has(dedupeKey) || !finite(frame.ts)) {
            if (id && this.appliedEventIds.has(dedupeKey))
                this.duplicates += 1;
            return;
        }
        this.appliedEventIds.add(dedupeKey);
        while (this.appliedEventIds.size > RECENT_EVENT_IDS) {
            const oldest = this.appliedEventIds.values().next().value;
            if (oldest)
                this.appliedEventIds.delete(oldest);
            else
                break;
        }
        this.lastSeenByPeer.set(from, Date.now());
        const event = { id, from, cid: frame.cid ?? null, type: String(frame.e ?? ""), data: frame.d, ts: frame.ts };
        this.intents._accept(event);
        this.events._acceptReliable(event);
        this.onEvent?.(event);
    }
    parseWorld(frame) {
        if (!finite(frame.ts) || !finite(frame.epoch) || !finite(frame.seq)
            || typeof frame.generation !== "string" || !frame.generation || typeof frame.from !== "string")
            return null;
        return {
            from: frame.from, cid: frame.cid ?? null, state: frame.s, ts: frame.ts,
            authorityGeneration: frame.generation, authorityEpoch: frame.epoch, stateSeq: frame.seq,
        };
    }
    acceptWorld(world, allowPriorEpoch, emit = true) {
        if (world.authorityGeneration !== this.authorityGeneration)
            return;
        const [epoch, seq] = this.latestWorldKey;
        if (!allowPriorEpoch && world.authorityEpoch < this.authorityEpoch)
            return;
        if (world.authorityEpoch < epoch || (world.authorityEpoch === epoch && world.stateSeq <= seq))
            return;
        this.latestWorld = world;
        this.latestWorldKey = [world.authorityEpoch, world.stateSeq];
        if (emit) {
            this.world._accept(world);
            this.onWorld?.(world);
        }
    }
    adoptGeneration(generation) {
        if (!generation)
            return null;
        if (this.authorityGeneration === null) {
            this.authorityGeneration = generation;
            return null;
        }
        if (this.authorityGeneration === generation)
            return null;
        const recovery = this.latestWorld;
        this.authorityGeneration = generation;
        this.authorityEpoch = 0;
        this.latestWorld = null;
        this.latestWorldKey = [-1, -1];
        return recovery;
    }
    applyAuthority(hostId, epoch, world, initial) {
        if (epoch < this.authorityEpoch)
            return;
        const wasHost = this.isHost;
        const previousEpoch = this.authorityEpoch;
        this.hostId = hostId;
        this.authorityEpoch = epoch;
        this.yieldPending = false;
        const nowHost = this.isHost;
        if (!initial && wasHost && !nowHost) {
            this.authority._lose(previousEpoch);
            this.onAuthorityLost?.(previousEpoch);
        }
        if (!initial && !wasHost && nowHost) {
            this.worldRestored = world !== null;
            this.authority._acquire(world, epoch);
            this.onAuthorityAcquired?.(world, epoch);
        }
    }
    removePeer(peerId) {
        this.peersById.delete(peerId);
        this.statesByPeer.delete(peerId);
        this.lastSeenByPeer.delete(peerId);
        this.transformBuffers.delete(peerId);
        this.transformInfo.delete(peerId);
        this.presence._remove(peerId);
    }
    handleError(frame) {
        const code = String(frame.code ?? "error");
        const error = new ThreadSiteNetError(String(frame.message ?? "Relay rejected a frame."), code);
        if (code === "rate_limited") {
            this.rateLimited += 1;
            this.setStatus(NET_STATUS.DEGRADED, code);
            this.setStatus(NET_STATUS.ONLINE, null);
            if (typeof frame.id === "string")
                this.retryEvent(frame.id);
            return;
        }
        if (["room_not_found", "bad_version", "bad_game", "bad_room", "room_full", "too_many_rooms", "project_deleted"].includes(code)) {
            if (!this.openedSettled) {
                this.openedSettled = true;
                this.rejectOpened(error);
            }
            this.manuallyClosed = true;
            this.detachEventSources();
            try {
                this.socket?.close(4000, code);
            }
            catch { /* ignored */ }
            this.setStatus(NET_STATUS.CLOSED, code);
            return;
        }
        console.warn("[threadsite-net]", code, error.message);
    }
    retryEvent(id) {
        const event = this.recentEvents.find((candidate) => candidate.id === id);
        if (!event || event.retried || Date.now() >= event.expiresAt)
            return;
        event.retried = true;
        event.frame.retry = true;
        setTimeout(() => this.sendReliable(event), 250);
    }
    flushOutbox() {
        this.pruneOutbox();
        const queued = this.outbox;
        this.outbox = [];
        for (const item of queued)
            this.sendReliable(item);
    }
    pruneOutbox() { const now = Date.now(); this.outbox = this.outbox.filter((item) => item.expiresAt > now); }
    emitPeers() {
        try {
            this.onPeers?.(this.peers);
        }
        catch (error) {
            console.error("[threadsite-net] onPeers failed:", error);
        }
    }
    setStatus(status, detail) {
        if (this.currentStatus === status)
            return;
        this.currentStatus = status;
        try {
            this.onStatus?.(status, detail);
        }
        catch (error) {
            console.error("[threadsite-net] onStatus failed:", error);
        }
    }
    failOrRetry(error) {
        if (!this.openedSettled) {
            this.openedSettled = true;
            this.rejectOpened(error);
        }
        if (this.manuallyClosed)
            return;
        if (this.autoReconnect) {
            this.setStatus(NET_STATUS.RECONNECTING, error.code);
            this.scheduleReconnect();
        }
        else
            this.setStatus(NET_STATUS.CLOSED, error.code);
    }
    scheduleReconnect() {
        if (this.manuallyClosed || this.reconnectTimer)
            return;
        this.attempt += 1;
        const backoff = Math.min(8000, 500 * 2 ** Math.min(this.attempt, 4));
        const delay = backoff * (0.7 + Math.random() * 0.6);
        this.reconnectDueAt = Date.now() + delay;
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connectSocket(); }, delay);
    }
}
/** Personal JSON checkpoint slots. CAS revisions prevent stale tabs overwriting newer progress. */
export class NetSaves {
    net;
    constructor(net) {
        this.net = net;
    }
    get available() { return this.net.status === NET_STATUS.ONLINE && this.net.playerId !== null; }
    /** False if storage is blocked or a caller supplies its own credential. */
    get identityPersistent() { return this.net.persistentIdentity; }
    get(slot) {
        return this.net.storageRequest({ op: "save.get", slot });
    }
    set(slot, value, revision) {
        return this.net.storageRequest({ op: "save.set", slot, value, revision });
    }
    delete(slot, revision) {
        return this.net.storageRequest({ op: "save.delete", slot, revision });
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
    net;
    constructor(net) {
        this.net = net;
    }
    publish(transform) { this.net.publishTransform(transform); }
    teleport(transform) { this.net.publishTeleport(transform); }
    /**
     * Rendering-only time-shifted transform for one remote peer: interpolated
     * 45-150 ms in the past (adaptive to transit jitter), extrapolating at
     * most 100 ms past the newest sample. Never resolve gameplay from a
     * sample; see `latest()`.
     */
    sample(peerId, options = {}) {
        return this.net.sampleTransform(peerId, options);
    }
    /** Rendering-only sweep of live remote peers; see `sample()`. */
    sampleAll(options = {}) {
        return this.net.sampleRemotePlayers(options);
    }
    /** Rendering-only alive filter over `sampleAll()`; see `sample()`. */
    listAlive(options = {}) {
        return this.sampleAll(options).filter(({ transform }) => transform.alive !== false);
    }
    /** Rendering-only nearest-player query built on `listAlive()`; see `sample()`. */
    nearest(x, y, options = {}) {
        let nearest = null;
        let nearestDistance = Number.POSITIVE_INFINITY;
        for (const candidate of this.listAlive(options)) {
            const distance = (candidate.transform.x - x) ** 2 + (candidate.transform.y - y) ** 2;
            if (distance < nearestDistance) {
                nearest = candidate;
                nearestDistance = distance;
            }
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
    latest(peerId) {
        return this.net.latestTransform(peerId);
    }
    /**
     * Live peers with a recent newest transform.
     * Peers that have not published yet or exceed maxAgeMs are omitted.
     */
    latestAll(options = {}) {
        return this.net.latestRemotePlayers(options);
    }
    flush() { this.net.flushPlayerState(); }
    info(peerId) { return this.net.transformSampleInfo(peerId); }
}
export class NetAuthority {
    net;
    acquireHandlers = new Set();
    loseHandlers = new Set();
    constructor(net) {
        this.net = net;
    }
    isHost() { return this.net.isHost; }
    /**
     * False until the relay welcome — including its cached or persisted world —
     * has been processed. Authoritative publishing throws `not_ready` before
     * this flips true, so restored arenas cannot be wiped by an eager host.
     */
    get ready() { return this.net.bootstrapped; }
    epoch() { return this.net.authorityEpoch; }
    generation() { return this.net.authorityGeneration; }
    yield() { return this.net.worldSync?.yieldAuthority() ?? this.net.yieldHost(); }
    onAcquire(handler) {
        this.acquireHandlers.add(handler);
        return () => this.acquireHandlers.delete(handler);
    }
    onLose(handler) {
        this.loseHandlers.add(handler);
        return () => this.loseHandlers.delete(handler);
    }
    _acquire(snapshot, epoch) {
        for (const handler of this.acquireHandlers)
            safeCall(() => handler(snapshot, epoch), "authority acquire handler");
    }
    _lose(epoch) {
        for (const handler of this.loseHandlers)
            safeCall(() => handler(epoch), "authority lose handler");
    }
}
export class NetWorld {
    net;
    handlers = new Set();
    constructor(net) {
        this.net = net;
    }
    sync(options) { return this.net.syncWorld(options); }
    latest() { return this.net.latestWorldSnapshot(); }
    /** The newest accepted complete world; alias of `latest()`. */
    get snapshot() { return this.net.latestWorldSnapshot(); }
    /**
     * True when this client's host authority began from an existing snapshot
     * (relay cache or the relay's persisted arena world) rather than a fresh
     * world — check it inside `onAuthorityAcquired`/`onAuthorityStart`.
     */
    get restored() { return this.net.worldRestored; }
    get generation() { return this.net.authorityGeneration; }
    get epoch() { return this.net.authorityEpoch; }
    publishNow() { return this.net.worldSync?.publishNow() ?? false; }
    yieldAuthority() { return this.net.worldSync?.yieldAuthority() ?? false; }
    /** Publish one complete world immediately (host only, raw lifecycle only). */
    publish(state) { this.net.publishWorld(state); }
    /** Publish a brand-new world, replacing any restored/cached one (raw lifecycle only). */
    reset(state) { this.net.worldRestored = false; this.net.publishWorld(state); }
    onSnapshot(handler) {
        const raw = handler;
        this.handlers.add(raw);
        return () => this.handlers.delete(raw);
    }
    _accept(snapshot) {
        for (const handler of this.handlers)
            safeCall(() => handler(snapshot), "world snapshot handler");
    }
}
export class NetClock {
    net;
    constructor(net) {
        this.net = net;
    }
    now() { return this.net.serverNow(); }
    after(ms) { return this.now() + Math.max(0, Number(ms) || 0); }
    elapsed(startTs) { return Math.max(0, this.now() - startTs); }
    remaining(targetTs) { return Math.max(0, targetTs - this.now()); }
}
export class NetEvents {
    net;
    reliableHandlers = new Map();
    ephemeralHandlers = new Map();
    ephemeralLastSent = new Map();
    ephemeralPending = new Map();
    ephemeralTimers = new Map();
    constructor(net) {
        this.net = net;
    }
    sendReliable(type, data = null, peerId = null) {
        return peerId ? this.net.emitTo(peerId, type, data) : this.net.emit(type, data);
    }
    sendEphemeral(type, data = null, peerId = null) {
        const eventType = cleanTypedName(type, "event");
        const key = `${peerId ?? "*"}\u0000${eventType}`;
        const elapsed = Date.now() - (this.ephemeralLastSent.get(key) ?? 0);
        if (elapsed >= 50) {
            this.sendEphemeralNow(key, eventType, data, peerId);
            return;
        }
        this.ephemeralPending.set(key, { type: eventType, data, peerId });
        if (this.ephemeralTimers.has(key))
            return;
        this.ephemeralTimers.set(key, setTimeout(() => {
            this.ephemeralTimers.delete(key);
            const pending = this.ephemeralPending.get(key);
            if (!pending)
                return;
            this.ephemeralPending.delete(key);
            this.sendEphemeralNow(key, pending.type, pending.data, pending.peerId);
        }, 50 - elapsed));
    }
    onReliable(type, handler) {
        return addTypedHandler(this.reliableHandlers, type, handler);
    }
    onEphemeral(type, handler) {
        return addTypedHandler(this.ephemeralHandlers, type, handler);
    }
    _acceptReliable(event) { callTypedHandlers(this.reliableHandlers, event.type, event); }
    _acceptEphemeral(event) { callTypedHandlers(this.ephemeralHandlers, event.type, event); }
    sendEphemeralNow(key, type, data, peerId) {
        this.ephemeralLastSent.set(key, Date.now());
        safeCall(() => this.net.emitEphemeral(type, data, peerId), "ephemeral send");
    }
}
export class NetIntents {
    net;
    handlers = new Map();
    constructor(net) {
        this.net = net;
    }
    send(type, payload) {
        const intentType = cleanTypedName(type, "intent");
        const runId = this.net.run.current;
        if (runId === null)
            throw new ThreadSiteNetError("Start/synchronize a world run before sending an intent.", "no_active_run");
        return this.net.emitToAuthority(`@intent:${intentType}`, { runId, payload });
    }
    on(type, handler) {
        return addTypedHandler(this.handlers, cleanTypedName(type, "intent"), handler);
    }
    _accept(event) {
        if (!event.type.startsWith("@intent:") || !this.net.isHost)
            return;
        const type = event.type.slice(8);
        const data = event.data;
        const currentRun = this.net.run.current;
        if (!data || currentRun === null || data.runId !== currentRun)
            return;
        const intent = {
            id: event.id, from: event.from, cid: event.cid, type,
            payload: data.payload, runId: currentRun, ts: event.ts,
        };
        callTypedHandlers(this.handlers, type, intent);
    }
}
export class NetPresence {
    net;
    remote = new Map();
    handlers = new Set();
    localState = undefined;
    constructor(net) {
        this.net = net;
    }
    set(state) { this.net.publishPresence(state); }
    get(peerId) { return this.remote.get(peerId)?.state; }
    list() { return [...this.remote.values()]; }
    onChange(handler) {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }
    _setLocal(state) { this.localState = state; }
    _resend() { if (this.localState !== undefined)
        this.net.publishPresence(this.localState); }
    _accept(presence) {
        this.remote.set(presence.from, { id: presence.from, cid: presence.cid, state: presence.state });
        for (const handler of this.handlers)
            safeCall(() => handler(presence), "presence handler");
    }
    _remove(peerId) { this.remote.delete(peerId); }
    _clear() { this.remote.clear(); }
}
export class NetRun {
    net;
    currentRun = null;
    currentRunTick = null;
    handlers = new Set();
    constructor(net) {
        this.net = net;
    }
    get current() { return this.currentRun ?? this.net.worldSync?.currentRunId ?? null; }
    get tick() { return this.currentRunTick ?? this.net.worldSync?.currentTick ?? null; }
    isCurrent(runId) { return this.current !== null && runId === this.current; }
    onChanged(handler) {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }
    _accept(runId, tick) {
        const previous = this.currentRun;
        this.currentRun = runId;
        this.currentRunTick = tick;
        if (previous === runId)
            return;
        const change = { previous, current: runId, tick };
        for (const handler of this.handlers)
            safeCall(() => handler(change), "run change handler");
    }
}
export class NetEntities {
    /**
     * Register one stable-ID presentation collection. The controller owns the
     * entity map: iterate `collection.values()` for per-frame presentation and
     * do not maintain a second parallel entity map unless the game truly needs
     * one.
     */
    syncCollection(name, options) {
        return new NetCollectionSync(name, options);
    }
}
export class NetCollectionSync {
    options;
    entities = new Map();
    prevSnapshot = null;
    curSnapshot = null;
    intervalMs = 0;
    name;
    constructor(name, options) {
        this.options = options;
        this.name = cleanTypedName(name, "collection");
    }
    apply(snapshots) {
        const incoming = new Map();
        for (const snapshot of snapshots) {
            const id = this.options.getId(snapshot);
            if (!(typeof id === "string" || finite(id)))
                throw new ThreadSiteNetError(`${this.name} snapshot has an invalid id.`, "bad_entity_id");
            const key = `${typeof id}:${String(id)}`;
            if (incoming.has(key))
                throw new ThreadSiteNetError(`${this.name} snapshot repeats id ${String(id)}.`, "duplicate_entity_id");
            incoming.set(key, snapshot);
            const existing = this.entities.get(key);
            if (existing)
                this.options.update(existing.entity, snapshot, id);
            else
                this.entities.set(key, { id, entity: this.options.create(snapshot, id) });
        }
        for (const [key, existing] of this.entities) {
            if (incoming.has(key))
                continue;
            this.options.remove(existing.entity, existing.id);
            this.entities.delete(key);
        }
        if (!this.options.smooth)
            return;
        const now = Date.now();
        if (this.curSnapshot) {
            const gap = now - this.curSnapshot.at;
            if (gap > 0 && gap < 2000)
                this.intervalMs = this.intervalMs === 0 ? gap : this.intervalMs + (gap - this.intervalMs) * 0.2;
        }
        this.prevSnapshot = this.curSnapshot ?? { at: now, byId: incoming };
        this.curSnapshot = { at: now, byId: incoming };
    }
    get(id) {
        this.refreshSmooth();
        return this.entities.get(`${typeof id}:${String(id)}`)?.entity;
    }
    /** All live local entities — the per-frame presentation iteration point. */
    values() {
        this.refreshSmooth();
        return [...this.entities.values()].map(({ entity }) => entity);
    }
    clear() {
        for (const { id, entity } of this.entities.values())
            this.options.remove(entity, id);
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
    refreshSmooth() {
        const smooth = this.options.smooth;
        const current = this.curSnapshot;
        if (!smooth || !current)
            return;
        const previous = this.prevSnapshot;
        const delay = smooth.renderDelayMs !== undefined
            ? clamp(smooth.renderDelayMs, 16, 300)
            : clamp(Math.round(this.intervalMs * 1.25), 50, 200);
        const renderTs = Date.now() - delay;
        const snapDistance = smooth.snapDistance ?? 10;
        for (const [key, { entity }] of this.entities) {
            const cur = current.byId.get(key);
            if (cur == null || typeof entity !== "object" || entity === null)
                continue;
            const target = entity;
            const prev = previous?.byId.get(key);
            let alpha = 1;
            if (prev != null && previous && current.at > previous.at) {
                alpha = clamp((renderTs - previous.at) / (current.at - previous.at), 0, 1);
                if (alpha < 1) {
                    let displacement = 0;
                    for (const name of smooth.keys) {
                        const from = Number(prev[name]);
                        const to = Number(cur[name]);
                        if (Number.isFinite(from) && Number.isFinite(to))
                            displacement += (to - from) * (to - from);
                    }
                    if (Math.sqrt(displacement) > snapDistance)
                        alpha = 1;
                }
            }
            for (const name of smooth.keys) {
                const to = Number(cur[name]);
                if (!Number.isFinite(to))
                    continue;
                if (alpha >= 1) {
                    target[name] = to;
                    continue;
                }
                const from = Number(prev?.[name]);
                if (!Number.isFinite(from)) {
                    target[name] = to;
                    continue;
                }
                target[name] = from + (to - from) * alpha;
            }
        }
    }
}
function cleanTypedName(value, label) {
    const name = String(value).trim().slice(0, 48);
    if (!/^[A-Za-z0-9_.:-]+$/.test(name))
        throw new ThreadSiteNetError(`${label} type is invalid.`, `bad_${label}`);
    return name;
}
function addTypedHandler(map, type, handler) {
    const key = cleanTypedName(type, "event");
    const handlers = map.get(key) ?? new Set();
    handlers.add(handler);
    map.set(key, handlers);
    return () => { handlers.delete(handler); if (!handlers.size)
        map.delete(key); };
}
function callTypedHandlers(map, type, value) {
    for (const handler of map.get(type) ?? [])
        safeCall(() => handler(value), `${type} handler`);
}
function safeCall(callback, label) {
    try {
        callback();
    }
    catch (error) {
        console.error(`[threadsite-net] ${label} failed:`, error);
    }
}
/**
 * Owns the easy-to-get-wrong authority lifecycle for a complete shared world.
 * It restores before starting a new host, publishes periodically, serves late
 * join requests, presents accepted snapshots only to guests, and stops the
 * host loop immediately when authority is lost.
 */
export class NetWorldSyncController {
    net;
    options;
    timer = null;
    disposed = false;
    lastPresented = null;
    previousWorld;
    previousRequest;
    previousAcquired;
    previousLost;
    worldHandler;
    requestHandler;
    acquiredHandler;
    lostHandler;
    constructor(net, options) {
        this.net = net;
        this.options = options;
        if (options.schemaVersion === undefined || options.schemaVersion === null || options.schemaVersion === "") {
            throw new ThreadSiteNetError("world.schemaVersion is required.", "bad_world_sync");
        }
        this.previousWorld = net.onWorld;
        this.previousRequest = net.onWorldRequest;
        this.previousAcquired = net.onAuthorityAcquired;
        this.previousLost = net.onAuthorityLost;
        this.worldHandler = (snapshot) => {
            this.previousWorld?.(snapshot);
            if (this.net.isHost)
                return;
            const decoded = this.decode(snapshot, false);
            if (decoded) {
                try {
                    this.options.present(decoded, snapshot);
                }
                catch (error) {
                    console.error("[threadsite-net] world.present failed:", error);
                }
            }
        };
        this.requestHandler = (from) => {
            this.previousRequest?.(from);
            if (this.net.isHost)
                this.publishNow();
        };
        this.acquiredHandler = (snapshot, epoch) => {
            this.previousAcquired?.(snapshot, epoch);
            this.stopTimer();
            const decoded = snapshot ? this.decode(snapshot, true) : null;
            try {
                if (decoded && snapshot)
                    this.options.restore(decoded, snapshot);
                this.options.onAuthorityStart({ epoch, recovered: decoded !== null });
            }
            catch (error) {
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
            try {
                this.options.onAuthorityStop({ epoch });
            }
            catch (error) {
                console.error("[threadsite-net] world.onAuthorityStop failed:", error);
            }
            this.previousLost?.(epoch);
        };
        net.onWorld = this.worldHandler;
        net.onWorldRequest = this.requestHandler;
        net.onAuthorityAcquired = this.acquiredHandler;
        net.onAuthorityLost = this.lostHandler;
    }
    get currentRunId() { return this.lastPresented?.runId ?? null; }
    get currentTick() { return this.lastPresented?.tick ?? null; }
    /** Publish a fresh complete world immediately when host. */
    publishNow() {
        if (this.disposed || !this.net.isHost)
            return false;
        const envelope = this.captureEnvelope();
        if (!envelope)
            return false;
        try {
            this.net.publishWorld(envelope);
        }
        catch (error) {
            console.error("[threadsite-net] complete-world publish failed:", error);
            return false;
        }
        this.lastPresented = { runId: envelope.runId, tick: envelope.tick };
        this.net.run._accept(envelope.runId, envelope.tick);
        return true;
    }
    /** Publish the final complete world and ask the relay to migrate authority. */
    yieldAuthority() {
        if (this.disposed || !this.net.isHost)
            return false;
        const envelope = this.captureEnvelope();
        if (!envelope || !this.net.yieldHost(envelope))
            return false;
        this.lastPresented = { runId: envelope.runId, tick: envelope.tick };
        this.net.run._accept(envelope.runId, envelope.tick);
        return true;
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.stopTimer();
        if (this.net.onWorld === this.worldHandler)
            this.net.onWorld = this.previousWorld;
        if (this.net.onWorldRequest === this.requestHandler)
            this.net.onWorldRequest = this.previousRequest;
        if (this.net.onAuthorityAcquired === this.acquiredHandler)
            this.net.onAuthorityAcquired = this.previousAcquired;
        if (this.net.onAuthorityLost === this.lostHandler)
            this.net.onAuthorityLost = this.previousLost;
        if (this.net.worldSync === this)
            this.net.worldSync = null;
    }
    decode(snapshot, allowEqual) {
        const envelope = snapshot.state;
        if (!envelope || typeof envelope !== "object" || envelope.schemaVersion !== this.options.schemaVersion)
            return null;
        const world = { runId: envelope.runId, tick: Number(envelope.tick), state: envelope.state };
        if (!this.validWorld(world))
            return null;
        if (!allowEqual && this.lastPresented?.runId === world.runId && world.tick <= this.lastPresented.tick)
            return null;
        this.lastPresented = { runId: world.runId, tick: world.tick };
        this.net.run._accept(world.runId, world.tick);
        return world;
    }
    validWorld(world) {
        if (!world || !Number.isSafeInteger(world.tick) || world.tick < 0)
            return false;
        if (!(typeof world.runId === "string" ? world.runId.length > 0 : finite(world.runId)))
            return false;
        try {
            return this.options.validate?.(world) !== false;
        }
        catch (error) {
            console.error("[threadsite-net] world.validate failed:", error);
            return false;
        }
    }
    captureEnvelope() {
        let captured;
        try {
            captured = this.options.capture();
        }
        catch (error) {
            console.error("[threadsite-net] world.capture failed:", error);
            return null;
        }
        if (!this.validWorld(captured)) {
            console.error("[threadsite-net] world.capture returned an invalid runId/tick/state.");
            return null;
        }
        return { schemaVersion: this.options.schemaVersion, ...captured };
    }
    stopTimer() { if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
    } }
}
function interpolateTransform(a, b, alpha) {
    // Discrete fields (alive, animation, runId, string facing) switch only when
    // their sample time is reached; do not leak a future death/run transition.
    const result = { ...a };
    for (const key of INTERPOLATED_KEYS) {
        const av = a[key];
        const bv = b[key];
        if (finite(av) && finite(bv))
            result[key] = av + (bv - av) * alpha;
    }
    return result;
}
function extrapolateTransform(state, seconds) {
    const result = { ...state };
    if (finite(state.vx))
        result.x += state.vx * seconds;
    if (finite(state.vy))
        result.y += state.vy * seconds;
    if (finite(state.z) && finite(state.vz))
        result.z = state.z + state.vz * seconds;
    return result;
}
