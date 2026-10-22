import fs from "node:fs/promises";
import path from "node:path";
import type { MultiplayerContext, MultiplayerMode, ProjectKind } from "./types.js";

export const MULTIPLAYER_PROTOCOL_VERSION = 4;

const AGENTS_DIR = path.join(process.cwd(), "assets", "agents");

/** Loaded chunk bodies by name; templates are static files, so one read each. */
const chunkCache = new Map<string, string>();

/**
 * Read one AGENTS.md chunk from bot/assets/agents/<name>.md. The chunks are
 * plain markdown — no escaping, reviewable diffs — joined per project kind
 * and per-game token-substituted. Cached after the first read.
 */
async function agentsChunk(name: string): Promise<string> {
  const cached = chunkCache.get(name);
  if (cached !== undefined) return cached;
  const file = path.join(AGENTS_DIR, `${name}.md`);
  const content = await fs.readFile(file, "utf8");
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  chunkCache.set(name, body);
  return body;
}

/** Replace {{token}} placeholders; unknown tokens are left untouched so they
 * stay visible in a generated AGENTS.md rather than silently vanishing. */
function substitute(chunk: string, tokens: Record<string, string>): string {
  return chunk.replace(/\{\{(\w+)\}\}/g, (match, name: string) => tokens[name] ?? match);
}

export async function projectAgents(kind: ProjectKind, multiplayer?: MultiplayerContext, singleplayer = false): Promise<string> {
  const shared = await agentsChunk("shared");
  if (kind === "site") return shared;
  const game = await agentsChunk("game");
  const direction = await agentsChunk(kind === "game-2d" ? "game-2d" : "game-3d");
  const tail = multiplayer
    ? `\n\n${await multiplayerAgents(multiplayer)}`
    // A singleplayer game gets an explicit "no netcode" section instead: the
    // shared game chunks mention netcode rules that would otherwise dangle.
    : singleplayer
      ? `\n\n${singleplayerAgents()}`
      : "";
  return `${shared}\n\n${game}\n\n${direction}${tail}`;
}

async function multiplayerAgents(mp: MultiplayerContext): Promise<string> {
  return substitute(await agentsChunk("multiplayer"), {
    gameId: mp.gameId,
    wsUrl: mp.wsUrl,
    protocolVersion: String(mp.protocolVersion),
    modeGuidance: mp.mode === "rooms" ? ROOMS_GUIDANCE : ARENA_GUIDANCE,
  });
}

const ARENA_GUIDANCE =
  "**Session mode — arena:** every player joins one game-wide arena with `mode: \"single\"` (the client's default). "
  + "Do not add rooms, lobbies, or invite codes unless the request explicitly asks for them.";

const ROOMS_GUIDANCE =
  "**Session mode — rooms:** players join isolated invite-code rooms with `mode: \"rooms\"` plus `createRoom`/`room` "
  + "(use `ThreadSiteNet.roomFromUrl()` for invite links). Build a minimal lobby around creating, sharing, and joining room codes; "
  + "each room is its own world with its own host, and a late joiner lands in exactly the room they clicked.";

function singleplayerAgents(): string {
  return "## Singleplayer only\n\n"
    + "This game is deliberately singleplayer: one player, one browser tab, no relay and no net code. "
    + "Ignore the netcode/multiplayer references elsewhere in this brief — they apply only to networked projects. "
    + "Keep all state local, keep the game fully playable offline, and never add WebSocket/WebRTC code or any multiplayer SDK.";
}

/** Durable project memory injected into every turn; empty when no notes exist yet. */
export function notesSection(notes: string | undefined): string {
  const trimmed = notes?.trim();
  if (!trimmed) return "";
  return `\n\nPROJECT NOTES (long-term memory from earlier turns — respect these):\n${trimmed}`;
}

/**
 * The two project documents the harness shows to the thread: what the project
 * is, and what each turn changed. Both are agent-maintained, so the prompt
 * has to ask for them by name.
 */
const documentsInstruction = "Two documents in the project root are shown to everyone who opens the project, so keep them true and tiny. DESCRIPTION.md: one sentence of at most 25 words in a visitor's words — no file names, no code, no jargon — plus one sentence of at most 20 words under 'How to play' naming the goal the player works toward, not the controls. CHANGELOG.md: one new section per turn, newest at the top — a heading of at most six words, then one sentence of at most 30 words on what a visitor will notice. Write each paragraph on a single line; never break a sentence across lines by hand. Write DESCRIPTION.md when the project first exists and whenever its shape changes, and add the CHANGELOG.md section before your final summary.";

const planningInstruction = "For any request that needs multiple steps or changes across multiple files, call the todowrite tool before the first edit: create 3–6 concrete, checkable steps. Keep exactly one step in_progress, and mark a step completed as soon as it is finished while promoting the next one — the user watches this list live, so a list left behind misreports your progress. Before your final summary, mark every finished step completed and every dropped step cancelled. A prose plan does not replace the todo list. Skip todowrite only for a truly single-step change.";

/** How the game connects, phrased for the initial-build instruction. */
function multiplayerPhrase(mode: MultiplayerMode): string {
  if (mode === "singleplayer") return "singleplayer only — no networking at all";
  if (mode === "rooms") return "room-based multiplayer through the harness relay (invite-code rooms), solo fallback";
  return "multiplayer-first through the harness relay, solo fallback";
}

export function initialProjectInstruction(kind: ProjectKind, userPrompt: string, notes?: string, mode: MultiplayerMode = "arena"): string {
  const common = `Read the project-root AGENTS.md first — it is the authoritative brief for engine usage and multiplayer architecture. Inspect the starter files, ${planningInstruction} Research the web when it will materially improve the result, and implement the deliverable rather than only describing it. Browser code is authored in TypeScript under site/src/; the harness compiles and bundles it after your reply. Prefer a clear multi-file structure over one giant index.html.`;
  const sectionWord = mode === "singleplayer" ? "singleplayer" : "multiplayer";
  const gameDesign = "Follow AGENTS.md's game-design rules: identify the core action, challenge and player decisions in your plan, then implement a complete, enjoyable round before optional polish. Match the requested genre; do not substitute a generic collect-N-pickups loop unless the user explicitly asks for a collection game.";
  if (kind === "game-2d") {
    return `${common}\n\nCreate a complete, polished, playable 2D browser game from the request below, following AGENTS.md's 2D and ${sectionWord} sections exactly (installed engine, ${multiplayerPhrase(mode)}). ${gameDesign} Use asset_download for suitable reusable media. ${documentsInstruction}${notesSection(notes)}\n\nGAME REQUEST:\n${userPrompt}`;
  }
  if (kind === "game-3d") {
    return `${common}\n\nCreate a complete, polished, playable 3D browser game from the request below, following AGENTS.md's 3D and ${sectionWord} sections exactly (installed engine, ${multiplayerPhrase(mode)}). ${gameDesign} Use asset_download for suitable media/models/textures/audio. ${documentsInstruction}${notesSection(notes)}\n\nGAME REQUEST:\n${userPrompt}`;
  }
  return `${common}\n\nCreate the static website described below. Make it feel intentionally designed and interactive where appropriate. Use real researched/reusable media when it improves the result, otherwise tasteful local CSS/SVG/Canvas visuals. ${documentsInstruction}${notesSection(notes)}\n\nSITE REQUEST:\n${userPrompt}`;
}

export function mutationInstruction(kind: ProjectKind, userPrompt: string, notes?: string, mode: MultiplayerMode = "arena"): string {
  const noun = kind === "site" ? "website" : kind === "game-2d" ? "2D web game" : "3D web game";
  const multiplayerClause = kind === "site"
    ? ""
    : mode === "singleplayer"
      ? " This game is singleplayer-only: keep it fully playable offline, and do not add networking of any kind."
      : mode === "rooms"
        ? " Preserve working room-based multiplayer (invite-code rooms, room isolation, sync, host migration, solo fallback) unless the request changes it, and keep using the harness-provided net client."
        : " Preserve working multiplayer (arena sync, host migration, solo fallback) unless the request changes it, and keep using the harness-provided net client.";
  return `Read AGENTS.md and inspect the current project before editing. ${planningInstruction} Revise the existing ${noun} according to the request below. Preserve working features/mechanics unless the request changes them.${multiplayerClause} Keep browser code in TypeScript under site/src/ (never hand-edit the generated, gitignored bundles under site/js/), use websearch and asset_download when they would materially improve the result, and leave a complete buildable deliverable. ${documentsInstruction}${notesSection(notes)}\n\nREQUEST:\n${userPrompt}`;
}

/** Short human label for a multiplayer mode, used in prompts and replies. */
export function multiplayerModeLabel(mode: MultiplayerMode): string {
  if (mode === "singleplayer") return "singleplayer only";
  if (mode === "rooms") return "invite-code rooms";
  return "shared-arena multiplayer";
}

/** One-line summary of what the agent must build under each mode. */
function modeTarget(mode: MultiplayerMode): string {
  if (mode === "singleplayer") {
    return "no networking at all: every module runs locally, the game is fully playable offline, and nothing imports site/net/";
  }
  if (mode === "rooms") {
    return "invite-code rooms (`mode: \"rooms\"` with `createRoom`/`room`, `ThreadSiteNet.roomFromUrl()` for invite links), a minimal lobby for creating/sharing/joining codes, and each room an isolated world with its own host";
  }
  return "one game-wide shared arena (`mode: \"single\"` on the net client): every player joins the same world, with no rooms, lobbies, or invite codes";
}

/**
 * The /site multiplayer swap prompt: investigate the current networking, work
 * out where THIS transition is genuinely difficult for this codebase, put
 * exactly those difficulties to the user via the question tool, then rewrite.
 * AGENTS.md and the harness-owned net files are already swapped to the target
 * architecture before this instruction runs.
 */
export function multiplayerSwapInstruction(from: MultiplayerMode, to: MultiplayerMode, userNote?: string): string {
  const investigating = from === "singleplayer"
    ? "Inspect the current implementation: where game state lives, which modules read it, and how input/update/render are wired — the networking will be introduced around that structure."
    : "Inspect the current networking implementation first: how sessions are created (site/net usage), which state is shared vs. local, how the host and solo fallback work, and which modules touch the net client.";
  const note = userNote?.trim()
    ? `\n\nThe user added this note for the switch — treat it as part of the request and honor it over defaults where they conflict, but still ask about genuine difficulties it does not resolve:\n${userNote.trim()}`
    : "";
  return `The multiplayer architecture of this game is being switched from ${multiplayerModeLabel(from)} to ${multiplayerModeLabel(to)}. AGENTS.md and the harness-owned net files under site/net/ already reflect the new architecture — read the multiplayer section of AGENTS.md (and NETWORKING.md at the project root, when it exists) before editing. ${investigating}\n\n`
    + `Then, from what you found, work out where this transition is genuinely difficult or ambiguous for THIS game: the seams the old architecture is baked into, state whose owner changes, flows that appear or disappear, and anything where a wrong guess would ship the wrong game. You MUST call the question tool and put exactly those difficulties to the user — one question per real decision point, each with 2–4 concrete options — and wait for the answers. Ask only about real difficulties; do not ask what the code, AGENTS.md, the original request, or your note below already answers, and do not guess your way past a decision the user should make.${note}\n\n`
    + `After the answers, rewrite the networking so the game runs as ${multiplayerModeLabel(to)}: ${modeTarget(to)}. Keep gameplay, presentation, and audio modules untouched where possible; change only the session/state/networking seams. ${to === "singleplayer" ? "Remove every import of ../net/* and all host/guest/relay branches; leave no dead netcode behind." : "Keep the solo fallback working (one player must be able to play alone), preserve as much existing gameplay logic as possible, and leave no room/arena remnants of the old architecture."} Use todowrite to plan the rewrite, mark steps as you finish them, and leave a complete buildable deliverable.`;
}

/**
 * A mid-turn user message delivered into the running agent turn (steering).
 * The message rides alongside the turn's work — the agent reads it as an
 * amendment to the CURRENT task, not a new request.
 */
export function steeringInstruction(texts: readonly string[]): string {
  const list = texts.map((text, index) => `${index + 1}. ${text}`).join("\n");
  return `The user sent ${texts.length === 1 ? "this message" : `${texts.length} messages`} while you were working. It is a steering update for the CURRENT task, not a new request: fold it into what you are building right now and continue — do not start over, and do not treat it as a separate piece of work.\n\nSTEERING:\n${list}`;
}

export function repairInstruction(validationError: string): string {
  return `Automated validation rejected the previous output with a build or type error. Fix it now: open the listed file(s) under site/src/ and correct every reported syntax, type, resolution, and DOM id error. For a repair spanning multiple files or steps, use todowrite before editing and mark each fix completed as you finish it. Errors naming a site/js/ file point at compiled output — fix the site/src/ module it was built from; the harness rebuilds after your reply. Make the whole import graph resolve (every import names an existing file and a real export of it). Use js_syntax_check on the affected files before finishing. Do not change anything unrelated and do not remove or stub working functionality to make the error go away.\n\nVALIDATION ERROR:\n${validationError}`;
}

/** Nudge used by boot recovery when a turn was interrupted by a restart. */
export function recoveryInstruction(originalPrompt: string, notes?: string): string {
  return `The previous turn was interrupted by a service restart before it could be committed and published. Re-read AGENTS.md and inspect the workspace: it may already contain partial edits from that turn. Continue exactly where it left off and finish the requested change (do not start over). Call todoread first: if a todo list already exists, keep its steps as written and update their statuses as you work rather than replacing the list; if this is multi-step work with no list, create one with todowrite before making further edits. Mark completed steps as you finish them, then summarize what you did.${notesSection(notes)}\n\nORIGINAL REQUEST:\n${originalPrompt}`;
}

export function projectKindLabel(kind: ProjectKind | undefined): string {
  if (kind === "game-2d") return "2D static web game";
  if (kind === "game-3d") return "3D static web game";
  return "static website";
}
