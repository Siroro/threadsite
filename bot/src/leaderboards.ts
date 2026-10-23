import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { ProjectKind } from "./types.js";
import { safeChild } from "./util.js";

/** Seed the score-only client in every game, independently of multiplayer wiring. */
export async function ensureLeaderboardFiles(workspacePath: string, kind: ProjectKind, gameId: string): Promise<boolean> {
  if (kind === "site") return false;
  const directory = safeChild(workspacePath, "site", "leaderboards");
  for (const dir of [safeChild(workspacePath, "site"), directory]) {
    const stat = await fs.lstat(dir).catch(() => undefined);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Leaderboard inputs must stay in regular workspace directories.");
    await fs.mkdir(dir, { recursive: true });
  }
  let changed = false;
  const write = async (file: string, content: string) => {
    const stat = await fs.lstat(file).catch(() => undefined);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error("Leaderboard inputs must be regular workspace files.");
    if (await fs.readFile(file, "utf8").catch(() => undefined) === content) return;
    await fs.writeFile(file, content, "utf8");
    changed = true;
  };
  for (const name of ["threadsite-leaderboards.js", "threadsite-leaderboards.d.ts", "threadsite-player.js", "threadsite-player.d.ts"]) {
    await write(safeChild(directory, name), await fs.readFile(path.join(process.cwd(), "assets", name), "utf8"));
  }
  await write(safeChild(directory, "leaderboards-config.js"),
    `// Harness-owned global leaderboard configuration; import, never edit.\nexport const LEADERBOARDS_CONFIG = Object.freeze(${JSON.stringify({ game: gameId, url: config.gameserverPublicUrl })});\n`);
  await write(safeChild(directory, "leaderboards-config.d.ts"), "export declare const LEADERBOARDS_CONFIG: { readonly game: string; readonly url: string };\n");
  await write(safeChild(workspacePath, "LEADERBOARDS.md"), await fs.readFile(path.join(process.cwd(), "assets", "agents", "leaderboards.md"), "utf8"));
  return changed;
}
