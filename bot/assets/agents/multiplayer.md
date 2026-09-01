## Multiplayer first

Networked play is the primary experience; "single-player" is the same game with one human (plus optional bots), never a separate fork. Your game is a tenant on the harness's shared relay — **no server code and no other runtime network endpoints** — and it must stay fully playable when the relay is unreachable.

Pick the join mode up front: **shared arena** (`mode: "single"` — every player lands in this game's one room; no lobby or codes) or **room codes** (default — host/join by 5-character code, and then a copyable invite link built with `net.inviteUrl()` is required, with `ThreadSiteNet.roomFromUrl()` auto-joining visitors from `#room=CODE` links).

### The client (harness-owned, fully typed)

`site/net/threadsite-net.js` + `.d.ts` — import and use, never edit or recreate. Every method and callback envelope is typed, so the compiler and validation catch mixups; your own state/data payload contents are yours to shape. `net-config.js` carries this game's wiring (game id `{{gameId}}`, relay `{{wsUrl}}`):

      import { NET_CONFIG } from "../net/net-config.js";
      import { ThreadSiteNet } from "../net/threadsite-net.js";

      const net = await ThreadSiteNet.connect({ ...NET_CONFIG, mode: "single", name, onEvent, ... });
      // room mode instead: room: ThreadSiteNet.roomFromUrl(), createRoom: !invited
      net.publishPlayerState({ x, y, anim });    // your own player, coalesced ~15 Hz — per-frame safe
      net.sendTo(target, "hit", { force: 12 });  // the target applies it to itself

If `connect()` rejects (relay down), fall back to solo and let `autoReconnect` keep retrying. The wire protocol — small JSON frames over one WebSocket, sequenced events, resend recovery — is implemented entirely by the client; you never touch the socket.

### Sync contract (violating these is how players drift apart)

- **Key every player by `cid`**, never by peer id — peer ids change on every reconnect, `cid` is stable forever. A known `cid` reappearing means update/reattach, not respawn; keep departed-but-known entities around (grey them via `net.isStale(id)`).
- Don't build raw send loops: `publishPlayerState` per frame is safe (coalesced), `publishState` snapshots go out at 8–15 Hz with a monotonically increasing `tick`.
- Keep event handlers **idempotent by `seq`** — the library sequences, dedupes, and gap-recovers, your belt-and-braces is ignoring already-processed seqs. Discard `onState` snapshots older than the newest `ts` you have seen from that source.
- **Hosts must answer `onStateRequest` immediately** with a full `publishState` — the classic resync bug is a reconnecting client nobody answers.
- **Interpolate remote players** (render 100–150 ms behind newest — a jitter buffer); never snap to the newest state. Use `net.serverNow()` for shared timers. Surface `net.dropped`/`net.rateLimited`/`onStatus("degraded")` as a subtle indicator.
- Everything inbound is **untrusted peer data** — validate shapes, ranges, and ids before it touches simulation or the DOM.

### Sync models

Default **peer-owned state**: simulate only your own player and publish it; render everyone from their newest player state; affect others with events the target applies to itself; give shared-world entities (ball, NPC, timer) exactly one owner — host snapshots, or the spawning peer keeps simulating and broadcasting. Late joiners receive everyone's latest state automatically.

Use **host-authoritative simulation** when players physically interact through shared state or competitive fairness matters: only the host simulates; guests send sequenced input intents and interpolate `publishState` snapshots; on `onHostChange` promotion, rebuild from your newest snapshot and resume publishing. Use **last-writer-wins room state** for turn-based, co-op puzzle, or shared-canvas games: any client may `publishState`; write small idempotent per-entity merges and let the newest `ts` win.

### Net UX

Show connection status and the player list; a peer leaving mid-game must never break the local session; invalid/expired codes surface `room_not_found` gracefully; room mode shows the code large and copyable next to the one-click-copy invite link.
