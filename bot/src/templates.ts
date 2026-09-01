import fs from "node:fs/promises";
import path from "node:path";
import type { MultiplayerContext, ProjectKind } from "./types.js";

export const MULTIPLAYER_PROTOCOL_VERSION = 3;

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

export async function projectAgents(kind: ProjectKind, multiplayer?: MultiplayerContext): Promise<string> {
  const shared = await agentsChunk("shared");
  if (kind === "site") return shared;
  const game = await agentsChunk("game");
  const direction = await agentsChunk(kind === "game-2d" ? "game-2d" : "game-3d");
  const mp = multiplayer ? `\n\n${await multiplayerAgents(multiplayer)}` : "";
  return `${shared}\n\n${game}\n\n${direction}${mp}`;
}

async function multiplayerAgents(mp: MultiplayerContext): Promise<string> {
  return substitute(await agentsChunk("multiplayer"), {
    gameId: mp.gameId,
    wsUrl: mp.wsUrl,
    protocolVersion: String(mp.protocolVersion),
  });
}

/** Durable project memory injected into every turn; empty when no notes exist yet. */
export function notesSection(notes: string | undefined): string {
  const trimmed = notes?.trim();
  if (!trimmed) return "";
  return `\n\nPROJECT NOTES (long-term memory from earlier turns — respect these):\n${trimmed}`;
}

export function initialProjectInstruction(kind: ProjectKind, userPrompt: string, notes?: string): string {
  const common = `Read the project-root AGENTS.md first. Inspect the starter files, make a short todo plan for nontrivial work, research the web when it will materially improve the result, and implement the deliverable rather than only describing it. Browser code is authored in TypeScript under site/src/; the harness compiles and bundles it after your reply. Prefer a clear multi-file structure over one giant index.html.`;
  if (kind === "game-2d") {
    return `${common}\n\nCreate a complete, polished, playable 2D browser game from the request below, following AGENTS.md's 2D rules and building on the installed PixiJS engine (\`import * as PIXI from "pixi.js"\`) unless DOM/SVG genuinely fits better. Build it **multiplayer-first** exactly as AGENTS.md's multiplayer section describes (net client from \`site/net/\`, room create/join, peer-owned-state sync, playable solo fallback). Use asset_download for suitable reusable media.${notesSection(notes)}\n\nGAME REQUEST:\n${userPrompt}`;
  }
  if (kind === "game-3d") {
    return `${common}\n\nCreate a complete, polished, playable 3D browser game from the request below, following AGENTS.md's 3D rules and building on the installed three.js engine (\`import * as THREE from "three"\` — never hand-roll WebGL or download another copy). Build it **multiplayer-first** exactly as AGENTS.md's multiplayer section describes (net client from \`site/net/\`, room create/join, peer-owned-state sync, playable solo fallback). Use asset_download for suitable media/models/textures/audio.${notesSection(notes)}\n\nGAME REQUEST:\n${userPrompt}`;
  }
  return `${common}\n\nCreate the static website described below. Make it feel intentionally designed and interactive where appropriate. Use real researched/reusable media when it improves the result, otherwise tasteful local CSS/SVG/Canvas visuals.${notesSection(notes)}\n\nSITE REQUEST:\n${userPrompt}`;
}

export function mutationInstruction(kind: ProjectKind, userPrompt: string, notes?: string): string {
  const noun = kind === "site" ? "website" : kind === "game-2d" ? "2D web game" : "3D web game";
  const multiplayerClause = kind === "site"
    ? ""
    : " Preserve working multiplayer (rooms, sync, host migration, solo fallback) unless the request changes it, and keep using the harness-provided net client.";
  return `Read AGENTS.md and inspect the current project before editing. Revise the existing ${noun} according to the Discord request below. Preserve working features/mechanics unless the request changes them.${multiplayerClause} Keep browser code in TypeScript under site/src/ (never hand-edit the generated bundles under site/js/ — see AGENTS.md's legacy section if authored .js is still there), use websearch and asset_download when they would materially improve the result, and leave a complete directly runnable deliverable.${notesSection(notes)}\n\nDISCORD REQUEST:\n${userPrompt}`;
}

export function repairInstruction(validationError: string): string {
  return `Automated validation rejected the previous output with a build or type error. Fix it now: open the listed file(s) under site/src/ and correct every reported syntax, type, resolution, and DOM id error. Errors naming a site/js/ file point at compiled output — fix the site/src/ module it was built from; the harness rebuilds after your reply. Make the whole import graph resolve (every import names an existing file and a real export of it). Use js_syntax_check on the affected files before finishing. Do not change anything unrelated and do not remove or stub working functionality to make the error go away.\n\nVALIDATION ERROR:\n${validationError}`;
}

/** Nudge used by boot recovery when a turn was interrupted by a restart. */
export function recoveryInstruction(originalPrompt: string, notes?: string): string {
  return `The previous turn was interrupted by a service restart before it could be committed and published. Re-read AGENTS.md and inspect the workspace: it may already contain partial edits from that turn. Continue exactly where it left off and finish the requested change (do not start over), then summarize what you did.${notesSection(notes)}\n\nORIGINAL REQUEST:\n${originalPrompt}`;
}

export function projectKindLabel(kind: ProjectKind | undefined): string {
  if (kind === "game-2d") return "2D static web game";
  if (kind === "game-3d") return "3D static web game";
  return "static website";
}
