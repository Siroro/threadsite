import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { MULTIPLAYER_PROTOCOL_VERSION, projectAgents } from "./templates.js";
import type { MultiplayerContext, MultiplayerMode, ProjectKind } from "./types.js";
import { safeChild } from "./util.js";

const PROTOCOL_VERSION = MULTIPLAYER_PROTOCOL_VERSION;

const ASSETS_DIR = path.join(process.cwd(), "assets");
const NET_CLIENT_STEM = "threadsite-net.js";
const NET_CLIENT_TYPES_STEM = "threadsite-net.d.ts";
const NETWORKING_GUIDE = path.join(ASSETS_DIR, "agents", "networking.md");

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
    protocolVersion: PROTOCOL_VERSION,
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
  const netDir = safeChild(workspacePath, "site", "net");
  await fs.mkdir(netDir, { recursive: true });

  let changed = false;
  const client = await fs.readFile(path.join(ASSETS_DIR, NET_CLIENT_STEM), "utf8");
  changed = (await writeIfChanged(safeChild(netDir, NET_CLIENT_STEM), `${client.trimEnd()}\n`)) || changed;
  const clientTypes = await fs.readFile(path.join(ASSETS_DIR, NET_CLIENT_TYPES_STEM), "utf8");
  changed = (await writeIfChanged(safeChild(netDir, NET_CLIENT_TYPES_STEM), `${clientTypes.trimEnd()}\n`)) || changed;
  for (const name of ["threadsite-player.js", "threadsite-player.d.ts"]) {
    changed = (await writeIfChanged(safeChild(netDir, name), await fs.readFile(path.join(ASSETS_DIR, name), "utf8"))) || changed;
  }

  const netConfig = [
    "// Harness-owned multiplayer configuration for this game.",
    "// The ThreadSite bot rewrites this file every turn — import it, never edit it.",
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
  changed = (await writeIfChanged(safeChild(netDir, "net-config.js"), netConfig)) || changed;
  const netConfigTypes = [
    "// Type declarations for the harness-owned net-config.js.",
    "export declare const NET_CONFIG: {",
    "  readonly protocol: number;",
    "  readonly game: string;",
    "  readonly url: string;",
    "};",
    "",
  ].join("\n");
  changed = (await writeIfChanged(safeChild(netDir, "net-config.d.ts"), netConfigTypes)) || changed;

  changed = (await writeIfChanged(
    safeChild(workspacePath, "AGENTS.md"),
    await projectAgents(kind, multiplayer),
  )) || changed;
  // The on-demand companion to AGENTS.md's multiplayer section: budgets,
  // gotchas, and a symptom->fix table. Written to the project root so agents
  // can read it when debugging sync without paying its tokens every turn.
  changed = (await writeIfChanged(
    safeChild(workspacePath, "NETWORKING.md"),
    `${(await fs.readFile(NETWORKING_GUIDE, "utf8")).trimEnd()}\n`,
  )) || changed;
  return changed;
}

async function writeIfChanged(file: string, content: string): Promise<boolean> {
  const current = await fs.readFile(file, "utf8").catch(() => undefined);
  if (current === content) return false;
  await fs.writeFile(file, content, "utf8");
  return true;
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
  let changed = false;
  const netDir = safeChild(workspacePath, "site", "net");
  if (await fs.lstat(netDir).then(() => true, () => false)) {
    await fs.rm(netDir, { recursive: true, force: true }).catch(() => undefined);
    changed = true;
  }
  if (await fs.lstat(safeChild(workspacePath, "NETWORKING.md")).then(() => true, () => false)) {
    await fs.rm(safeChild(workspacePath, "NETWORKING.md"), { force: true }).catch(() => undefined);
    changed = true;
  }
  return changed;
}

/** One-line health summary of the shared relay for /site-admin status. */
export async function multiplayerRelayStatus(): Promise<string> {
  if (!config.multiplayerEnabled) return "disabled (MULTIPLAYER_ENABLED=false)";
  try {
    const response = await fetch(`${config.gameserverInternalUrl}/health`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { games?: number; rooms?: number; clients?: number };
    return `online · protocol v${PROTOCOL_VERSION} · ${body.games ?? 0} game(s) · ${body.rooms ?? 0} room(s) · ${body.clients ?? 0} player(s)`;
  } catch {
    return `unreachable at ${config.gameserverInternalUrl} (published games fall back to solo play)`;
  }
}
