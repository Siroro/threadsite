# ThreadSite networking: gotchas, budgets, and debugging

Harness-owned reference, regenerated every turn — never edit. Read it before writing netcode and whenever sync, authority, or snapshots misbehave.

The client is `site/net/threadsite-net.js` (typed by `threadsite-net.d.ts`); identity comes from `../net/net-config.js`. It assumes the rules in AGENTS.md's multiplayer section; this file covers what goes wrong when they are bent.

## Budgets and numbers (defaults)

* Player transforms coalesce to **25 Hz** (`transformHz`, 1–60). Complete worlds publish at **10 Hz** (`publishHz`, 1–30).
* One client frame must stay under **256 KB** — `publishWorld` throws `frame_too_large` beyond it. The relay accepts up to 264 KiB by default; the lower client cap provides headroom so an oversized world fails locally instead of dropping the relay connection.
* The relay rate-limits every connection to **60 frames/s** (burst 120), shared by *all* sends. `transformHz` + `publishHz` + events must stay comfortably below it. 60 Hz transforms plus 30 Hz worlds will trip `rate_limited` and updates will start dropping.
* Reliable events live **3 s** (`eventTtlMs`, 250–30000), queue at most 128 while offline, and retry once after rate limiting. Event handling should remain idempotent.
* Ephemeral signals coalesce latest-wins per `(type, target)` at **20 Hz**.
* Remote transforms sample **45–150 ms in the past** using an interpolation delay adaptive to measured transit jitter, and extrapolate at most **100 ms** past the newest sample by default.
* Peers whose transforms go silent for **>2 s** vanish from `sampleAll()` / `latestAll()` / `listAlive()` / `nearest()`.
* Reconnect backoff is roughly 0.5–8 s; half-open sockets are detected within ~30 s.
* The relay re-elects a **stalled host**: a host that publishes no world for **15 s** (`GAMESERVER_HOST_STALL_MS`) while another peer is connected is demoted to guest and authority moves to that peer. Healthy hosts publish at 1 Hz minimum, so this never fires in normal play; a lone silent host (nobody waiting) is left alone.
* `close()` is permanent. Other connection loss automatically reconnects and re-runs the bootstrap gate.

## Player identity

* Use **peer IDs** (`peer.id`, event/intents `from`) as the identity of a currently connected player.
* Never key active avatars, revive targets, transform state, routing, or live gameplay ownership solely by `cid`.
* `cid` is continuity/session metadata, not live transport identity. Simultaneous peers must remain separate even if their metadata matches.
* Peer IDs can change after reconnect. Do not persist a peer ID inside durable world state as though it were a permanent player identity.

## The complete-world envelope

This is the #1 source of confusion.

* Lifecycle callbacks (`capture` / `restore` / `present`) receive the **decoded** world:

```ts
{ runId, tick, state }
```

`state` is your actual game state.

* Raw `world.onSnapshot()` / `onWorld` / `net.world.snapshot` receive the **wire snapshot**. When using the standard world lifecycle, your actual game state is:

```ts
snapshot.state.state
```

because `snapshot.state` is the world envelope.

* Snapshots must contain **JSON-serializable DTO data**. Never put Phaser/THREE objects, physics bodies, class instances, functions or circular object graphs into snapshots. Capture plain objects, arrays, strings, booleans and numbers instead.

* Circular/non-serializable data causes `bad_frame`. Lifecycle `publishNow()` catches publication errors, logs them and returns `false`; raw publication may throw.

* `tick` must be a non-negative safe integer that never decreases within one run.

* Guests drop snapshots whose `runId` matches the current run but whose `tick` is less than or equal to the last accepted tick.

* Therefore, **generate a fresh `runId` for every run/reset**. Reusing a run ID while rewinding tick can cause guests to ignore the new run forever.

* `schemaVersion` is the migration gate. If the snapshot shape changes, bump it. Older snapshots — including persisted ARENA state — are rejected and `onAuthorityStart` receives `recovered: false`.

* Do not partially apply incompatible persisted state. If recovery fails, initialise a fresh world.

* `restore` must **replace all shared authoritative state**. Merging restored state into the previous world causes ghost enemies, duplicate pickups and stale entities.

* `present` updates guest-side presentation only. It must never advance authoritative simulation.

* `capture()` runs at `publishHz` while host. Keep it synchronous and cheap.

* **Boot order is fixed: initialize everything, then connect, then start.** Authority acquisition, world restore, and the publish loop all begin inside `createAuthoritativeSession()` / `connect()` — during the `await`, before any code after it runs. This yields one non-negotiable rule:

  **Every lifecycle callback must be fully working the moment the session is created.** `capture()` must return a valid world (`tick: 0` with fresh state is fine) from its very first call — never throw or depend on handlers installed later (e.g. on a Play-button click). `restore` / `present` / `onAuthorityStart` can also fire during that `await` (a recovered or persisted world restores before authority starts), so every value they touch — game scenes, UI refs, renderer state, module-level `const`s — must already be initialized **before** the `createAuthoritativeSession()` call, never after the `await`.

  Concretely, write boot as:

  1. create UI / HUD / scene / renderer objects and any state the callbacks read
  2. `await` the session with all world options inline and final
  3. wire input, engine loop, and user-triggered start handlers

  Never: declare scene/UI `const`s after the session `await` and use them inside `onSnapshot`/`present`/`restore` (a `ReferenceError: … before initialization` is logged as `world authority startup failed`, the controller yields host, and the game is left hostless — with no visible error, so validation passes), and never defer installing world handlers to a Play-button handler (`capture()` then fails every publish tick — again invisible to validation, and guests get no world). Because these failures produce only runtime console output that neither you nor the harness's checks can see, an apparently clean build proves nothing about them: the boot-order rule above is the only defense.

* Keep complete snapshots compact:

  * round coordinates where precision is unnecessary
  * omit data that can be derived
  * cap collections sensibly
  * avoid cosmetic/transient data
  * use `net.transforms` for **player/peer transforms**

Shared enemies, bosses, projectiles and authoritative world entities still belong in the complete world snapshot unless the game deliberately implements another safe presentation channel.

Anything that must survive host migration, an empty ARENA, or relay restart must eventually be represented in the complete world returned by `capture()`. Reliable events alone are not durable world state.

## Authority and bootstrap

* Authoritative publishing throws `not_ready` until `net.authority.ready` becomes true.

* The welcome packet's cached or persisted world must be processed before a newly elected host is allowed to publish.

* Never bypass this protection. A fresh world should only be created in `onAuthorityStart` when `recovered === false`.

* `net.world.restored` reflects whether host authority began from an existing relay/persisted snapshot.

* Drive **all shared simulation and mutation** from the authoritative lifecycle:

  * `onAuthorityStart`
  * `onAuthorityStop`
  * `net.authority.isHost()`

Do not cache "I am host" once at startup.

Authority can migrate after:

* disconnect
* `yield-host`
* background-tab auto-yield
* the relay's host-stall watchdog (a connected host stopped publishing while peers waited — e.g. a frozen or pre-watchdog tab whose socket still answers pings)

It does not automatically return to the previous host.

* If the current host tab becomes hidden and another peer exists, ThreadSiteNet automatically yields authority by default.

* `isHost` becomes false while disconnected.

Stop authoritative shared-world mutation until authority is reacquired. Local UI and input may continue, but do not treat offline simulation as shared truth. `restore` reconciles authoritative state after reconnect.

Reconnect creates a new live network session: peer IDs and transform buffers may change. Rebuild live-player references from the current peer list rather than waiting for an old peer ID to return.

* The host does not receive its own world snapshots through `world.onSnapshot()`. `world-ack` updates internal state silently.

Track the host's own run using `net.run` / local authoritative simulation.

* `net.world.publishNow()` returns `false` if:

  * this client is not host
  * the controller is disposed
  * `capture()` failed or returned an invalid world
  * publication failed

Treat failure as non-fatal unless the game explicitly needs to surface it.

## Durable ARENA worlds

`mode: "single"` is the persistent public ARENA mode.

The relay persists the latest authoritative ARENA world to disk. Private code-addressed rooms remain ephemeral.

When the final player leaves:

1. the latest authoritative world is flushed
2. the in-memory room may later expire
3. the persisted snapshot remains on disk

When somebody later rejoins:

1. a fresh room generation is created
2. the first peer becomes host
3. the persisted world is re-stamped with the new relay generation/epoch
4. it is included in `welcome`
5. the client restores it before authoritative publication begins

Relay restarts therefore do **not** automatically wipe ARENA worlds.

Persisted ARENA worlds are treated as **paused while empty**. Do not simulate offline elapsed time.

Game snapshots must carry their own `schemaVersion`, `runId`, `tick` and whatever simulation state is required to resume safely.

Only the latest complete authoritative world is durable. The relay does **not** persist peer IDs, host identity, presence, player transforms, sockets, event queues, interpolation buffers, or old authority metadata.

Persistence is snapshot-based, not event-based. If an important action changes durable gameplay — for example a boss dies or a chest is claimed — that result must be reflected in `capture()` rather than existing only as an event.

## Transforms

* Call `net.transforms.publish()` continuously from the player update loop, including while stationary.

The library coalesces calls to `transformHz`; do not manually throttle the game below that frequency.

Silence for >2 s causes the remote player to disappear from `sampleAll()`-style queries.

Transforms are transient/latest-wins state. Old movement is not replayed as durable gameplay after reconnect; rebuild remote movement from fresh post-reconnect transforms.

* `sample()` / `sampleAll()` / `listAlive()` / `nearest()` are **rendering-only**. They return time-shifted presentation transforms, deliberately rendered **45–150 ms behind relay time** (adaptive to jitter) so motion stays smooth.
* `latest(peerId)` / `latestAll()` return the **newest received** transform — no interpolation, extrapolation, or render delay. This is the intended freshness source for host-side player-position checks (AI targeting, range and interaction validation) when the game does not maintain its own canonical guest-player position. `latest()` returns `null` and `latestAll()` omits the peer until it has published a transform — including after reconnect, until the first fresh sample arrives.
* Peer transforms are client-reported input either way. The host validates them with game-specific tolerances and remains authoritative over gameplay outcomes; never blindly trust a claimed position or outcome.

Never resolve authoritative gameplay such as:

* damage
* pickup ownership
* chest claims
* revives
* melee range
* authoritative collision

from time-shifted `sample()` reads; use `latest()` or host-owned world state for the position input, and let the host decide the outcome.

The authoritative host should validate gameplay using the state it owns, allowing reasonable tolerance for network/interpolation delay where appropriate. If shared AI needs remote player positions beyond what the complete world state already carries, read them from `latestAll()` — never from sampled presentation transforms.

* Numeric transform fields interpolate.

Discrete values such as:

* `alive`
* `runId`
* string animation state
* string `facing`

switch at sample boundaries.

Gameplay-critical discrete state should generally live in complete world state or reliable events rather than depending solely on transform interpolation.

* Use:

```ts
net.transforms.teleport(...)
```

for discontinuities such as:

* spawning
* respawning
* portals
* large corrections
* instant relocation

Using ordinary `publish()` makes observers interpolate between the two positions, appearing as a high-speed slide.

* `publish()` / `teleport()` require finite `x` and `y`.

NaN or infinite coordinates throw `bad_transform`.

## Presence

Use `net.presence` for **slow-changing per-player metadata**, for example character choice, cosmetics, ready state, team, or other lobby/display information.

Presence is separate from transforms and complete world state. The client's local presence value is automatically re-sent after reconnect.

Do not use presence for position, velocity, combat, damage, rapidly changing animation, or authoritative shared state.

Presence is live peer state, not durable ARENA state.

## Snapshot entity reconciliation

For guest-side mirrors of authoritative collections such as enemies, pickups or props, prefer:

```ts
net.entities.syncCollection(...)
```

Its `apply()` method creates missing IDs, updates existing IDs, and removes entities absent from the latest snapshot. The controller owns the entity map; iterate `controller.values()` for per-frame presentation. Do not create a second entity map unless necessary.

Entity IDs must be stable strings or finite numbers. Duplicate IDs in one snapshot throw `duplicate_entity_id`.

This helper manages local presentation objects only; it does not make those entities authoritative or transmit them.

Prefer it over hand-written create/update/remove loops when presenting snapshot collections, as those commonly cause ghosts or duplicates after restore and host migration.

### Smooth guest presentation of snapshot entities

How a guest moves entities between snapshots (arriving at `publishHz`, say 10 Hz) decides whether the game feels smooth or "laggy":

* **Interpolate between the last two snapshots at a fixed render delay.** Render each entity at `now - renderDelayMs` where `renderDelayMs` is ~1 to 1.5 snapshot intervals (10 Hz → 100–150 ms), blending position between the previous and current snapshot by elapsed fraction. Both endpoints are authoritative, so motion is smooth by construction and never snaps.
* **Never extrapolate to "now" from the newest snapshot as the default presentation.** Forward-predicting each entity by a full snapshot interval is wrong after every bounce, impulse, or turn — physics-driven and chasing entities then visibly snap at snapshot rate, which players read as severe lag even on a 10 ms connection.
* **Do not disable interpolation for fast entities.** A speed cap is only meaningful for extrapolation beyond the newest snapshot; between two known positions any speed interpolates cleanly. Zeroing interpolation above a speed threshold makes the fastest entities — explosions, debris, knockbacks — step at discrete snapshot positions.
* Keep a small optional extrapolation (≤ one snapshot interval) only to cover gaps while the next snapshot is late, and accept the tiny correction when it lands.
* The same trade-off already exists for remote players: `transforms.sample()` implements it; reuse it rather than re-deriving.

## Events, intents and signals

### Reliable events

Use reliable events for discrete actions that matter:

* confirmed rewards
* revive notifications
* interaction results
* important one-shot effects
* player lifecycle events

Reliable events have IDs, dedupe and a short reconnect TTL.

A targeted reliable event can throw `bad_target` if the peer has just disconnected. Catch it when peer departure is expected.

**Generic reliable events are not automatically scoped to `runId`.** A reliable event queued near the end of one run can arrive after reconnect when another run has started.

If an event only makes sense within one run, include its `runId` in the payload and reject it when:

```ts
!net.run.isCurrent(runId)
```

Prefer `net.intents` for guest → host gameplay requests because intents already carry and validate the active run ID.

### Intents

Use:

```ts
net.intents.send(...)
```

for client requests that must be validated by the authoritative host, such as:

* hit attempts
* pickup claims
* interact requests
* revive actions
* purchases
* ability requests

`intents.send()` throws `no_active_run` until a run exists.

For the host, a run exists after the first valid complete-world publication.

For guests, it exists after the first accepted complete-world snapshot.

Every intent automatically carries the current `runId`.

The host-side intent router rejects intents whose `runId` no longer matches, so actions sent during/reset across a run transition may safely disappear.

The host must still validate:

* sender
* payload shape
* target/entity existence
* distance/range
* cooldown
* ownership
* current player state
* current world state

The intent layer validates synchronization context, not game rules.

### Ephemeral signals

Ephemeral signals are latest-wins and intentionally replaceable.

Good uses:

* aim direction
* cursor position
* cosmetic emotes
* temporary presentation data

Never use ephemeral signals for:

* damage
* rewards
* pickups
* death/revive
* phase transitions
* inventory changes
* anything that must survive loss

## Clocks and timers

Use:

```ts
net.clock.now()
net.clock.after(ms)
net.clock.elapsed(ts)
net.clock.remaining(ts)
```

for shared relay-time calculations.

Never compare relay timestamps with `Date.now()` directly.

For **durable gameplay timers**, persist remaining or elapsed simulation durations rather than absolute relay timestamps.

Example:

```ts
remainingMs = targetTs - net.clock.now()
```

Snapshot:

```ts
{ remainingMs }
```

Restore:

```ts
targetTs = net.clock.now() + remainingMs
```

This matters because durable ARENA worlds pause while empty. An absolute wall-clock deadline would incorrectly consume time while nobody was connected.

Examples that should use duration-based persistence:

* wave timers
* boss cooldowns
* buffs/debuffs
* spawn timers
* respawn timers
* timed objectives
* temporary hazards

## Host simulation rules

Only the authoritative host advances shared world simulation.

Guests may:

* simulate their own responsive local player presentation
* render/interpolate remote state
* predict cosmetics
* send intents

Guests must not independently mutate authoritative:

* enemy HP
* boss HP
* enemy AI
* world pickups
* loot/chests
* shared timers
* waves
* authoritative projectiles
* objective state

When authority changes, the old host must stop shared simulation immediately and the new host must start only after restore/bootstrap has completed.

## Debugging table

| Symptom                                         | Likely cause                                                          | Fix                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Remote players stop rendering                   | Transform silence >2 s                                                | Keep calling `transforms.publish()` from the player update loop             |
| Guest world never updates                       | `capture` threw, invalid world, non-monotonic tick, or reused `runId` | Check console; use fresh `runId` and monotonically increasing integer tick  |
| `[threadsite-net] world.capture failed` repeating from load/title screen | `capture()` (or state it reads) is installed only after a user action — the publish loop starts inside the session `await` | Make `capture()` valid from its first call (return an initial empty world) and install handlers before/just after the session resolves |
| `world authority startup failed` with a `before initialization` ReferenceError, then no host | `restore`/`present`/`onSnapshot` callback read state declared after the session `await` (TDZ) — restore can fire during the await, and the controller yields host on the throw | Initialize everything lifecycle callbacks touch before creating the session; construct scenes/UI first, connect second |
| A run reset is ignored by guests                | Tick rewound while reusing the same `runId`                           | Generate a new `runId` for every reset                                      |
| World wiped after rejoin                        | Fresh state was published before restored state was processed         | Initialise worlds only from the authority lifecycle; respect `not_ready`    |
| Snapshot rejected immediately after game update | `schemaVersion` mismatch                                              | Expected for incompatible persisted state; initialise a fresh world         |
| Ghost/duplicate entities after host migration   | `restore` merged instead of replacing                                 | Fully replace authoritative shared state                                    |
| `frame_too_large`                               | Serialized client frame exceeded 256 KB                               | Slim snapshot, round values, remove transient data, cap collections         |
| Guest entities jitter, rubber-band or "fly around" at snapshot rate | Guest presentation extrapolates to now from the newest snapshot (wrong after every bounce/turn) or disables interpolation for fast entities | Interpolate between the last two snapshots at a fixed render delay; cap extrapolation, never zero interpolation |
| `rate_limited`, choppy networking               | Combined transforms/world/events too close to 60 frames/s             | Reduce `transformHz`, `publishHz`, or unnecessary events                    |
| An intent does nothing                          | No active run yet or stale `runId` caused safe rejection              | Send after world exists; tolerate actions crossing run resets               |
| Reliable event affects a new run                | Generic reliable event survived reconnect without run scoping         | Include `runId` in run-specific reliable events and validate it             |
| Every timer instantly ends after durable resume | Absolute deadline was persisted                                       | Store remaining/elapsed simulation time and rebase on restore               |
| Remote player slides across map after teleport  | `publish()` used for discontinuity                                    | Use `transforms.teleport()`                                                 |
| Game freezes when host tab hides                | Newly authoritative peer isn't advancing simulation                   | Drive simulation from authority lifecycle, never a cached startup-host flag |
| World frozen for everyone; an old or hidden tab is (or was) connected | That tab held host authority while its JS was frozen — the socket still answers the relay's pings, so nothing dropped it | Relay-side: the host-stall watchdog re-elects a waiting peer within ~15 s of the host going silent; keep hosts publishing so it never triggers |
| `bad_world_sync` on startup                     | World lifecycle API mixed with raw world/authority callbacks          | Use one synchronization style; prefer the high-level lifecycle              |
| Host sees nothing in `world.onSnapshot()`       | Own world acknowledgements are silent                                 | Expected; use local authoritative state / `net.run`                         |
| Persisted ARENA restarts fresh                  | Snapshot schema rejected or capture never successfully persisted      | Check `schemaVersion`, `capture()` errors and relay persistence logs        |
| Persisted world misses an important action      | Result only existed as an event, not in complete world state          | Ensure durable outcomes are represented by `capture()`                      |
| Guests disagree about enemy/pickup state        | Guests are locally simulating authoritative entities                  | Host owns shared world; guests only present snapshots and send intents      |
| Player disappears after standing still          | Game stopped calling transform publish while idle                     | Continue publishing; library performs network-rate coalescing               |
| Player duplicates after reconnect               | Game treated CID or old peer ID as current live identity              | Build active players from current peer IDs                                  |
| Guest entities linger after snapshots           | Hand-written reconciliation failed to remove missing IDs              | Use stable IDs / `net.entities.syncCollection()`                            |
