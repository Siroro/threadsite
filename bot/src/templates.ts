import type { MultiplayerContext, ProjectKind } from "./types.js";

export function projectAgents(kind: ProjectKind, multiplayer?: MultiplayerContext): string {
  const mp = kind !== "site" && multiplayer ? multiplayerAgents(multiplayer) : "";
  if (kind === "game-2d") return `${GAME_2D_AGENTS}\n${mp}`;
  if (kind === "game-3d") return `${GAME_3D_AGENTS}\n${mp}`;
  return SITE_AGENTS;
}

/** Durable project memory injected into every turn; empty when no notes exist yet. */
export function notesSection(notes: string | undefined): string {
  const trimmed = notes?.trim();
  if (!trimmed) return "";
  return `\n\nPROJECT NOTES (long-term memory from earlier turns — respect these):\n${trimmed}`;
}

export function initialProjectInstruction(kind: ProjectKind, userPrompt: string, notes?: string): string {
  const common = `Read the project-root AGENTS.md first. Inspect the starter files, make a short todo plan for nontrivial work, research the web when it will materially improve the result, and implement the deliverable rather than only describing it. Keep the output directly Apache-servable. Prefer a clear multi-file structure instead of putting all CSS and JavaScript in index.html.`;
  if (kind === "game-2d") {
    return `${common}\n\nCreate a complete, polished, playable 2D browser game from the request below. Use the 2D architecture and quality rules in AGENTS.md. Build it **multiplayer-first** exactly as AGENTS.md's multiplayer section describes: connect through the vendored \`site/js/threadsite-net.js\` client with \`site/js/net-config.js\`, implement room create/join by code, live cross-player sync using the recommended peer-owned-state model (each player's controls stay local, interactions are events the target applies to itself), and a fully playable solo/offline fallback. When suitable reusable media would improve the game, use websearch to find it and asset_download to store it locally.${notesSection(notes)}\n\nGAME REQUEST:\n${userPrompt}`;
  }
  if (kind === "game-3d") {
    return `${common}\n\nCreate a complete, polished, playable 3D browser game from the request below. Use the 3D architecture and quality rules in AGENTS.md. Build it **multiplayer-first** exactly as AGENTS.md's multiplayer section describes: connect through the vendored \`site/js/threadsite-net.js\` client with \`site/js/net-config.js\`, implement room create/join by code, live cross-player sync using the recommended peer-owned-state model (each player's controls stay local, interactions are events the target applies to itself), and a fully playable solo/offline fallback. Research suitable references/assets when useful and use asset_download for local media/models/textures/audio.${notesSection(notes)}\n\nGAME REQUEST:\n${userPrompt}`;
  }
  return `${common}\n\nCreate the static website described below. Make it feel intentionally designed and interactive where appropriate. Use real researched/reusable media when it improves the result, otherwise create tasteful local CSS/SVG/Canvas visuals.${notesSection(notes)}\n\nSITE REQUEST:\n${userPrompt}`;
}

export function mutationInstruction(kind: ProjectKind, userPrompt: string, notes?: string): string {
  const noun = kind === "site" ? "website" : kind === "game-2d" ? "2D web game" : "3D web game";
  const multiplayerClause = kind === "site"
    ? ""
    : " Preserve working multiplayer (rooms, sync, host migration, solo fallback) unless the request changes it, and keep using the harness-provided net client instead of custom network code.";
  return `Read AGENTS.md and inspect the current project before editing. Revise the existing ${noun} according to the Discord request below. Preserve working features/mechanics unless the request changes them.${multiplayerClause} Keep code split into sensible files/modules, use websearch and asset_download when research or real reusable media would materially improve the result, and leave a complete directly runnable static-web deliverable.${notesSection(notes)}\n\nDISCORD REQUEST:\n${userPrompt}`;
}

export function repairInstruction(validationError: string): string {
  return `Automated validation rejected the previous output with a JavaScript syntax error. Fix it now: open the listed file(s), correct every parse error, remove duplicate declarations, and make sure the whole file parses. Use the js_syntax_check tool on the affected files before finishing. Do not change anything unrelated to the syntax errors and do not remove or stub working functionality to make the error go away.\n\nVALIDATION ERROR:\n${validationError}`;
}

export function projectKindLabel(kind: ProjectKind | undefined): string {
  if (kind === "game-2d") return "2D static web game";
  if (kind === "game-3d") return "3D static web game";
  return "static website";
}

const SHARED_STATIC_RULES = `# ThreadSite Project Rules

This repository is maintained by the ThreadSite Discord harness. The published deliverable lives entirely in \`site/\` and is served directly by Apache under an arbitrary path prefix.

## Hard delivery boundaries

- The result must be a **static browser deliverable**: HTML, CSS, browser JavaScript/modules, JSON/data files, fonts, images, audio, video, and supported 3D assets only.
- No backend, database, server-side rendering, PHP, CGI, Node runtime, package manager, bundler, transpiler, dev server, or build step.
- \`site/index.html\` must always exist and work over ordinary HTTP(S).
- Only edit files inside \`site/\`. Do not edit \`AGENTS.md\`, \`README.md\`, \`ASSET_SOURCES.json\`, git metadata, or harness files.
- Use relative project URLs. The final site is not guaranteed to be mounted at \`/\`.
- Never create \`.htaccess\`, dotfiles, symlinks, package manifests, lockfiles, shell scripts, or git configuration.
- The outer harness owns git, Forgejo, validation, rollback, and publication. Never try to perform git operations.
- Do not require login credentials, private APIs, secrets, or environment variables in the generated browser app.

## Work like a real small front-end project

- **Inspect before editing.** Read the existing structure and preserve good existing work.
- For substantial work, create/update a short todo plan before making changes.
- **Prefer multiple focused files.** Avoid giant all-in-one \`index.html\` files.
- Even a relatively small project should normally have at least \`index.html\`, a CSS file, and a JavaScript file when it has behavior.
- Larger projects should split browser logic by responsibility (for example \`js/main.js\`, \`js/ui.js\`, \`js/state.js\`, \`js/audio.js\`) instead of growing one huge script.
- Put styling in \`site/css/\` or clearly named CSS files, JavaScript in \`site/js/\`, structured data in \`site/data/\`, and media in \`site/assets/\`.
- Keep module boundaries understandable. Do not create dozens of microscopic files just to satisfy the multi-file rule.
- Use ES modules when they make the browser code cleaner. Keep all imports browser-compatible and relative unless a deliberately pinned CDN library is justified.
- Add comments for unusual math/algorithms, not for obvious code.

## Web research and reusable assets

You have a web search tool and a guarded \`asset_download\` tool that can save any public HTTP(S) file type below \`site/assets/\`.

- Use **websearch** when current information, visual references, documentation, factual details, or real media could materially improve the result. Do not search merely to appear busy.
- For assets, data, and browser-side vendor files, search reputable sources first. For visual/audio/media, prefer official assets, public-domain/CC0 material, or assets with clearly permissive reuse terms.
- When you find a suitable direct file URL, use **asset_download** to store it below \`site/assets/\` instead of relying on fragile hotlinks. This can include media, JSON/data, shaders, WASM, or pinned browser-side vendor/library files when local vendoring makes the static deliverable more reliable.
- Pass \`source_page\` and \`license_note\` to \`asset_download\` when known. Never invent a license or attribution. If reuse terms are unclear, prefer procedural/CSS/SVG art or another clearly reusable source.
- \`asset_download\` records provenance in \`ASSET_SOURCES.json\`; the harness owns that file.
- Do not embed huge base64 blobs in source code when a normal local asset file is appropriate.
- Avoid unnecessary large media. Optimize for a fast static site and ordinary mobile connections.

## UX and quality

- The first viewport should communicate what the experience is and what the user can do.
- Make interactions visible and responsive: hover/focus/pressed states, useful transitions, clear loading/error states, and feedback after actions.
- Support keyboard navigation for ordinary UI and sensible touch/pointer behavior on smaller screens.
- Respect \`prefers-reduced-motion\` for nonessential animation.
- Use semantic HTML and reasonable contrast. Images that convey meaning need useful alt text.
- Handle resizing rather than assuming one desktop resolution.
- Keep the browser console free of avoidable errors.
- Do not claim something was browser-tested unless you actually had a browser/testing tool available.
`;

const SITE_AGENTS = `${SHARED_STATIC_RULES}
## Website-specific direction

- Treat this as a real designed website, not a generated demo page. Establish hierarchy, spacing, typography, and a coherent visual system.
- Give static sites meaningful browser-side interaction when it fits the request: filters, tabs, drawers, galleries, small simulations, tasteful motion, local persistence, or other useful UI behavior.
- A typical structure for a nontrivial site is:

  - \`site/index.html\` — semantic document shell
  - \`site/css/styles.css\` — primary visual system
  - \`site/js/main.js\` — bootstrap/event wiring
  - \`site/js/<feature>.js\` — focused interactive features
  - \`site/assets/...\` — downloaded or local media

- Research factual/current subject matter if the site depends on it. Avoid fabricating current statistics, product facts, dates, or quotations when websearch can verify them.
- Prefer local downloaded media over third-party hotlinks when licensing and file size are suitable.
`;

const SHARED_GAME_RULES = `${SHARED_STATIC_RULES}
## Shared game design requirements

- This must be a **playable game**, not just an animated scene or mock UI.
- Make the objective and primary controls obvious before or immediately after play starts.
- Include explicit game states: boot/loading where needed, title/instructions, active play, pause where useful, game-over/win/progression state, and replay/restart.
- The player should receive immediate audiovisual/UI feedback for important actions, danger, success, damage, scoring, pickups, checkpoints, or combos.
- Keep simulation frame-rate independent with a clamped delta or an appropriate fixed-step loop.
- Pause or reduce simulation work when the document is hidden.
- Keyboard controls are required where sensible. Add pointer/touch controls when the game should work on phones/tablets.
- Prevent browser scrolling/zoom gestures only where they directly conflict with gameplay.
- Audio must begin only after a user gesture. Provide a visible mute/sound control.
- Use localStorage only for non-sensitive settings, best scores, progress, or preferences.
- Keep the game usable when resized and on high-DPI displays.
- Prefer deterministic, understandable game-state code over tangled event handlers and globals.
- On revisions, preserve established controls, mechanics, save data, and level content unless the request says to change them.

## Game project structure

Do not put the entire game in one script. A solid baseline is:

- \`site/index.html\` — shell, canvas/container, accessible overlays
- \`site/css/game.css\` — layout/HUD/menu styles
- \`site/js/main.js\` — bootstrapping and top-level lifecycle
- \`site/js/game.js\` or \`site/js/game-state.js\` — state machine/game loop
- \`site/js/input.js\` — keyboard/pointer/touch mapping
- \`site/js/audio.js\` — audio lifecycle when sound exists
- additional focused files for entities/world/levels/rendering when complexity warrants it
- \`site/assets/\` — local sprites/textures/models/audio/fonts

Keep responsibilities separated, but do not overengineer a tiny game.

## Media research for games

- Use websearch when real sprites, textures, sound effects, music, fonts, or 3D models would noticeably improve the requested aesthetic.
- Prefer assets with clearly reusable terms (official reusable kits, CC0/public domain, permissive game-asset packs). Use \`asset_download\` so the game does not depend on random hotlinks.
- Record known source/license information through the tool arguments. If terms are unclear, find another source or create procedural art/audio instead.
- Keep asset size within the static-site budget. A cohesive small asset set is better than a pile of unrelated downloads.
`;

const GAME_2D_AGENTS = `${SHARED_GAME_RULES}
## 2D game direction

- The primary play space is fundamentally two-dimensional.
- Prefer Canvas 2D for action/arcade games. DOM/SVG is appropriate for card, board, puzzle, management, narrative, and strongly UI-driven games.
- Use a clear coordinate system and separate **simulation** from **rendering**. Avoid mixing every mechanic into the draw loop.
- Suggested focused modules when relevant: \`entities.js\`, \`levels.js\`, \`collision.js\`, \`particles.js\`, \`ui.js\`.
- Keep collision shapes predictable and fair. What hits the player should visually match what the player sees.
- For movement-heavy games, use acceleration/friction/velocity deliberately rather than frame-based pixel stepping.
- Build in game feel without sacrificing clarity: hit-stop, flashes, particles, trails, screen shake with restraint, easing, combo text, squash/stretch, or layered audio.
- Add simple object pooling or caps for particles/projectiles if they can grow without bound.
- If using sprite sheets, keep frame metadata/code isolated rather than scattering magic coordinates across the game.
- Touch controls should be comfortably sized and should not obscure the most important play area.
- A 2D game should still feel visually authored: backgrounds, UI, transitions, effects, and typography deserve attention.
`;

const GAME_3D_AGENTS = `${SHARED_GAME_RULES}
## 3D game direction

- The primary play space must be genuinely 3D using browser WebGL, not a 2D canvas with faux perspective.
- A pinned browser ESM build of Three.js (or a similarly appropriate static browser library) is acceptable when it materially simplifies reliable 3D rendering. Do **not** introduce npm, Vite, webpack, TypeScript compilation, or any build pipeline.
- Keep game-specific code local and split by system. A useful structure is often \`main.js\`, \`scene.js\`, \`world.js\`, \`player.js\`, \`input.js\`, \`game-state.js\`, \`ui.js\`, and \`audio.js\`.
- Use \`asset_download\` for suitably licensed local textures, environment images, audio, and compact 3D assets such as GLB/GLTF when they improve the requested result.
- Use a loading manager/state for external modules/media/models. Never leave a blank canvas while loading or after failure.
- If WebGL or an essential remote rendering module fails to initialize, show a useful visible fallback/error panel.
- Design camera behavior deliberately. Avoid nausea-inducing movement, uncontrolled clipping, and disorienting resets.
- Pointer lock is allowed only after an explicit user gesture. Always make escape/re-entry behavior obvious.
- Make orientation readable with lighting, silhouettes, landmarks, shadows/fog/ground cues as appropriate.
- Keep geometry/material/effect budgets conservative enough for ordinary laptops and phones. Avoid unbounded particles, enormous textures, and gratuitous post-processing.
- Prefer simple robust collision volumes and gameplay math unless a lightweight browser-side physics solution is truly justified.
- Keep render-loop allocation low. Reuse vectors/materials/geometries where sensible rather than creating garbage every frame.
- Provide quality/resolution scaling or conservative defaults when the scene may be demanding.
- Mobile 3D controls need intentional UI; do not merely assume WASD + mouse if the requested audience includes touch devices.
`;

function multiplayerAgents(mp: MultiplayerContext): string {
  return `## Multiplayer first — ThreadSite Multiplayer Protocol

**Build this game multiplayer-first.** Networked play is the primary experience; "single-player" is the same game with one human (plus optional bots), never a separate fork of the game logic. The harness runs one shared multiplayer relay for every game it hosts; your game is a tenant of that relay and needs **no server code of its own**. Never write backend/server-side code, and never introduce any other runtime network endpoint.

### Pick the game's mode first: shared arena or room codes

The relay supports two join modes. Choose one up front — it shapes your whole menu flow:

- **Shared arena (\`mode: "single"\`)** — every player who opens the game lands in the same room for this game. There is no lobby, no room code, and nothing to share: players just open the page and see each other. Pick this when the game is one persistent world (open arena, shared playground, drop-in co-op, party games where everyone gathers in the same place).
- **Room codes (\`mode: "rooms"\`, the default)** — players host or join private rooms by 5-character code. Pick this when groups want isolated sessions (competitive rounds, private co-op runs, matches with friends). In this mode you **must** provide invite links — see the UX section.

### Harness-provided files (do not recreate, do not delete)

- \`site/js/threadsite-net.js\` — vendored protocol client. Treat it as a library: import it, wrap it, extend it from your own modules; the harness restores it every turn.
- \`site/js/net-config.js\` — harness-owned config for this exact game. It already contains this game's tenant identity; import it and never hardcode substitutes:

      import { NET_CONFIG } from "./net-config.js";
      import { ThreadSiteNet } from "./threadsite-net.js";

      // Shared arena: everyone together, no codes needed.
      const net = await ThreadSiteNet.connect({
        ...NET_CONFIG,
        mode: "single",
        name: playerName,
        onPeers: (peers) => refreshRoster(peers),
        onPlayerState: (ps) => updateRemotePlayer(ps.from, ps.state),
        onEvent: (ev) => applyRemoteEvent(ev),      // { from, type, data }
        onState: (snap) => applySharedWorld(snap.state),
        onHostChange: (hostId, isHost) => setLocalAuthority(isHost),
        onStatus: (status) => showNetStatus(status),
      });

      // Room codes: check the URL first so invite links auto-join.
      const invited = ThreadSiteNet.roomFromUrl();
      const net = await ThreadSiteNet.connect({
        ...NET_CONFIG,
        room: invited,               // from "#room=AB3CK" — null means host fresh
        createRoom: !invited,
        name: playerName,
      });

      // your game loop — you own your player, controls never leave this machine:
      net.publishPlayerState({ x, y, vx, vy, anim });
      // interactions — tell the target; the target applies it to itself:
      net.sendTo(targetId, "hit", { force: 12 });

This game's wiring: game id \`${mp.gameId}\`, relay \`${mp.wsUrl}\` (already in \`net-config.js\`). If \`connect()\` rejects (relay down), fall back to solo play and keep retrying in the background per the client's \`autoReconnect\`.

### Wire protocol (JSON text frames over one WebSocket; the client implements this for you)

Client → relay:

- \`{ "t": "join", "v": ${mp.protocolVersion}, "game", "mode", "room", "create", "name" }\` — join a room; \`mode: "single"\` joins this game's shared arena (room/ignored), otherwise join by \`room\` code or \`create\` a fresh one.
- \`{ "t": "pstate", "s" }\` — publish **your own** player's state; relayed to the room, no host involved, and retained per peer for late joiners.
- \`{ "t": "event", "e", "d", "to"? }\` — application event, broadcast to the room or sent to one peer id.
- \`{ "t": "state", "s" }\` — publish a room snapshot (shared world); the relay keeps the newest one and hands it to late joiners.
- \`{ "t": "state-req" }\` — ask the host for a fresh snapshot.
- \`{ "t": "ping", "ts" }\` — RTT probe (\`net.rtt\`).

Relay → client:

- \`{ "t": "welcome", "you", "room", "mode", "created", "peers", "host", "s" }\` — your peer id, the room code, the mode you joined with, current peers (each with their latest player state), current host, and the room's newest snapshot \`s\` (null when nobody published yet).
- \`{ "t": "peer-join", "peer", "host" }\` / \`{ "t": "peer-leave", "id", "host" }\` — roster changes; \`host\` after a leave announces host migration.
- \`{ "t": "pstate", "from", "s" }\` — a peer's newest own-player state.
- \`{ "t": "event", "from", "e", "d" }\` — relayed application event.
- \`{ "t": "state", "from", "s" }\` — relayed snapshot.
- \`{ "t": "state-req", "from" }\` — forwarded to the host only.
- \`{ "t": "pong", "ts" }\`, \`{ "t": "error", "code", "message" }\`, \`{ "t": "bye", "reason" }\`.

Frames are small JSON; the relay caps frame size and rate-limits every connection, so send compact deltas, not asset data.

### How to sync players and world agents across clients

Recommended default: **peer-owned state** — every player owns and simulates their own entity.

- Simulate only **your** player locally and publish from the game loop at 10–20 Hz: \`net.publishPlayerState({ x, y, vx, vy, anim, score, ... })\`. Controls never travel through anyone else's machine, so input latency is exactly local play; there is no host round trip and no host to lose.
- Render every other player from their newest player state (\`onPlayerState\`, \`net.peerState(id)\`, \`net.playerStates\`), interpolating between the last two updates to hide latency. Keep the payload small and flat.
- **Affecting another player:** send an event and let the target apply it to itself — \`net.sendTo(target, "hit", { force: 12 })\` or a broadcast. Each client is the authority over its own player and accepts events addressed to it. Among friends this is the simplest robust rule; effects like knockback play out on the target's machine where their own simulation lives.
- **Shared world entities** (ball, NPC, pickups, round timer): give each entity exactly one owner. Either the room host includes them in \`net.publishState(...)\` room snapshots, or the peer that spawned the entity keeps simulating it and broadcasts it (\`net.send("world", { entity })\` or a dedicated shape inside their player state). Tag entities with their owner so everyone agrees.
- Late joiners and reconnecting players automatically receive every peer's latest player state in \`welcome\` — create remote avatars from it before entering play.
- The host (\`net.isHost\`, \`onHostChange\`) only matters for shared-world ownership you chose to give it. Losing or migrating the host never affects anyone's controls.

Use **host-authoritative simulation** instead when players physically interact through shared state (sumo shoving, shared physics, competitive fairness matters): only the host simulates the world; guests send input intents (\`net.send("input", { seq, move })\`) and render the newest \`net.publishState\` snapshot (8–15 Hz with a \`tick\`), interpolating between snapshots. Sequence-number the inputs so re-sent or rejoined inputs cannot double-apply, and on \`onHostChange\` promotion rebuild from your newest snapshot and resume publishing.

Use **last-writer-wins room state** for turn-based, co-op puzzle, or shared-canvas games: any client may \`publishState\`; keep each write small and idempotent and merge per-entity instead of replacing the whole world.

Either way: everything arriving through \`onEvent\`/\`onState\`/\`onPlayerState\` came from untrusted peers. Validate shapes, ranges, and ids before it touches simulation or the DOM, and ignore malformed input.

### Required multiplayer UX

**Shared arena mode:**

- No lobby and no room code. Ask for (or generate) the player's name, then connect straight into the arena; show other players arriving via \`onPeers\`.
- Still show connection status and the player list, and keep the solo/offline fallback.

**Room codes mode:**

- A lobby: host a room (show the code large and copyable) or join by code; invalid/expired codes show \`room_not_found\` gracefully.
- **Invite link (required):** right after hosting, show a copyable invite URL built with \`net.inviteUrl()\` — the current page URL plus \`#room=CODE\`. When the page loads with \`ThreadSiteNet.roomFromUrl()\` returning a code, skip the lobby and auto-join that room directly. Put the invite link next to the room code with a one-click copy button (and use \`navigator.clipboard\` when available).
- Show connection status, the player list, and who is host; a peer leaving mid-game must never break the local session.

Both modes: if the relay is unreachable or drops, the game stays fully playable alone (bots welcome). Never block the whole game on the network.
`;
}
