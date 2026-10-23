import fs from "node:fs/promises";
import path from "node:path";

/** Extra checks for commands newly enabled in v2. Existing permissions still
 * apply to all other commands; this is not an operating-system sandbox. */
export async function checkExpandedCommand(command, directory, workdir = directory) {
  if (/\bfind\b/.test(command) && /(?:-exec|-ok|-delete|-fprint|-fprintf|-fls|\.\.)/.test(command)) {
    throw new Error("find is available for local inspection only");
  }
  if (/\brg\b/.test(command) && /--pre(?:\s|=)|--hostname-bin/.test(command)) {
    throw new Error("rg cannot launch external commands");
  }
  if (!/\brm\b/.test(command)) return;
  if (!/^rm\s+(?:-[fr]+\s+)*(?:[\w./-]+(?:\s+|$))+$/.test(command)) {
    throw new Error("rm requires explicit project paths; shell operators, quoting and globs are unavailable");
  }
  const root = await fs.realpath(directory);
  const cwd = path.resolve(root, workdir);
  for (const argument of command.trim().split(/\s+/).slice(1).filter((arg) => !arg.startsWith("-"))) {
    if (argument.split("/").some((segment) => segment.startsWith("."))) throw new Error("rm cannot use dot or traversal segments");
    const resolved = path.resolve(cwd, argument);
    const segments = path.relative(root, resolved).split(path.sep);
    if (!["site", "scratch"].includes(segments[0]) || segments.length < 2 || segments.some((item) => !item || item.startsWith("."))
      || (segments[0] === "site" && ["net", "leaderboards", "js"].includes(segments[1]))
      || segments.some((item) => /^(?:package(?:-lock)?\.json|tsconfig\.json|node_modules)$/i.test(item))) {
      throw new Error("rm must stay inside editable site/ or scratch/ files");
    }
    let current = root;
    for (const segment of segments) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current).catch((error) => { if (error.code !== "ENOENT") throw error; });
      if (stat?.isSymbolicLink()) throw new Error("rm cannot traverse symlinks");
    }
    const relative = path.relative(root, current);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("rm escaped the project");
  }
}
