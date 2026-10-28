# Multiplayer games

Games default to **shared-arena multiplayer** (or invite-code **rooms**, or none at all, chosen at `/makegam` and switchable with `/site multiplayer`). Networked games share one `gameserver` container for the whole deployment; there is no per-game instance, process, or provisioning step. Multi-tenancy is addressed by two ids the harness controls:

- **game id**: the stable harness tenant key, initially derived from the published site slug and retained across renames;
- **room code**: a short code (for example `AB3CK`) namespaced per game, so the same code in two games is two different rooms.

A single relay therefore serves any number of games and rooms per game, bounded only by configured caps.

## Global leaderboards in every gameplay mode

Singleplayer and multiplayer games use the same small, dedicated `ThreadSiteLeaderboards` browser client, seeded under `site/leaderboards/` with its TypeScript declarations and stable game configuration. `LEADERBOARDS.md` explains the API, and the `leaderboards` skill covers ranking design. It has no dependency on the full gameplay client: each score/list operation makes a short score-only request through the existing `/ws` endpoint without joining a room, selecting a host or synchronizing gameplay. Existing proxies and `GAMESERVER_PUBLIC_URL` serve both APIs. `MULTIPLAYER_ENABLED=false` disables gameplay wiring, not global rankings.

Boards are global within one game and board key, shared across rooms and singleplayer/multiplayer modes. Both clients use the same anonymous browser credential and persistent store, so existing scores remain visible and the same player does not gain a duplicate identity. Names are required before submission; they are not unique identities. Rankings retain personal bests, sort direction and tie ordering, persist across relay restarts, and are removed with the game, including games that were always singleplayer. Score-only requests cannot access private saves.

The harness pins the game ID before provisioning and preserves it across renames and architecture switches. It repairs the dedicated files before and after turns and restores them for publishing/reverting. The compiler bundles only the score client when gameplay is singleplayer; unbundled files and declarations stay in Git and are excluded from static publication. Older `net.leaderboards` callers remain compatible, while new code uses the dedicated library in both modes.

Gameplay remains playable offline. Score requests time out, never automatically reconnect or replay, and report uncertain submissions so the game can refresh the board before deciding whether to retry. Local records must not be presented as global rankings. Scores remain client-reported. The integration check `npm run test:leaderboards` in `gameserver/` launches an isolated relay and checks both clients, isolation, limits, restart durability, deletion and offline timeouts.

## Gameplay wiring for multiplayer projects

On creation (and re-checked before every mutation, in case the agent removed them):

- the committed `site/net/threadsite-net.js` + declarations, regenerated from the harness's TypeScript networking source (`bot/networking/threadsite-net.ts`, built with `npm run build:net`) and bundled into the minified game output. The zero-dependency client owns reconnects, half-open detection, bounded backpressure, expiring reliable events, relay clocks, transform interpolation/extrapolation, room generations, authority epochs and safe host handoff. `createAuthoritativeSession()` and the typed `world`, `transforms`, `intents`, `events`, `presence`, `clock`, `run`, and `entities` facades remove routine synchronization decisions and stable-ID reconciliation from generated games. `net-config.js` carries the game's tenant identity. The unbundled client and config stay visible in the Forgejo repo but are never copied to Apache.
- the engine packages in the harness-managed workspace `node_modules/` (three.js + Rapier compat + three-mesh-bvh for 3D projects, Excalibur for 2D projects), imported by bare package name and type-checked against their real declarations.
- a concise `AGENTS.md` multiplayer section covering the selected mode, state ownership, safe world lifecycle and offline fallback. The companion `NETWORKING.md` holds API usage, budgets, recovery details and troubleshooting; agents read it when implementing or debugging networking.

The first-turn prompt and the `sitebuilder` agent configuration both reinforce this: use the provided client, never write server code, never invent other runtime network endpoints.

## Protocol summary

Protocol v4 uses JSON text frames over one WebSocket per player. The relay owns a random room generation, explicit `hostId`, monotonically increasing authority epoch and world-state sequence. Only the current host for that generation and epoch can publish the shared world. Host disconnect and `yield-host` both migrate authority with the latest cached snapshot attached, so the new host restores before simulating. Hosts receive cache acknowledgements too, allowing a reconnecting client to restore and republish the last complete world if a relay restart erased room memory.

Player transforms are transient latest-wins state with monotonic relay timestamps, never replayed after reconnect. Application events carry reload-safe unique IDs, expire after a short TTL, retry once after rate limiting, and are deduplicated per sender. The relay stays game-agnostic: it stores the newest complete world and live peers' newest player state, stamps relay time, and never interprets or simulates gameplay.

Generated games use explicit channels: reliable events are TTL/retry/dedupe protected, ephemeral signals drop instead of building stale backlogs, host-routed intents carry the accepted run ID and are rejected before game code when stale, and slow-changing presence is cached separately from high-frequency transforms. Stable-ID `syncCollection()` controllers reconcile guest entity views from complete snapshots without embedding game rules in the relay.

## Relay configuration

```dotenv
MULTIPLAYER_ENABLED=true
GAMESERVER_PUBLIC_URL=ws://localhost:8090/ws
GAMESERVER_INTERNAL_URL=http://gameserver:8090
GAMESERVER_PORT=8090
GAMESERVER_MAX_PEERS_PER_ROOM=16
GAMESERVER_MAX_ROOMS_PER_GAME=256
GAMESERVER_MAX_MESSAGE_BYTES=270336
GAMESERVER_MAX_BUFFERED_BYTES=1048576
GAMESERVER_RATE_PER_SECOND=60
GAMESERVER_RATE_BURST=120
GAMESERVER_ROOM_TTL_MS=600000
# A host silent this long while another peer waits loses authority.
GAMESERVER_HOST_STALL_MS=15000
# permessage-deflate kill switch (0 = off); snapshots compress, hot transforms do not.
GAMESERVER_PERMESSAGE_DEFLATE=1
GAMESERVER_ALLOWED_ORIGINS=
GAMESERVER_STATE_DIR=/data/threadsite-relay
GAMESERVER_PERSIST_INTERVAL_MS=1000
GAMESERVER_MAX_SAVED_PLAYERS_PER_GAME=10000
GAMESERVER_MAX_SAVE_BYTES_PER_GAME=16777216
```

- The bundled/local default `ws://localhost:8090/ws` works out of the box next to the bundled static Apache profile.
- For production behind host Apache, proxy `wss://games.example.com/ws` (see below), set `GAMESERVER_PUBLIC_URL` to that URL, and optionally lock browsers down with `GAMESERVER_ALLOWED_ORIGINS=https://sites.example.com` (comma-separated origins, scheme + host, no path; blank allows any).
- `./scripts/check-gameserver-proxy.sh` verifies both legs: the internal health endpoint and a real WebSocket upgrade through the public URL.
- `GET /health` and `GET /stats` return games/rooms/clients counts; `/site-admin status` shows a one-line summary.
- Every connection is token-bucket rate-limited, frames and pending send buffers are size-capped, rooms have peer caps, and empty rooms are garbage-collected after `GAMESERVER_ROOM_TTL_MS`. Slow consumers are disconnected and recover through the normal reconnect/latest-state path.
- Set `MULTIPLAYER_ENABLED=false` to stop provisioning multiplayer files and rules into new game projects (existing published games keep working against a running relay).

## Durability: arenas persist, rooms do not

The relay periodically snapshots the latest authoritative world of each game's single-mode arena (one small JSON file per game under `GAMESERVER_STATE_DIR`, written atomically via temp-file + rename) and replays it to the first joiner after the room empties or the relay restarts. Only the opaque game snapshot is kept: peer ids, authority epochs, generations and sequences die with the session that created them, so stale pre-restart frames never validate. The compose file binds `./data/gameserver` so arena worlds survive container recreation. Room-code sessions stay in-memory only and recover through the client's auto-reconnect plus snapshot resync, or fall back to solo play.

`/site wipe` clears a game's shared relay state through the internal admin API (`POST /admin/games/<game>/reset`, bearer-token protected like the deletion endpoint): the durable arena snapshot and live rooms, and/or its leaderboard scores. The `scope` query takes `all` (the default), `world` or `scores`, and an unknown value is a `400` rather than a silent full wipe. Connected players are closed with a recoverable code and reconnect into a fresh, empty world; private save slots survive. The pinned card's **Wipe state** button opens a modal with one checkbox per scope (both checked) and runs the same reset on submit; the thread owner chooses in the Collaboration panel who may use either (owner & admins by default, or anyone in the thread; server administrators always). `/site-admin wipe` sweeps every game at once through `POST /admin/reset` with the same `scope` values.

## Personal saves and leaderboards

Both networked modes support personal JSON save slots through the gameplay client. All gameplay modes use the separate global leaderboard client. Rankings are independent of room codes, arena world snapshots and host authority. Generated projects stay static; the harness owns server storage. Singleplayer games use local saves and the dedicated client for global scores, without importing or connecting the gameplay client.

```ts
import { ThreadSiteNet } from "../net/threadsite-net.js";
import { NET_CONFIG } from "../net/net-config.js";
import { ThreadSiteLeaderboards } from "../leaderboards/threadsite-leaderboards.js";
import { LEADERBOARDS_CONFIG } from "../leaderboards/leaderboards-config.js";

const net = await ThreadSiteNet.connect({ ...NET_CONFIG, mode: "single", name: "Player" });
const boards = new ThreadSiteLeaderboards({ ...LEADERBOARDS_CONFIG, name: "Player" });
const checkpoint = await net.saves.get<{ schemaVersion: number; level: number }>("progress-v1");
// Validate the loaded shape/schema before applying it to game state.
const saved = await net.saves.set("progress-v1", { schemaVersion: 1, level: 3 }, checkpoint.revision);
// await net.saves.delete("progress-v1", saved.revision);
await boards.submit("points-v1", 250); // higher is better
await boards.submit("time-ms-v1", 32150, { order: "asc" }); // lower is better
const top = await boards.list("points-v1", { limit: 10 });
// top = { order: "desc", entries: [{ playerId, name, score, updatedAt }] }
```

The example omits UI/error handling; generated games must catch failures and continue solo. Save at checkpoints, never per simulation frame. `net.saves.available` indicates support and current connectivity. The storage extension advertises `welcome.persistence.version = 1` on protocol v4; older clients still play, and newer clients detect older relays without attempting unsupported storage frames.

**Identity and privacy.** The client creates a cryptographically random 256-bit private token and retains it in localStorage under the stable game ID. The relay derives a game-scoped one-way public `playerId` from that token; it never echoes the credential or broadcasts saves. Live peer IDs and public `cid` metadata grant no save access. Reconnecting, changing rooms and returning in the same browser preserve progress. Storage denial falls back to a page-lifetime token (`net.saves.identityPersistent === false`); lack of secure randomness disables storage without preventing multiplayer. Clearing browser storage loses the anonymous identity; there is no Discord login or cross-device account recovery. Browser storage belongs to the origin: generated sites on the same origin share that trust boundary. Store game progress, not secrets or sensitive user records. A caller may supply `playerToken` to manage its own credential, but must keep it private and arrange persistence itself.

**Conflicts and delivery.** `saves.get()` returns `{ value, revision, updatedAt }`; a never-used slot has null value/time and revision 0. Set/delete requires that revision. A successful mutation increments it; deletion retains a tombstone so an old tab cannot recreate a deleted save using an obsolete revision. On `save_conflict`, re-read and deliberately reconcile the change. Requests are bounded to 16 in flight per client and time out after 10 seconds. They are not queued or replayed after disconnect. A `storage_uncertain` error means a write may have committed: re-read after reconnect before retrying. Offline progress can remain local, with an explicit merge when connectivity returns.

**Board design.** A board is one competition, not a feed of runs. Each board stores one personal best per persistent player, so render one row per player; attempts and run history belong in a save slot or a separate history view, never as extra rows in a ranking table. Use one game-wide board when runs are directly comparable; add boards for campaign levels/operations, modes, or rotating challenges when each is a separate contest. Each board must be presented on its own, chosen by a tab or selector; never concatenate boards into one table, which repeats players and compares incomparable scores. A career aggregate belongs on its own career board and tab, alongside per-level boards rather than merged with them. Keep keys stable and descriptive, version them when scoring rules change, and keep within the 16-board cap so each visible board has entrants.

**Rankings.** Each game has up to 16 named boards, with one personal best per persistent player on each board. The first successful submission fixes descending or ascending order; conflicting order returns `board_order_conflict`. Use a new versioned board key when scoring rules change. Equal/worse submissions leave the entry untouched; ties sort by earliest best-score timestamp, then player ID. Names come from sanitized connection names and change only with an improved score. List returns 1–100 entries (default 10). Treat names as text in UI. Scores are client-reported: the relay validates shape, isolation and bounds, not gameplay legitimacy or anti-cheat rules.

**Storage and limits.** `players.sqlite` is created lazily inside `GAMESERVER_STATE_DIR`. SQLite WAL transactions use full synchronization and commit before acknowledgement, independently of the arena flush interval. Save-byte quotas use a transactional per-game counter, initialized from existing saves on upgrade and updated with each save mutation. Existing `<game>.json` worlds remain compatible and room world snapshots remain ephemeral. Preserve the whole state directory, including SQLite WAL files, when copying stopped state; use a consistent SQLite backup for live copies. Project deletion removes its saves, boards and scores as well as its world, and retains the existing deletion tombstone to block stale clients. Admin inventory includes storage-only tenants after restarts.

| Limit | Default |
| --- | --- |
| Save slot value | 64 KiB serialized JSON |
| Slot names per player | 16, including deleted names |
| Persistent players per game | 10,000 (`GAMESERVER_MAX_SAVED_PLAYERS_PER_GAME`) |
| Total live save JSON per game | 16 MiB (`GAMESERVER_MAX_SAVE_BYTES_PER_GAME`) |
| Leaderboards per game | 16 |
| Requests per connection | 5/s, burst 10, also subject to the ordinary frame limiter |

Slot and board keys use 1–48 ASCII alphanumeric/underscore/hyphen characters, starting with an alphanumeric character. Save data must be JSON and scores must be finite numbers. Capacity, invalid input, rate and storage failures return correlated errors; rejected mutations leave existing data intact. Public clients can create anonymous identities, so the player cap bounds records rather than guaranteeing one identity per person.

Build the relay and client before verification (`npm run build` in `gameserver/`, `npm run build:net` in `bot/`). From `gameserver/`, `npm run test:storage` exercises save conflicts, quotas, rankings and tenant cleanup; `npm run test:persistence` launches an isolated relay and checks browser identity, private access, disk failure recovery, crash durability and deletion. Neither uses live relay state.

## Proxying the relay

The relay container is published on `127.0.0.1:8090` only, so browsers reach it only through a proxy.

### Caddy

With the `caddy` Compose profile, multiplayer can share the sites hostname: set `GAMESERVER_PUBLIC_URL=wss://sites.example.com/ws` and `GAMESERVER_ALLOWED_ORIGINS=https://sites.example.com`. The [Caddy quickstart](deployment.md#caddy-quickstart) sets this up by default. Only the exact `/ws` path reaches the relay; health, stats and admin endpoints stay internal.

A separate games hostname is optional. Pass `--games-domain games.example.com` to the installer, or copy `caddy/vhosts/games.caddy.example` to `caddy/vhosts/games.caddy`, edit the hostname and set the same two `.env` keys as below. TLS is automatic. Existing games hosts are kept on installer reruns; `--games-on-sites` switches back to the shared sites hostname.

### Apache / Virtualmin

1. Point DNS at the host and create a virtual server with a TLS certificate.
2. Enable the modules once: `sudo a2enmod proxy proxy_http proxy_wstunnel headers && sudo systemctl reload apache2`.
3. In the HTTPS (`*:443`) virtual host, add the directives from `apache/gameserver-vhost.conf.example`:

   ```apache
   ProxyPreserveHost On
   ProxyRequests Off
   RequestHeader set X-Forwarded-Proto "https"
   ProxyPass /ws ws://127.0.0.1:8090/ws
   ProxyPassReverse /ws ws://127.0.0.1:8090/ws
   <Location "/">
       Require all denied
   </Location>
   <Location "/ws">
       Require all granted
   </Location>
   ```

   Do **not** use Virtualmin's "Proxy Website" feature for this host: it generates a blanket `ProxyPass /` that would shadow `/ws` and expose `/health` and `/stats`.
4. Set in `.env` and recreate the relay:

   ```dotenv
   GAMESERVER_PUBLIC_URL=wss://games.example.com/ws
   GAMESERVER_ALLOWED_ORIGINS=https://sites.example.com
   ```

5. Verify with `./scripts/check-gameserver-proxy.sh`; it reports the internal health check and the public WebSocket upgrade separately.

### Cloudflare

Cloudflare's proxy (orange cloud) works for the relay: WebSockets are supported on every plan, and the net client's 10-second heartbeat keeps connections alive below Cloudflare's idle cutoff. Requirements:

- SSL/TLS mode **Full (strict)**; Flexible terminates at port 80 and never reaches the `/ws` directives in the HTTPS vhost.
- The public URL must use standard port 443 (Cloudflare does not proxy port 8090).
- Proxied hostnames complicate Let's Encrypt HTTP-01 renewal; use a bypass rule for `/.well-known/acme-challenge/*`, DNS-01 validation via the Cloudflare API, or a Cloudflare Origin CA certificate.

`./scripts/check-gameserver-proxy.sh` verifies the handshake through Cloudflare unchanged.
