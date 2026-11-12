import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { MULTIPLAYER_PROTOCOL_VERSION, projectAgents } from "./templates.js";
import type { MultiplayerContext, MultiplayerMode, ProjectKind } from "./types.js";
import { removeWorkspaceInput, writeWorkspaceInput } from "./workspace-inputs.js";

const ASSETS_DIR = path.join(process.cwd(), "assets");
const NETWORKING_GUIDE = path.join(ASSETS_DIR, "agents", "networking.md");

// Files copied verbatim from bot/assets into site/net/ (the tenant config
// files are generated per game, but share the same inventory).
const VENDORED_NET_FILES = [
  "net/threadsite-net.js", "net/threadsite-net.d.ts",
  "net/threadsite-player.js", "net/threadsite-player.d.ts",
] as const;

/** Every site/-relative file ensureMultiplayerFiles maintains. */
export const MULTIPLAYER_SITE_FILES: readonly string[] = [
  ...VENDORED_NET_FILES, "net/net-config.js", "net/net-config.d.ts",
];

/**
 * Games are multi-tenant clients of the shared relay: the tenant key is simply
 * the published site slug, so no per-game provisioning exists anywhere. A
 * singleplayer-only game gets no relay wiring at all — no net client, no
 * tenant, no networking instructions.
 */
export function multiplayerContext(kind: ProjectKind, siteSlug: string, mode: MultiplayerMode = "arena"): MultiplayerContext | undefined {
  if (!config.multiplayerEnabled || kind === "site" || mode === "singleplayer") return undefined;
  return {
    gameId: siteSlug,
    wsUrl: config.gameserverPublicUrl,
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    mode,
  };
}

/**
 * Keep the harness-owned multiplayer files in a game workspace current under
 * `site/net/`: the vendored protocol client with its full TypeScript
 * declarations generated from the TypeScript source (authored code gets real
 * types for the whole sync API), and this game's tenant config
 * (net-config.js + net-config.d.ts). The project AGENTS.md multiplayer
 * section is rewritten alongside, plus the NETWORKING.md gotcha guide at the
 * workspace root. Runs on project creation, before every
 * mutation, and again after each agent turn (before validation), so agent
 * deletions/drift are repaired within the same turn. Writes are
 * content-compared so an unchanged tree stays untouched. Returns true when
 * any file had to be written.
 */
export async function ensureMultiplayerFiles(
  workspacePath: string,
  multiplayer: MultiplayerContext,
  kind: ProjectKind,
): Promise<boolean> {
  let changed = false;
  for (const relative of VENDORED_NET_FILES) {
    const name = relative.split("/").pop()!;
    const content = await fs.readFile(path.join(ASSETS_DIR, name), "utf8");
    changed = (await writeWorkspaceInput(workspacePath, ["site", ...relative.split("/")], `${content.trimEnd()}\n`)) || changed;
  }

  const netConfig = [
    "// Harness-owned multiplayer configuration for this game.",
    "// The ThreadSite bot rewrites this file every turn; import it, never edit it.",
    // Like NET_STATUS in the client: the JSDoc type keeps Object.freeze from
    // pinning literal types onto authored copies of these values.
    "/** @type {{protocol: number, game: string, url: string}} */",
    `export const NET_CONFIG = Object.freeze({`,
    `  protocol: ${multiplayer.protocolVersion},`,
    `  game: ${JSON.stringify(multiplayer.gameId)},`,
    `  url: ${JSON.stringify(multiplayer.wsUrl)},`,
    `});`,
    "",
  ].join("\n");
  changed = (await writeWorkspaceInput(workspacePath, ["site", "net", "net-config.js"], netConfig)) || changed;
  const netConfigTypes = [
    "// Type declarations for the harness-owned net-config.js.",
    "export declare const NET_CONFIG: {",
    "  readonly protocol: number;",
    "  readonly game: string;",
    "  readonly url: string;",
    "};",
    "",
  ].join("\n");
  changed = (await writeWorkspaceInput(workspacePath, ["site", "net", "net-config.d.ts"], netConfigTypes)) || changed;

  changed = (await writeWorkspaceInput(
    workspacePath, ["AGENTS.md"],
    await projectAgents(kind, multiplayer),
  )) || changed;
  // The on-demand companion to AGENTS.md's multiplayer section: budgets,
  // gotchas, and a symptom->fix table. Written to the project root so agents
  // can read it when debugging sync without paying its tokens every turn.
  changed = (await writeWorkspaceInput(
    workspacePath, ["NETWORKING.md"],
    `${(await fs.readFile(NETWORKING_GUIDE, "utf8")).trimEnd()}\n`,
  )) || changed;
  return changed;
}

/**
 * Remove the harness-owned multiplayer wiring from a workspace that has gone
 * singleplayer: the whole `site/net/` directory (client, config, types), the
 * NETWORKING.md guide. Runs on the multiplayer switch and again before every
 * turn of a singleplayer game, so
 * nothing relay-shaped survives for imports or the bundler to pick up.
 * Returns true when anything had to be removed.
 */
export async function removeMultiplayerFiles(workspacePath: string): Promise<boolean> {
  const netRemoved = await removeWorkspaceInput(workspacePath, ["site", "net"], true);
  const guideRemoved = await removeWorkspaceInput(workspacePath, ["NETWORKING.md"]);
  return netRemoved || guideRemoved;
}

/** One-line health summary of the shared relay for /site-admin status. */
export async function multiplayerRelayStatus(): Promise<string> {
  if (!config.multiplayerEnabled) return "disabled (MULTIPLAYER_ENABLED=false)";
  try {
    const response = await fetch(`${config.gameserverInternalUrl}/health`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { games?: number; rooms?: number; clients?: number };
    return `online · protocol v${MULTIPLAYER_PROTOCOL_VERSION} · ${body.games ?? 0} game(s) · ${body.rooms ?? 0} room(s) · ${body.clients ?? 0} player(s)`;
  } catch {
    return `unreachable at ${config.gameserverInternalUrl} (published games fall back to solo play)`;
  }
}
