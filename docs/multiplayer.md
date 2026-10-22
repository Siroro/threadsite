# Multiplayer games

Games default to **shared-arena multiplayer** (or invite-code **rooms**, or none at all — chosen at `/makegam` and switchable with `/site multiplayer`). Networked games share one `gameserver` container for the whole deployment; there is no per-game instance, process, or provisioning step. Multi-tenancy is addressed by two ids the harness controls:

- **game id** — the published site slug, injected into each game as its tenant key;
- **room code** — a short code (for example `AB3CK`) namespaced per game, so the same code in two games is two different rooms.

A single relay therefore serves any number of games and rooms per game, bounded only by configured caps.

## What the harness injects into every game project

On creation — and re-checked before every mutation, in case the agent removed them:

- the committed `site/net/threadsite-net.js` + declarations — regenerated from the harness's TypeScript networking source (`bot/networking/threadsite-net.ts`, built with `npm run build:net`) and bundled into the minified game output. The zero-dependency client owns reconnects, half-open detection, bounded backpressure, expiring reliable events, relay clocks, transform interpolation/extrapolation, room generations, authority epochs and safe host handoff. `createAuthoritativeSession()` and the typed `world`, `transforms`, `intents`, `events`, `presence`, `clock`, `run`, and `entities` facades remove routine synchronization decisions and stable-ID reconciliation from generated games. `net-config.js` carries the game's tenant identity. The unbundled client and config stay visible in the Forgejo repo but are never copied to Apache.
- the engine packages in the harness-managed workspace `node_modules/` — three.js + Rapier compat + three-mesh-bvh for 3D projects, Excalibur for 2D projects — imported by bare package name and type-checked against their real declarations.
- the `AGENTS.md` multiplayer section — the full protocol reference, authority-selection rules (host-authoritative shared world by default for real-time action games; peer-owned state only when players are genuinely independent), stable live peer identity vs reconnect cid, relay-time interpolation, background-tab host handoff, host-migration notes, untrusted-input validation rules, and the required lobby/room-code/offline-fallback UX. Agents are told to design **multiplayer-first**, treating solo play as the same game with one player.

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
```

- The bundled/local default `ws://localhost:8090/ws` works out of the box next to the bundled static Apache profile.
- For production behind host Apache, proxy `wss://games.example.com/ws` (see below), set `GAMESERVER_PUBLIC_URL` to that URL, and optionally lock browsers down with `GAMESERVER_ALLOWED_ORIGINS=https://sites.example.com` (comma-separated origins, scheme + host, no path; blank allows any).
- `./scripts/check-gameserver-proxy.sh` verifies both legs: the internal health endpoint and a real WebSocket upgrade through the public URL.
- `GET /health` and `GET /stats` return games/rooms/clients counts; `/site-admin status` shows a one-line summary.
- Every connection is token-bucket rate-limited, frames and pending send buffers are size-capped, rooms have peer caps, and empty rooms are garbage-collected after `GAMESERVER_ROOM_TTL_MS`. Slow consumers are disconnected and recover through the normal reconnect/latest-state path.
- Set `MULTIPLAYER_ENABLED=false` to stop provisioning multiplayer files and rules into new game projects (existing published games keep working against a running relay).

## Durability: arenas persist, rooms do not

The relay periodically snapshots the latest authoritative world of each game's single-mode arena (one small JSON file per game under `GAMESERVER_STATE_DIR`, written atomically via temp-file + rename) and replays it to the first joiner after the room empties or the relay restarts. Only the opaque game snapshot is kept — peer ids, authority epochs, generations and sequences die with the session that created them, so stale pre-restart frames never validate. The compose file binds `./data/gameserver` so arena worlds survive container recreation. Room-code sessions stay in-memory only and recover through the client's auto-reconnect plus snapshot resync, or fall back to solo play.

## Proxying the relay

The relay container is published on `127.0.0.1:8090` only, so browsers reach it only through a proxy.

### Caddy

With the optional `caddy` Compose profile, copy `caddy/vhosts/games.caddy.example` to `caddy/vhosts/games.caddy`, edit the hostname, and set the same two `.env` keys as below (the [Caddy quickstart](deployment.md#caddy-quickstart) does all of it from `--games-domain`). Only `/ws` is exposed; TLS is automatic.

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

   Do **not** use Virtualmin's "Proxy Website" feature for this host — it generates a blanket `ProxyPass /` that would shadow `/ws` and expose `/health` and `/stats`.
4. Set in `.env` and recreate the relay:

   ```dotenv
   GAMESERVER_PUBLIC_URL=wss://games.example.com/ws
   GAMESERVER_ALLOWED_ORIGINS=https://sites.example.com
   ```

5. Verify with `./scripts/check-gameserver-proxy.sh`; it reports the internal health check and the public WebSocket upgrade separately.

### Cloudflare

Cloudflare's proxy (orange cloud) works for the relay: WebSockets are supported on every plan, and the net client's 10-second heartbeat keeps connections alive below Cloudflare's idle cutoff. Requirements:

- SSL/TLS mode **Full (strict)** — Flexible terminates at port 80 and never reaches the `/ws` directives in the HTTPS vhost.
- The public URL must use standard port 443 (Cloudflare does not proxy port 8090).
- Proxied hostnames complicate Let's Encrypt HTTP-01 renewal; use a bypass rule for `/.well-known/acme-challenge/*`, DNS-01 validation via the Cloudflare API, or a Cloudflare Origin CA certificate.

`./scripts/check-gameserver-proxy.sh` verifies the handshake through Cloudflare unchanged.
