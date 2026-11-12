import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { ProjectKind } from "./types.js";
import { writeWorkspaceInput } from "./workspace-inputs.js";

// Files copied verbatim from bot/assets into site/leaderboards/ (the tenant
// config files are generated per game, but share the same inventory).
const VENDORED_LEADERBOARD_FILES = [
  "leaderboards/threadsite-leaderboards.js", "leaderboards/threadsite-leaderboards.d.ts",
  "leaderboards/threadsite-player.js", "leaderboards/threadsite-player.d.ts",
] as const;

/** Every site/-relative file ensureLeaderboardFiles maintains. */
export const LEADERBOARD_SITE_FILES: readonly string[] = [
  ...VENDORED_LEADERBOARD_FILES, "leaderboards/leaderboards-config.js", "leaderboards/leaderboards-config.d.ts",
];

/** Seed the score-only client in every game, independently of multiplayer wiring. */
export async function ensureLeaderboardFiles(workspacePath: string, kind: ProjectKind, gameId: string): Promise<boolean> {
  if (kind === "site") return false;
  let changed = false;
  for (const relative of VENDORED_LEADERBOARD_FILES) {
    const name = relative.split("/").pop()!;
    changed = await writeWorkspaceInput(workspacePath, ["site", ...relative.split("/")], await fs.readFile(path.join(process.cwd(), "assets", name), "utf8")) || changed;
  }
  changed = await writeWorkspaceInput(workspacePath, ["site", "leaderboards", "leaderboards-config.js"],
    `// Harness-owned global leaderboard configuration; import, never edit.\nexport const LEADERBOARDS_CONFIG = Object.freeze(${JSON.stringify({ game: gameId, url: config.gameserverPublicUrl })});\n`) || changed;
  changed = await writeWorkspaceInput(workspacePath, ["site", "leaderboards", "leaderboards-config.d.ts"], "export declare const LEADERBOARDS_CONFIG: { readonly game: string; readonly url: string };\n") || changed;
  changed = await writeWorkspaceInput(workspacePath, ["LEADERBOARDS.md"], await fs.readFile(path.join(process.cwd(), "assets", "agents", "leaderboards.md"), "utf8")) || changed;
  return changed;
}
