## Multiplayer first

Build multiplayer as the primary game mode; solo is the same simulation with one human. Use only the harness-owned, fully typed ThreadSite client and relay. Never add WebSocket/WebRTC code, another multiplayer SDK/server, retry or heartbeat logic, clock sync, host election, snapshot ordering, or transform interpolation. Import from `../net/threadsite-net.js`; never edit `site/net/`. A companion guide — `NETWORKING.md` at the project root — lists the client's rates, limits, and sync gotchas with a symptom→fix debugging table; read it before implementing netcode and whenever synchronization misbehaves.

### Choose ownership before writing gameplay

Use exactly two ownership paths:

- Each client owns its local player's input and transform. Publish it through `net.transforms`; remote clients render sampled transforms from that same facade.
- The current host owns every shared enemy, boss, pickup, projectile/hazard, shared timer, RNG/director, damage result, score/reward, and next-ID counter. Guests render accepted snapshots and send intents; they never simulate or mutate shared truth.

Keep authoritative state, guest presentation, and local input in separate functions. Do not let a render/update loop become authoritative merely because it runs every frame.

### Connect with the safe world lifecycle

Real-time games with any shared state must use the high-level `world` option. It centrally handles late join, reconnect, relay-room recreation, host migration, complete-snapshot publication, world requests, schema rejection, and stale generation/epoch/sequence/run/tick rejection:

```ts
import { NET_CONFIG } from "../net/net-config.js";
import { ThreadSiteNet, type NetWorldState } from "../net/threadsite-net.js";

type SharedState = {
  simElapsedMs: number; // simulation-relative time, never a wall-clock start
  rngState: number;
  nextEntityId: number;
  enemies: EnemySnapshot[];
  pickups: PickupSnapshot[];
};

let authoritative = false;
const net = await ThreadSiteNet.createAuthoritativeSession({
  ...NET_CONFIG,
  mode: "single", // the default: one game-wide shared ARENA
  name,
  world: {
    schemaVersion: 1,
    publishHz: 10,
    capture: (): NetWorldState<SharedState> => ({
      runId,
      tick: simulationTick,
      state: serializeCompleteSharedWorld(),
    }),
    restore: ({ runId: restoredRun, tick, state }) => {
      restoreCompleteSharedWorld(restoredRun, tick, state);
    },
    present: ({ runId: presentedRun, tick, state }) => {
      presentCompleteSharedWorld(presentedRun, tick, state);
    },
    onAuthorityStart: () => { authoritative = true; },
    onAuthorityStop: () => { authoritative = false; },
    validate: ({ state }) => isValidSharedState(state),
  },
});
```

Use one complete serializer and one restore path; never maintain separate “join”, “reconnect”, and “migration” snapshots. `capture` must include stable entity IDs and all state needed to resume deterministically. `restore` runs before `onAuthorityStart`; it may receive the host's locally acknowledged snapshot from a previous relay generation after a relay restart. `present` runs only for guests and must update presentation without advancing authoritative simulation.

While `authoritative` is true, advance shared simulation using frame-rate-independent steps and `net.clock.now()` for shared time. Stop shared mutation immediately when it becomes false. The preset configures transform rate, publishes complete worlds, serves late-join requests, and publishes immediately after authority starts. Call `net.world.publishNow()` after a boss phase change or shared reset, and `net.world.yieldAuthority()` before an intentional scene transition. Do not use raw world frames or authority callbacks alongside this lifecycle.

For games with genuinely no shared state, omit `world`. Default to `mode: "single"`: one game-wide shared arena with no room UI (`net.room` is intentionally `null`) — this is the preferred topology for generated games. Reach for `mode: "rooms"` only when the request explicitly calls for private invite-coded sessions; then pass `room: ThreadSiteNet.roomFromUrl()` and `createRoom: !invitedRoom`, show the room code plus `net.inviteUrl()`, and handle missing/full/expired rooms. If the initial relay connection fails, keep the same game playable solo and show a small offline indicator.

### Durable arenas

Shared arenas survive having zero players and relay restarts: the relay periodically snapshots the latest authoritative world (`mode: "single"` only; private rooms stay ephemeral) and hands it back in the first joiner's welcome. Four rules keep that safe:

- Never create or publish a fresh world before the restored one is applied. The `world` lifecycle already sequences this (`restore` → `onAuthorityStart` → first publish), and the client hard-refuses early publishes with a `not_ready` error until `net.authority.ready` is true — do not work around it. `onAuthorityStart`'s `recovered` flag and `net.world.restored` tell you whether you resumed an existing world.
- Persist simulation-relative durations, not absolute start timestamps: snapshot `simElapsedMs`, remaining cooldowns, wave/boss timers, and buff/respawn timers as elapsed or remaining simulation time, then rebase (`deadline = net.clock.now() + remaining`) on restore. An absolute `runStartedAt` makes an offline gap of hours instantly "end" every timer when someone returns.
- World snapshots must carry a `schemaVersion` (the lifecycle enforces this and rejects mismatches). When you change the snapshot shape, bump it and restore only versions you still understand; treat an unreadable snapshot as "start a fresh world", never as corrupt input to half-apply.
- An empty arena resumes paused, not fast-forwarded: whatever timers, boss state, or health existed in the snapshot simply continue from that snapshot when somebody returns. Do not simulate offline elapsed time.

### Player transforms are already safe

Publish the local transform every update. The client coalesces to 25 Hz, relay-stamps it monotonically, rejects stale/out-of-order ticks, and maintains the jitter buffer:

```ts
net.transforms.publish({ x, y, vx, vy, facing, alive, runId });

for (const { peer, transform } of net.transforms.sampleAll()) {
  renderRemotePlayer(peer.id, transform);
}
```

`sampleAll()` returns only live peers with recent transforms. `listAlive()` filters dead players and `nearest(x, y)` handles common host-AI targeting. Call `net.transforms.teleport(transform)` for teleport, spawn/respawn, death/revive discontinuities, or changing run; it publishes immediately and resets remote interpolation history. Use live `peer.id` for avatars and routing. `cid` is reconnect metadata only; two live peers with the same cid are still distinct. Never add interpolation, timestamp comparison, or stale-avatar bookkeeping of your own.

Keep slow-changing player metadata out of transforms:

```ts
net.presence.set({ name, character, ready, alive, downed, cosmetic });
const remotePresence = net.presence.get(peer.id);
```

Presence is cached for late join and automatically republished after reconnect.

### Reconcile snapshot collections centrally

Do not hand-write repeated find/create/update/remove loops for snapshot entities. Register a stable-ID collection once:

```ts
const enemiesSync = net.entities.syncCollection("enemies", {
  getId: (snapshot) => snapshot.id,
  create: (snapshot) => spawnEnemyView(snapshot),
  update: (enemy, snapshot) => updateEnemyView(enemy, snapshot),
  remove: (enemy) => destroyEnemyView(enemy),
});

// Inside guest world presentation:
enemiesSync.apply(sharedState.enemies);
```

Use one collection controller per entity kind. Duplicate or invalid IDs fail loudly; entities missing from the next complete snapshot are removed automatically. This is presentation reconciliation, not authority: the host still owns the source collection.

### Events are intents or confirmed results

Send guest actions through the host-routed intent helper:

```ts
net.intents.send("try-pickup", { entityId });

net.intents.on("try-pickup", (intent) => {
  // Runs only on the current host and only for the current run.
  if (canClaim(intent.from, intent.payload.entityId)) acceptClaim(intent);
});
```

The helper attaches collision-proof intent ID, sender, current run ID and relay timestamp, routes to the current host, deduplicates, and drops intents from stale runs. The host must still validate payload shape, sender, entity existence, eligibility, distance/range, cooldown, and current state before mutating shared truth. Never grant damage, pickups, currency, score, or achievements directly from a guest request or approximate x/y matching.

For other discrete messages choose reliability explicitly:

```ts
net.events.sendReliable("revive-approved", { playerId }, peerId); // TTL/retry/dedupe
net.events.sendEphemeral("aim-preview", { angle });               // drop if late/offline
```

Use `onReliable` and `onEphemeral` to subscribe. Reliable handlers remain idempotent by event ID and stable entity ID. Ephemeral is only for replaceable presentation hints—not damage, claims, rewards, phase changes, or anything that must survive loss. Events never replace complete worlds or transforms. Treat all inbound values as untrusted.

Use `net.clock.after(ms)`, `elapsed(startTs)`, and `remaining(targetTs)` for deadlines. Never mix relay timestamps with `Date.now()`. `net.run.current`, `net.run.tick`, and `net.run.isCurrent(id)` expose the accepted complete-world run; do not maintain a second networking run ID.

### Connection UX and acceptance checks

Arena games (the default) show connection status and the peer list, with no room UI. Room games additionally show the room code and `net.inviteUrl()`. Reconnect is automatic, detects half-open sockets, resumes/recreates the same room after relay memory loss, and isolates stale snapshots with a room generation. A peer leaving must never break local play. Handle invalid, missing, full, and expired rooms cleanly.

Before calling multiplayer complete, test two tabs and two physical devices; 2-4 moving peers; late join; network loss/reconnect; relay restart; host disconnect; explicit and background-tab authority yield; simultaneous pickup claims; every damage/down/revive path; scene/run reset; and reconnect after the event TTL. For an arena, also test everyone leaving and one player returning later — the world must resume from the persisted snapshot (correct HP, entities, and rebased timers), never reset to a fresh run. Success means one avatar per live peer, one shared outcome per intent, no stale transform replay, no HP/clock/entity snapback, no guest world writes, and continued play after authority or relay migration.
