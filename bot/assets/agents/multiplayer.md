## Multiplayer

Use only `../net/threadsite-net.js` with `NET_CONFIG` from `../net/net-config.js`. Preserve the injected game identity. The client owns transport, reconnect, clocks, host election and transform interpolation; do not replace them.

{{modeGuidance}}

Read `NETWORKING.md` before implementing networking or debugging sync; consult `site/net/threadsite-net.d.ts` for exact signatures.

### State ownership

- Each client owns its player's input/transform. Publish every update, even stationary; render remote players through `transforms.sampleAll()`. Use `teleport()` for discontinuities and live `peer.id` for identity, never `cid`.
- The host owns shared simulation, outcomes, timers, RNG and entity IDs. Guests present snapshots and send `net.intents`; validate sender, payload and game rules before changing state. Use host state or `transforms.latestAll()` for gameplay checks, never delayed presentation samples.
- Use `createAuthoritativeSession({ ...NET_CONFIG, world: { ... } })` for shared worlds. Initialize state/scenes/UI before connecting: `capture`, `restore` and `present` may run during the await. All callbacks must work immediately.
- Capture one complete JSON world `{ runId, tick, state }`. Restore replaces shared state before authority starts; present only updates guest visuals. Start/stop shared simulation with authority changes, including background-tab handoff; never cache startup host status.
- New runs need fresh `runId` values and monotonic ticks; snapshot shape changes need a `schemaVersion` bump. Durable arenas resume paused: persist durations, not wall-clock deadlines, and never publish fresh state over a restored world.
- Use smooth `entities.syncCollection()` for snapshot entity views. Reliable events carry discrete results; ephemeral events are replaceable cosmetics. Durable outcomes belong in snapshots; scope run-specific reliable events to `net.run`.
- For personal progression use `net.saves.get/set/delete`; for public personal bests use `net.leaderboards.submit/list`. Read the persistence section in `NETWORKING.md` first. Keep saves separate from shared world state, save at checkpoints, handle revision conflicts and offline play, and never broadcast the private player credential. Scores are client-reported, not verified by the relay.
- Follow the player-name rule under Games before creating the session: leaderboard entries and peer displays carry the connection's sanitized `name` (≤32 chars), which is fixed at connect time. Prompt prominently, persist the chosen name locally, and pass it as the `name` option on every connect; a rename applies from the next connection, and resubmitting then updates the stored entry's name.

### Rates and checks

For action games, use `publishHz` 15–20 and `transformHz` 25–30; leave event headroom below 60 frames/s and keep snapshots under ~200 KB (256 KB cap). Use `net.stats` to diagnose latency, size and dropped frames.

Keep the game playable solo if the relay is unavailable. Show connection status; room games also show codes/invite links and handle join failures. With a reachable relay, verify multiple peers, late join, reconnect/restart, host migration, run resets and conflicting actions; arenas must resume after everyone leaves. The isolated preview cannot verify these: state any untested cases.
