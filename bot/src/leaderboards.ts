import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { ProjectKind } from "./types.js";
import { writeWorkspaceInput } from "./workspace-inputs.js";

/** Seed the score-only client in every game, independently of multiplayer wiring. */
export async function ensureLeaderboardFiles(workspacePath: string, kind: ProjectKind, gameId: string): Promise<boolean> {
  if (kind === "site") return false;
  let changed = false;
  for (const name of ["threadsite-leaderboards.js", "threadsite-leaderboards.d.ts", "threadsite-player.js", "threadsite-player.d.ts"]) {
    changed = await writeWorkspaceInput(workspacePath, ["site", "leaderboards", name], await fs.readFile(path.join(process.cwd(), "assets", name), "utf8")) || changed;
  }
  changed = await writeWorkspaceInput(workspacePath, ["site", "leaderboards", "leaderboards-config.js"],
    `// Harness-owned global leaderboard configuration; import, never edit.\nexport const LEADERBOARDS_CONFIG = Object.freeze(${JSON.stringify({ game: gameId, url: config.gameserverPublicUrl })});\n`) || changed;
  changed = await writeWorkspaceInput(workspacePath, ["site", "leaderboards", "leaderboards-config.d.ts"], "export declare const LEADERBOARDS_CONFIG: { readonly game: string; readonly url: string };\n") || changed;
  changed = await writeWorkspaceInput(workspacePath, ["LEADERBOARDS.md"], await fs.readFile(path.join(process.cwd(), "assets", "agents", "leaderboards.md"), "utf8")) || changed;
  return changed;
}
