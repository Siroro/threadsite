// ThreadSite Multiplayer Protocol v4 browser client.
// TypeScript is the source of truth; the bot build emits the zero-dependency
// threadsite-net.js and declarations vendored into generated games.
export const PROTOCOL_VERSION = 4;
export const NET_STATUS = Object.freeze({
    CONNECTING: "connecting", ONLINE: "online", RECONNECTING: "reconnecting",
    DEGRADED: "degraded", CLOSED: "closed",
});
const MAX_FRAME_BYTES = 60 * 1024;
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
    constructor(options = {}) {
        const game = String(options.game ?? "").trim();
        if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(game)) {
            throw new ThreadSiteNetError(`Invalid game id '${game}' — use NET_CONFIG.game unchanged.`, "bad_config");
        }
        this.game = game;
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
            if (this.autoYieldOnHidden && document.hidden && this.isHost && this.peers.length > 0)
                this.yieldHost();
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
        this.transforms = new NetTransforms(this);
        this.authority = new NetAuthority(this);
        this.world = new NetWorld(this);
        this.clock = new NetClock(this);
        this.events = new NetEvents(this);
        this.intents = new NetIntents(this);
        this.presence = new NetPresence(this);
        this.entities = new NetEntities();
        this.run = new NetRun(this);
        this.worldSync = null;
        if (options.world)
            this.syncWorld(options.world);
        this.connectSocket();
    }
    get status() { return this.currentStatus; }
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
        this.lastPublishedWorld = state ?? null;
        this.sendFrame({
            t: "world", generation: this.authorityGeneration,
            epoch: this.authorityEpoch, s: this.lastPublishedWorld,
        }, true);
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
        const delay = options.renderDelayMs === undefined ? clamp(100 + this.jitterMs * 2, 100, 150) : clamp(options.renderDelayMs, 0, 500);
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
    /** @internal */ latestWorldSnapshot() { return this.latestWorld; }
    /** @internal Use `world.yieldAuthority()`. */
    yieldHost(finalWorld = this.lastPublishedWorld) {
        if (!this.isHost || !this.authorityGeneration || this.peers.length === 0 || this.yieldPending)
            return false;
        if (finalWorld !== undefined)
            this.publishWorld(finalWorld);
        this.yieldPending = true;
        this.sendFrame({
            t: "yield-host", generation: this.authorityGeneration, epoch: this.authorityEpoch,
        }, true);
        return true;
    }
    /** @internal */ ping() {
        this.lastPingTs = Date.now();
        this.sendFrame({ t: "ping", ts: this.lastPingTs }, true);
    }
    close() {
        this.manuallyClosed = true;
        this.flushPlayerState();
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        if (this.heartbeatTimer)
            clearInterval(this.heartbeatTimer);
        if (this.playerStateTimer)
            clearInterval(this.playerStateTimer);
        if (typeof document !== "undefined")
            document.removeEventListener("visibilitychange", this.visibilityHandler);
        if (typeof window !== "undefined")
            window.removeEventListener("online", this.onlineHandler);
        this.worldSync?.dispose();
        try {
            this.socket?.close(1000, "client left");
        }
        catch { /* closing */ }
        this.setStatus(NET_STATUS.CLOSED, null);
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
        this.playerStateTimer = setInterval(() => this.flushPlayerState(), this.transformIntervalMs);
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
    sendFrame(frame, transient) {
        if (this.socket?.readyState !== WebSocket.OPEN) {
            if (!transient)
                this.sendReliable({ frame, expiresAt: Date.now() + this.eventTtlMs });
            return;
        }
        if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
            this.droppedTransient += 1;
            return;
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
        try {
            this.socket.send(payload);
        }
        catch (error) {
            throw new ThreadSiteNetError("Send failed; the connection is closing.", "send_failed", error);
        }
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
            name: this.name, cid: this.cid,
        }, true);
        socket.onmessage = (event) => {
            try {
                const frame = JSON.parse(String(event.data));
                if (frame && typeof frame.t === "string")
                    this.handleFrame(frame, failTimer);
            }
            catch (error) {
                console.error("[threadsite-net] inbound frame failed:", error);
            }
        };
        socket.onclose = (event) => {
            clearTimeout(failTimer);
            if (this.heartbeatTimer)
                clearInterval(this.heartbeatTimer);
            const wasOnline = this.id !== null;
            const lostAuthorityEpoch = this.isHost ? this.authorityEpoch : null;
            this.id = null;
            this.hostId = null;
            this.yieldPending = false;
            this.bootstrapDone = false;
            this.worldRestored = false;
            this.peersById.clear();
            this.statesByPeer.clear();
            this.transformBuffers.clear();
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
                }, 10_000);
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
            case "error":
                this.handleError(frame);
                return;
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
        if (isTransform(raw.s) && finite(raw.ts))
            this.addTransform(id, raw.s, raw.ts, finite(raw.pt) ? raw.pt : 0, raw.pr === true);
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
        if (["room_not_found", "bad_version", "bad_game", "bad_room", "room_full", "too_many_rooms"].includes(code)) {
            if (!this.openedSettled) {
                this.openedSettled = true;
                this.rejectOpened(error);
            }
            this.manuallyClosed = true;
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
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connectSocket(); }, backoff * (0.7 + Math.random() * 0.6));
    }
}
export class NetTransforms {
    net;
    constructor(net) {
        this.net = net;
    }
    publish(transform) { this.net.publishTransform(transform); }
    teleport(transform) { this.net.publishTeleport(transform); }
    sample(peerId, options = {}) {
        return this.net.sampleTransform(peerId, options);
    }
    sampleAll(options = {}) {
        return this.net.sampleRemotePlayers(options);
    }
    listAlive(options = {}) {
        return this.sampleAll(options).filter(({ transform }) => transform.alive !== false);
    }
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
    syncCollection(name, options) {
        return new NetCollectionSync(name, options);
    }
}
export class NetCollectionSync {
    options;
    entities = new Map();
    name;
    constructor(name, options) {
        this.options = options;
        this.name = cleanTypedName(name, "collection");
    }
    apply(snapshots) {
        const seen = new Set();
        for (const snapshot of snapshots) {
            const id = this.options.getId(snapshot);
            if (!(typeof id === "string" || finite(id)))
                throw new ThreadSiteNetError(`${this.name} snapshot has an invalid id.`, "bad_entity_id");
            const key = `${typeof id}:${String(id)}`;
            if (seen.has(key))
                throw new ThreadSiteNetError(`${this.name} snapshot repeats id ${String(id)}.`, "duplicate_entity_id");
            seen.add(key);
            const existing = this.entities.get(key);
            if (existing)
                this.options.update(existing.entity, snapshot, id);
            else
                this.entities.set(key, { id, entity: this.options.create(snapshot, id) });
        }
        for (const [key, existing] of this.entities) {
            if (seen.has(key))
                continue;
            this.options.remove(existing.entity, existing.id);
            this.entities.delete(key);
        }
    }
    get(id) { return this.entities.get(`${typeof id}:${String(id)}`)?.entity; }
    values() { return [...this.entities.values()].map(({ entity }) => entity); }
    clear() {
        for (const { id, entity } of this.entities.values())
            this.options.remove(entity, id);
        this.entities.clear();
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
