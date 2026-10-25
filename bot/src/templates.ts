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
    // Singleplayer games get an explicit offline-only section instead.
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
  "**Session mode (arena):** one shared world, `mode: \"single\"`. No room/lobby/invite UI unless requested.";

const ROOMS_GUIDANCE =
  "**Session mode (rooms):** isolated invite-code worlds, `mode: \"rooms\"` with `createRoom`/`room`. "
  + "Use `ThreadSiteNet.roomFromUrl()` for invites; provide create/share/join UI and a host per room.";

function singleplayerAgents(): string {
  return "## Singleplayer only\n\n"
    + "Keep gameplay state local and the game playable offline. Do not add gameplay networking, rooms or the multiplayer client. Global leaderboards use the separate score-only client under site/leaderboards/; read LEADERBOARDS.md and handle unavailable rankings without blocking play.";
}

/** Durable project memory injected into every turn; empty when no notes exist yet. */
export function notesSection(notes: string | undefined): string {
  const trimmed = notes?.trim();
  if (!trimmed) return "";
  return `\n\nPROJECT NOTES (long-term memory from earlier turns; respect these):\n${trimmed}`;
}

/**
 * Tell the next turn about a user rename. The rename itself never starts an
 * agent turn, so this is how the builder learns its project has a new name.
 */
export function renameNoteInstruction(note: { from: string; to: string }): string {
  return `\n\nPROJECT RENAME (requested by the user): "${note.from}" is now called "${note.to}". `
    + "The title heading of DESCRIPTION.md and the repository README already say the new name. "
    + "Carry it through everything a player or visitor sees: the on-screen title, page titles, headings and HUD text. Remove stale uses of the old name. "
    + "Keep file names, identifiers and the injected multiplayer/leaderboard game identity unchanged: they are stable across renames.";
}

/**
 * One-shot repair turn after an initial build shipped without naming the
 * project. Its reply is a summary of the project and becomes the turn card's
 * final text.
 */
export function namingFixInstruction(kind: ProjectKind): string {
  const noun = kind === "site" ? "website" : "game";
  return `The ${noun} was delivered without a project name: the \`# \` title heading of DESCRIPTION.md still carries its placeholder. Fix that now. `
    + "Choose a distinctive, memorable name for what you built, not a restatement of the original request and not a generic label; "
    + `if the ${noun} already presents a title on screen, use exactly that name. `
    + "Write it as the `# ` title heading of DESCRIPTION.md and change nothing else: the harness adopts that heading as the project's public name, repository and thread title. "
    + "Then reply with a short summary of the project for the person who requested it: its name, what it is, and what they can do, in a few sentences of visitor words, no file lists.";
}

/**
 * The project documents the harness shows to the thread and the repository.
 * DESCRIPTION.md and CHANGELOG.md supply the cards; README.agent.md supplies
 * the long-form repository README. All are agent-maintained, so the prompt has
 * to ask for them by name.
 */
const documentsInstruction = "Three documents in the project root are shown to everyone who opens the project, so keep them true and tight. DESCRIPTION.md: a `# ` title heading carrying the project's name. Choose a distinctive, memorable name for what you built by the end of the first turn and keep it unless the user asks for a new one; the harness adopts that heading as the project's public name, repository and thread title, so never leave the seeded placeholder or a generic label like 'My Game' there. Below it, a headline of one sentence, at most 25 words, in a visitor's words (no file names, no code, no jargon); the card shows the headline alone. Then a 'How to play' section of up to four short paragraphs (about 120 words): the goal first, then the controls, then one or two tips; it opens from the card's How to play view. CHANGELOG.md: one new section per turn, newest at the top: a heading of at most six words, then one sentence of at most 30 words on what a visitor will notice. README.agent.md: the long-form repository README appended to README.md at the end of every turn: what the project is, how to play or use it, the controls, and useful development notes; use ## headings and keep it under 6,000 characters. Never edit README.md itself: the harness owns its title, ownership marker, live link, original request and attribution. Write each paragraph on a single line; never break a sentence across lines by hand. Write DESCRIPTION.md when the project first exists and whenever its shape changes, add the CHANGELOG.md section before your final summary, and keep README.agent.md current.";

const planningInstruction = "For any request that needs multiple steps or changes across multiple files, call the todowrite tool before the first edit: create 3–6 concrete, checkable steps. Keep exactly one step in_progress, and mark a step completed as soon as it is finished while promoting the next one; the user watches this list live, so a list left behind misreports your progress. Before your final summary, mark every finished step completed and every dropped step cancelled. A prose plan does not replace the todo list. Skip todowrite only for a truly single-step change.";

/** How the game connects, phrased for the initial-build instruction. */
function multiplayerPhrase(mode: MultiplayerMode): string {
  if (mode === "singleplayer") return "singleplayer gameplay with optional global leaderboards through the dedicated score-only client; no gameplay networking";
  if (mode === "rooms") return "room-based multiplayer through the harness relay (invite-code rooms), solo fallback";
  return "multiplayer-first through the harness relay, solo fallback";
}

/** Naming is part of the deliverable: a project with its own name reads as intentional. */
const namingInstruction = "Give what you build a name of its own: a distinctive, memorable title a visitor would recall, never a restatement of the request or a generic label. Set it as the `# ` title heading of DESCRIPTION.md by the end of this build (the harness adopts that heading as the project's public name, repository and thread title) and make it the on-screen identity: the title or landing screen and the page title should say it.";

export function initialProjectInstruction(kind: ProjectKind, userPrompt: string, notes?: string, mode: MultiplayerMode = "arena"): string {
  const common = `Inspect the starter files. ${planningInstruction} Research the web when it will materially improve the result, and implement the deliverable rather than only describing it. Browser code is authored in TypeScript under site/src/; the harness compiles and bundles it after your reply. Prefer a clear multi-file structure over one giant index.html.`;
  const gameDesign = "Identify the core action, challenge and player decisions in your plan, then implement a complete, enjoyable round before optional polish. Match the requested genre; do not substitute a generic collect-N-pickups loop unless the user explicitly asks for a collection game.";
  if (kind === "game-2d") {
    return `${common}\n\nCreate a complete, polished, playable 2D browser game from the request below using the installed engine, ${multiplayerPhrase(mode)}. ${gameDesign} ${namingInstruction} Use asset_download for suitable reusable media. ${documentsInstruction}${notesSection(notes)}\n\nGAME REQUEST:\n${userPrompt}`;
  }
  if (kind === "game-3d") {
    return `${common}\n\nCreate a complete, polished, playable 3D browser game from the request below using the installed engine, ${multiplayerPhrase(mode)}. ${gameDesign} ${namingInstruction} Use asset_download for suitable reusable media/models/textures/audio. ${documentsInstruction}${notesSection(notes)}\n\nGAME REQUEST:\n${userPrompt}`;
  }
  return `${common}\n\nCreate the static website described below. Make it feel intentionally designed and interactive where appropriate. Use real researched/reusable media when it improves the result, otherwise tasteful local CSS/SVG/Canvas visuals. ${namingInstruction} ${documentsInstruction}${notesSection(notes)}\n\nSITE REQUEST:\n${userPrompt}`;
}

export function mutationInstruction(kind: ProjectKind, userPrompt: string, notes?: string, mode: MultiplayerMode = "arena"): string {
  const noun = kind === "site" ? "website" : kind === "game-2d" ? "2D web game" : "3D web game";
  const multiplayerClause = kind === "site"
    ? ""
    : mode === "singleplayer"
      ? " This game is singleplayer-only: keep gameplay local and fully playable offline. Global leaderboards use the dedicated score-only client; do not add gameplay networking or rooms."
      : mode === "rooms"
        ? " Preserve working room-based multiplayer (invite-code rooms, room isolation, sync, host migration, solo fallback) unless the request changes it, and keep using the harness-provided net client."
        : " Preserve working multiplayer (arena sync, host migration, solo fallback) unless the request changes it, and keep using the harness-provided net client.";
  return `Inspect the current project before editing. ${planningInstruction} Revise the existing ${noun} according to the request below. Preserve working features/mechanics unless the request changes them.${multiplayerClause} Keep browser code in TypeScript under site/src/ (never hand-edit the generated, gitignored bundles under site/js/), use websearch and asset_download when they would materially improve the result, and leave a complete buildable deliverable. ${documentsInstruction}${notesSection(notes)}\n\nREQUEST:\n${userPrompt}`;
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
    return "local singleplayer gameplay, fully playable offline, with no imports from site/net/; preserve global leaderboards through the separate site/leaderboards/ client";
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
    ? "Inspect the current implementation: where game state lives, which modules read it, and how input/update/render are wired; the networking will be introduced around that structure."
    : "Inspect the current networking implementation first: how sessions are created (site/net usage), which state is shared vs. local, how the host and solo fallback work, and which modules touch the net client.";
  const note = userNote?.trim()
    ? `\n\nThe user added this note for the switch; treat it as part of the request and honor it over defaults where they conflict, but still ask about genuine difficulties it does not resolve:\n${userNote.trim()}`
    : "";
  return `The multiplayer architecture of this game is being switched from ${multiplayerModeLabel(from)} to ${multiplayerModeLabel(to)}. The project instructions and harness-owned net files under site/net/ already reflect the new architecture; read NETWORKING.md at the project root, when it exists, before editing. ${investigating}\n\n`
    + `Then, from what you found, work out where this transition is genuinely difficult or ambiguous for THIS game: the seams the old architecture is baked into, state whose owner changes, flows that appear or disappear, and anything where a wrong guess would ship the wrong game. You MUST call the question tool and put exactly those difficulties to the user, one question per real decision point, each with 2–4 concrete options, and wait for the answers. Ask only about real difficulties; do not ask what the code, project instructions, the original request, or your note below already answers, and do not guess your way past a decision the user should make.${note}\n\n`
    + `After the answers, rewrite the networking so the game runs as ${multiplayerModeLabel(to)}: ${modeTarget(to)}. Keep gameplay, presentation, and audio modules untouched where possible; change only the session/state/networking seams. ${to === "singleplayer" ? "Remove every import of ../net/* and all gameplay host/guest/relay branches; preserve rankings using the dedicated site/leaderboards/ client and the same injected game identity." : "Keep the solo fallback working (one player must be able to play alone), preserve as much existing gameplay logic as possible, and leave no room/arena remnants of the old architecture."} Use todowrite to plan the rewrite, mark steps as you finish them, and leave a complete buildable deliverable.`;
}

/**
 * A mid-turn user message delivered into the running agent turn (steering).
 * The message rides alongside the turn's work — the agent reads it as an
 * amendment to the CURRENT task, not a new request.
 */
export function steeringInstruction(texts: readonly string[]): string {
  const list = texts.map((text, index) => `${index + 1}. ${text}`).join("\n");
  return `The user sent ${texts.length === 1 ? "this message" : `${texts.length} messages`} while you were working. It is a steering update for the CURRENT task, not a new request: fold it into what you are building right now and continue. Do not start over, and do not treat it as a separate piece of work.\n\nSTEERING:\n${list}`;
}

export function repairInstruction(validationError: string): string {
  return `Automated validation rejected the previous output with a build or type error. Fix it now: open the listed file(s) under site/src/ and correct every reported syntax, type, resolution, and DOM id error. For a repair spanning multiple files or steps, use todowrite before editing and mark each fix completed as you finish it. Errors naming a site/js/ file point at compiled output; fix the site/src/ module it was built from; the harness rebuilds after your reply. Make the whole import graph resolve (every import names an existing file and a real export of it). Use js_syntax_check on the affected files before finishing. Do not change anything unrelated and do not remove or stub working functionality to make the error go away.\n\nVALIDATION ERROR:\n${validationError}`;
}

/** Nudge used by boot recovery when a turn was interrupted by a restart. */
export function recoveryInstruction(originalPrompt: string, notes?: string): string {
  return `The previous turn was interrupted by a service restart before it could be committed and published. Inspect the workspace: it may already contain partial edits from that turn. Continue exactly where it left off and finish the requested change (do not start over). Call todoread first: if a todo list already exists, keep its steps as written and update their statuses as you work rather than replacing the list; if this is multi-step work with no list, create one with todowrite before making further edits. Mark completed steps as you finish them, then summarize what you did.${notesSection(notes)}\n\nORIGINAL REQUEST:\n${originalPrompt}`;
}

export function projectKindLabel(kind: ProjectKind | undefined): string {
  if (kind === "game-2d") return "2D static web game";
  if (kind === "game-3d") return "3D static web game";
  return "static website";
}
