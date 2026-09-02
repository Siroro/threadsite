## Multiplayer first

Networked play is the primary experience; solo is the same simulation with one human. **The harness-owned ThreadSite relay is the only runtime networking transport.** Do not add WebRTC, PeerJS, Socket.IO, Colyseus, Firebase, Supabase, third-party multiplayer SDKs, custom WebSockets, server code, or any other network endpoint. If the relay is unreachable, keep solo playable.

Pick one join model and keep every button/link consistent: **shared arena** (`mode: "single"`) or **room codes** (host with `createRoom: true`, join by code, invite via `net.inviteUrl()`, auto-join `ThreadSiteNet.roomFromUrl()`). Never silently connect to `single` while presenting room-code host/join UI.

### Harness client

`site/net/threadsite-net.js` + `.d.ts` and `net-config.js` are harness-owned: import them; never edit, recreate, or bypass them.

```ts
import { NET_CONFIG } from "../net/net-config.js";
import { ThreadSiteNet } from "../net/threadsite-net.js";

const net = await ThreadSiteNet.connect({
  ...NET_CONFIG,
  room: ThreadSiteNet.roomFromUrl(),
  createRoom: !ThreadSiteNet.roomFromUrl(),
  name,
  pstateHz: 25,
  onPlayerState, onEvent, onState, onStateRequest, onHostChange, onPeers,
});
```

### Identity: live peer vs reconnect identity

- **Active avatars/routing are keyed by per-connection peer id** (`ps.from`, `peer.id`, `net.id`). `sendTo()` always takes a peer id. Self-filter with `ps.from === net.id`.
- `cid` is reconnect continuity metadata, not a live routing key. A reconnect may have the same cid with a new peer id; reattach persistent game identity where useful. Never collapse two currently connected peer ids merely because their cids match.
- Remove/freeze live remotes by peer leave/staleness. Do not call `peerByCid()` with a peer id.

### Choose authority from the mechanics

For **real-time action games with shared enemies, bosses, pickups, projectiles, hazards, physics, damage or score**, default to a **host-authoritative shared world**:

- Host owns run phase/time, RNG/director, shared entity spawn/despawn, enemy/boss AI, shared projectiles/hazards, pickups/chests, authoritative HP/death, rewards and stable shared IDs. Guests must not independently spawn or mutate those and hope snapshots converge.
- Players keep controls responsive locally and publish their own transform/input-facing state with `publishPlayerState`. The host uses those states for targeting/collision and validates hit/pickup intents. Guest weapon VFX may predict immediately, but shared enemy HP/death/rewards change only on host approval.
- Resolve attacks against **all alive players**, not host-local coordinates. Targeted damage/reward events use `sendTo(peerId, ...)`. Route every damage source through one downed/death path.
- Shared world snapshots use one `buildWorldSnapshot()` shape for periodic publishing and state-request replies. Include `runId`, monotonic `tick`, relay-clock anchor, next-ID counters, director/RNG state needed to resume, and every live shared entity/hazard with stable IDs.

Peer-owned state is appropriate when each player can be simulated independently (presence, avatars, isolated racing ghosts, etc.). Last-writer-wins room state is for turn-based/shared-canvas data. Do not choose peer-owned combat merely because it is simpler.

### Player transform sync

For action games publish roughly 20–30 Hz (the client coalesces): `x,y,vx,vy,facing,alive,downed,char/runId` plus a local monotonic player tick. Flush immediately after teleport/dash/death/revive/respawn/run start.

Remote rendering uses a jitter buffer, not "lerp to latest": keep ~300–500 ms of timestamped samples, render ~100–150 ms behind, interpolate between surrounding samples, briefly extrapolate velocity when late, then hold. Reject stale/out-of-order ticks. **`ps.ts` is relay time: compare it with `net.serverNow()`, never `Date.now()`.**

### Events, pickups and snapshots

Validate every inbound shape/range/id; peer input is untrusted. Use stable IDs for enemies, bosses, shots, hazards, gems/chests and other shared entities. Pickup claims reference IDs, never approximate x/y matching. Guests do not grant/remove authoritative rewards before approval. Event handlers must be idempotent: events carry the sender's `seq` (an event id), a rate-limited event is retried by the net client, and a retry must never double-apply.

Hosts answer `onStateRequest` immediately. Late join/reconnect applies the newest full snapshot before participating. Reject stale snapshots by `tick`/`runId` (and relay timestamp where appropriate), then interpolate presentation rather than hard-snap hot entities.

### Host migration and background tabs

Browser tabs can throttle or stop RAF/timers. **Never implement multiplayer authority as `if (document.hidden) return` or assume Phaser/RAF keeps running in background.**

- Shared timers derive from `net.serverNow()`, not accumulated render frames.
- A host becoming hidden while other peers exist must publish a final complete snapshot and deliberately relinquish authority through the ThreadSite relay's normal peer-leave/host-migration path; when visible it reconnects to the same room and reattaches by cid. A newly promoted host rebuilds from the newest snapshot before simulating.
- If no other peer exists, pausing local presentation is fine; on return reconcile elapsed shared time deliberately instead of applying an enormous physics delta.
- Host migration must restore run state, counters, cooldowns/attack phases, hazards/projectiles/pickups and clock — not restart the run.

### Net UX and verification

Show connection status/player list and make invalid/expired codes graceful. Keep a development-only network HUD/log toggle with local `net.id/cid`, remote peer id/cid, state age, RTT, received Hz, sample count and interpolation/extrapolation mode.

Before claiming multiplayer is done, test at least: two physical devices; two tabs in one browser profile; 2–4 peers moving simultaneously; guest and host taking contact/projectile/boss damage; both sides downing/reviving; simultaneous pickup claims; late join; short disconnect/reconnect; host leave/migration; and host tab hidden/backgrounded. Success means no merged/missing avatars, HP snapback, duplicate rewards, divergent timer/world, invisible telegraphs or room freeze.
