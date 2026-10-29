import fs from "node:fs/promises";
import path from "node:path";
import { safeChild } from "./util.js";

async function statIfPresent(file: string) {
  try { return await fs.lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function inputPath(workspace: string, parts: readonly string[], createParents: boolean): Promise<string | undefined> {
  const target = safeChild(workspace, ...parts);
  const relative = path.relative(path.resolve(workspace), target);
  if (!relative) throw new Error("A harness input cannot replace the workspace root.");
  let directory = path.resolve(workspace);
  for (const part of ["", ...relative.split(path.sep).slice(0, -1)]) {
    directory = path.join(directory, part);
    const stat = await statIfPresent(directory);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Harness inputs must stay in regular workspace directories.");
    if (!stat) {
      if (!createParents) return undefined;
      await fs.mkdir(directory, { recursive: true });
    }
  }
  return target;
}

/** Harness inputs must never follow agent-authored directory or file links. */
export async function writeWorkspaceInput(workspace: string, parts: readonly string[], content: string): Promise<boolean> {
  const target = (await inputPath(workspace, parts, true))!;
  const stat = await statIfPresent(target);
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1)) throw new Error("Harness inputs must be regular workspace files.");
  if (stat && await fs.readFile(target, "utf8") === content) return false;
  await fs.writeFile(target, content, "utf8");
  return true;
}

/** Removal reports success only after it lands; filesystem failures remain retryable. */
export async function removeWorkspaceInput(workspace: string, parts: readonly string[], recursive = false): Promise<boolean> {
  const target = await inputPath(workspace, parts, false);
  if (!target) return false;
  const stat = await statIfPresent(target);
  if (!stat) return false;
  if (stat.isSymbolicLink()) await fs.unlink(target);
  else await fs.rm(target, { recursive, force: true });
  return true;
}
