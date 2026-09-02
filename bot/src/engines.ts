import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectKind } from "./types.js";
import { safeChild } from "./util.js";

/** The bot image's own node_modules — the seed source for workspace packages. */
const BOT_NODE_MODULES = path.join(process.cwd(), "node_modules");

/**
 * A browser engine the harness installs into game workspaces as a real,
 * npm-shaped package: a curated `package.json` (min browser ESM build as the
 * entry, bundled TypeScript declarations as the types) plus just the files
 * those two point at. Authored code imports it by its bare package name,
 * exactly like normal npm usage — the workspace bundle resolves it from
 * `node_modules` at build time and tree-shakes it into the output, and both
 * the agent's language server and the validation gate get the package's REAL
 * types instead of `any` stubs.
 */
interface EnginePackage {
  name: string;
  version: string;
  /** package.json content; the marker file for cheap per-turn freshness checks. */
  manifest: string;
  /** Files copied verbatim from the bot's node_modules, [bot-relative, package-relative]. */
  files: Array<{ from: string; to: string }>;
  /** Directories copied recursively, as [bot-relative source, package-relative target]. */
  dirs: Array<{ from: string; to: string }>;
  /** Package-relative path of the TypeScript declaration entry. */
  typesEntry: string;
}

const THREE_PACKAGE: EnginePackage = {
  name: "three",
  version: "0.185.1",
  manifest: JSON.stringify({
    name: "three",
    version: "0.185.1",
    description: "three.js browser ESM build (harness-seeded, curated manifest)",
    type: "module",
    license: "MIT",
    main: "./build/three.module.min.js",
    types: "./index.d.ts",
    exports: {
      ".": {
        types: "./index.d.ts",
        import: "./build/three.module.min.js",
      },
    },
  }, null, 2) + "\n",
  // Runtime: the minified module + its internal core dependency. Types: the
  // DefinitelyTyped tree, which is a src/**/*.d.ts graph reached from index.d.ts.
  files: [
    { from: "three/build/three.module.min.js", to: "build/three.module.min.js" },
    { from: "three/build/three.core.min.js", to: "build/three.core.min.js" },
    { from: "three/LICENSE", to: "LICENSE" },
    { from: "@types/three/index.d.ts", to: "index.d.ts" },
  ],
  dirs: [{ from: "@types/three/src", to: "src" }],
  typesEntry: "three/index.d.ts",
};

const PHASER_PACKAGE: EnginePackage = {
  name: "phaser",
  version: "4.2.1",
  manifest: JSON.stringify({
    name: "phaser",
    version: "4.2.1",
    description: "Phaser 4 browser ESM build (harness-seeded, curated manifest)",
    type: "module",
    license: "MIT",
    main: "./dist/phaser.esm.min.js",
    types: "./types/phaser.d.ts",
    exports: {
      ".": {
        types: "./types/phaser.d.ts",
        import: "./dist/phaser.esm.min.js",
        default: "./dist/phaser.esm.min.js",
      },
    },
  }, null, 2) + "\n",
  files: [
    { from: "phaser/dist/phaser.esm.min.js", to: "dist/phaser.esm.min.js" },
    { from: "phaser/types/phaser.d.ts", to: "types/phaser.d.ts" },
    { from: "phaser/types/matter.d.ts", to: "types/matter.d.ts" },
    { from: "phaser/LICENSE.md", to: "LICENSE.md" },
  ],
  dirs: [],
  typesEntry: "phaser/types/phaser.d.ts",
};

/** The engine packages a project kind depends on; sites get none. */
export function enginePackages(kind: ProjectKind): EnginePackage[] {
  if (kind === "game-3d") return [THREE_PACKAGE];
  if (kind === "game-2d") return [PHASER_PACKAGE];
  return [];
}

/** Bare import name → bundled declaration for every engine the harness can
 * seed, kind-independent; callers probe for the packages they care about. */
export function engineTypeEntries(workspacePath: string): Array<{ importName: string; declaration: string }> {
  return [THREE_PACKAGE, PHASER_PACKAGE].map((engine) => ({
    importName: engine.name,
    declaration: safeChild(workspacePath, "node_modules", ...engine.typesEntry.split("/")),
  }));
}

/**
 * Keep the harness-managed engine packages in a workspace current: a real
 * (curated) `node_modules/<package>` tree at the workspace root, gitignored
 * and never published — the engine reaches the browser only as part of the
 * compiled bundle. Runs on project creation (before the agent session starts)
 * and is re-checked before every mutation and after every agent turn. The
 * agent cannot edit outside `site/` at all, so drift is only deletion or
 * corruption; a content-compared manifest plus existence checks on EVERY
 * seeded payload file (runtime and declarations alike) catches both and
 * triggers a clean reseed. Returns true when anything had to be written.
 */
export async function ensureEnginePackages(workspacePath: string, kind: ProjectKind): Promise<boolean> {
  const packages = enginePackages(kind);
  if (!packages.length) return false;

  let changed = false;
  // v2.x workspaces may still carry the old harness-owned Pixi package. Remove
  // it during the same freshness pass so the agent cannot silently keep using
  // a renderer the current 2D rules no longer support.
  if (kind === "game-2d") {
    const legacyPixi = safeChild(workspacePath, "node_modules", "pixi.js");
    if (await fs.access(legacyPixi).then(() => true, () => false)) {
      await fs.rm(legacyPixi, { recursive: true, force: true });
      changed = true;
    }
  }
  for (const engine of packages) {
    const packageDir = safeChild(workspacePath, "node_modules", engine.name);
    const manifestFile = path.join(packageDir, "package.json");
    // Every seeded file must exist — a runtime build missing while its types
    // remain would otherwise look healthy. (Contents are covered by the
    // content-compared manifest plus the reseeding of the whole tree.)
    const fresh = await fs.readFile(manifestFile, "utf8").catch(() => undefined) === engine.manifest
      && await Promise.all(
        engine.files.map((file) =>
          fs.access(path.join(packageDir, ...file.to.split("/"))).then(() => true, () => false)),
      ).then((checks) => checks.every(Boolean));
    if (fresh) continue;

    await fs.rm(packageDir, { recursive: true, force: true });
    await fs.mkdir(packageDir, { recursive: true });
    for (const file of engine.files) {
      const source = path.join(BOT_NODE_MODULES, ...file.from.split("/"));
      const target = path.join(packageDir, ...file.to.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }
    for (const dir of engine.dirs) {
      await fs.cp(path.join(BOT_NODE_MODULES, ...dir.from.split("/")), path.join(packageDir, ...dir.to.split("/")), { recursive: true, force: true });
    }
    await fs.writeFile(manifestFile, engine.manifest, "utf8");
    changed = true;
  }

  // The packages are build inputs, not project content: keep them out of git
  // (the manifest, sources, and compiled output stay the committed record).
  // Ensure the ignore line exists without clobbering anything else the
  // workspace (or the agent's tooling) put in the file.
  changed = (await ensureGitignoreLine(workspacePath, "node_modules/")) || changed;
  return changed;
}

/** Add `line` to the workspace .gitignore when missing; never rewrite the file. */
async function ensureGitignoreLine(workspacePath: string, line: string): Promise<boolean> {
  const file = path.join(workspacePath, ".gitignore");
  const current = await fs.readFile(file, "utf8").catch(() => "");
  const lines = current.split(/\r?\n/);
  if (lines.some((entry) => entry.trim() === line)) return false;
  const next = current === "" ? `${line}\n` : `${current.endsWith("\n") ? current : `${current}\n`}${line}\n`;
  await fs.writeFile(file, next, "utf8");
  return true;
}
