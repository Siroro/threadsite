import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectKind } from "./types.js";
import { safeChild } from "./util.js";

const ASSETS_DIR = path.join(process.cwd(), "assets");

const EXCALIBUR_SKILLS = [
  "excalibur",
];

const THREEJS_SKILLS = [
  "threejs-game-studio",
];

const SHARED_SKILLS = [
  "game-ai",
  "game-feel",
  "game-ui-ux",
  "camera-systems",
  "input-systems",
  "audio-design",
  "level-design",
  "performance-optimization",
  "physics-tuning",
  "procedural-gen",
  "save-systems",
  "card-game",
  "fps-shooter",
  "platformer",
  "puzzle",
  "roguelike",
  "rpg",
  "survival-crafting",
  "tower-defense",
  "visual-novel",
];

/** Every skill the harness seeds for a project kind; sites get none. */
export function skillNames(kind: ProjectKind): string[] {
  if (kind === "game-2d") return ["game-2d", ...EXCALIBUR_SKILLS, ...SHARED_SKILLS];
  if (kind === "game-3d") return ["game-3d", ...THREEJS_SKILLS, ...SHARED_SKILLS];
  return [];
}

/**
 * Keep the harness-curated skill set in a game workspace current. OpenCode
 * discovers project skills from `.opencode/skills/<name>/SKILL.md` at the git
 * worktree root, so each game's session advertises only the engine and shared
 * playbooks appropriate to its kind. The files are copied recursively because
 * curated skills may carry reference material beside SKILL.md. Existing
 * user-authored skills are never removed; only the known harness skill names
 * are managed. Returns true when anything was written or removed.
 */
export async function ensureSkillFiles(workspacePath: string, kind: ProjectKind): Promise<boolean> {
  const desired = new Set(skillNames(kind));
  const skillsRoot = safeChild(workspacePath, ".opencode", "skills");
  let changed = false;

  for (const name of desired) {
    const source = safeChild(ASSETS_DIR, "skills", name);
    const target = safeChild(skillsRoot, name);
    if (await copyDirectoryIfChanged(source, target)) changed = true;
  }

  const managed = new Set([...skillNames("game-2d"), ...skillNames("game-3d")]);
  for (const entry of await fs.readdir(skillsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || desired.has(entry.name) || !managed.has(entry.name)) continue;
    await fs.rm(path.join(skillsRoot, entry.name), { recursive: true, force: true });
    changed = true;
  }

  return changed;
}

async function copyDirectoryIfChanged(source: string, target: string): Promise<boolean> {
  const sourceFiles = await listFiles(source);
  let fresh = true;
  for (const relative of sourceFiles) {
    const sourceFile = path.join(source, relative);
    const targetFile = path.join(target, relative);
    const [sourceText, targetText] = await Promise.all([
      fs.readFile(sourceFile),
      fs.readFile(targetFile).catch(() => undefined),
    ]);
    if (!targetText || !sourceText.equals(targetText)) {
      fresh = false;
      break;
    }
  }
  const targetFiles = await listFiles(target).catch(() => []);
  if (fresh && targetFiles.length === sourceFiles.length) return false;

  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true, force: true });
  return true;
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) await walk(path.join(current, entry.name), relative);
      else files.push(relative);
    }
  }
  await walk(root, "");
  return files.sort();
}
