import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { MULTIPLAYER_PROTOCOL_VERSION, projectAgents } from "./templates.js";
import type { MultiplayerContext, ProjectKind } from "./types.js";
import { safeChild } from "./util.js";

export const PROTOCOL_VERSION = MULTIPLAYER_PROTOCOL_VERSION;

const ASSETS_DIR = path.join(process.cwd(), "assets");
const NET_CLIENT_STEM = "threadsite-net.js";

/**
 * Games are multi-tenant clients of the shared relay: the tenant key is simply
 * the published site slug, so no per-game provisioning exists anywhere.
 */
export function multiplayerContext(kind: ProjectKind, siteSlug: string): MultiplayerContext | undefined {
  if (!config.multiplayerEnabled || kind === "site") return undefined;
  return {
    gameId: siteSlug,
    wsUrl: config.gameserverPublicUrl,
    protocolVersion: PROTOCOL_VERSION,
  };
}

/**
 * Keep the harness-owned multiplayer files in a game workspace current:
 * site/js/threadsite-net.js (vendored protocol client), site/js/net-config.js
 * (this game's tenant id + relay URL), and the project AGENTS.md multiplayer
 * section. Runs on project creation, before every mutation, and again after
 * each agent turn (before validation), so agent deletions/drift are repaired
 * within the same turn. Writes are content-compared so an unchanged tree stays
 * untouched. Returns true when any file had to be restored.
 */
export async function ensureMultiplayerFiles(
  workspacePath: string,
  multiplayer: MultiplayerContext,
  kind: ProjectKind,
): Promise<boolean> {
  const jsDir = safeChild(workspacePath, "site", "js");
  await fs.mkdir(jsDir, { recursive: true });

  let changed = false;
  const client = await fs.readFile(path.join(ASSETS_DIR, NET_CLIENT_STEM), "utf8");
  changed = (await writeIfChanged(safeChild(jsDir, NET_CLIENT_STEM), `${client.trimEnd()}\n`)) || changed;

  const netConfig = [
    "// Harness-owned multiplayer configuration for this game.",
    "// The ThreadSite bot rewrites this file every turn — import it, never edit it.",
    `export const NET_CONFIG = Object.freeze({`,
    `  protocol: ${multiplayer.protocolVersion},`,
    `  game: ${JSON.stringify(multiplayer.gameId)},`,
    `  url: ${JSON.stringify(multiplayer.wsUrl)},`,
    `});`,
    "",
  ].join("\n");
  changed = (await writeIfChanged(safeChild(jsDir, "net-config.js"), netConfig)) || changed;

  changed = (await writeIfChanged(
    safeChild(workspacePath, "AGENTS.md"),
    projectAgents(kind, multiplayer),
  )) || changed;
  return changed;
}

async function writeIfChanged(file: string, content: string): Promise<boolean> {
  const current = await fs.readFile(file, "utf8").catch(() => undefined);
  if (current === content) return false;
  await fs.writeFile(file, content, "utf8");
  return true;
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
