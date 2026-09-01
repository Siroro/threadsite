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
  /** Existence probe beyond the manifest — reseeds if the payload went missing. */
  probe: string;
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
  probe: "build/three.core.min.js",
  typesEntry: "three/index.d.ts",
};

const PIXI_PACKAGE: EnginePackage = {
  name: "pixi.js",
  version: "8.20.1",
  manifest: JSON.stringify({
    name: "pixi.js",
    version: "8.20.1",
    description: "PixiJS browser ESM build (harness-seeded, curated manifest)",
    type: "module",
    license: "MIT",
    main: "./dist/pixi.min.mjs",
    types: "./dist/pixi.js.d.ts",
    exports: {
      ".": {
        types: "./dist/pixi.js.d.ts",
        import: "./dist/pixi.min.mjs",
      },
    },
  }, null, 2) + "\n",
  files: [
    { from: "pixi.js/dist/pixi.min.mjs", to: "dist/pixi.min.mjs" },
    { from: "pixi.js/dist/pixi.js.d.ts", to: "dist/pixi.js.d.ts" },
    { from: "pixi.js/LICENSE", to: "LICENSE" },
  ],
  dirs: [],
  probe: "dist/pixi.js.d.ts",
  typesEntry: "pixi.js/dist/pixi.js.d.ts",
};

/** The engine packages a project kind depends on; sites get none. */
export function enginePackages(kind: ProjectKind): EnginePackage[] {
  if (kind === "game-3d") return [THREE_PACKAGE];
  if (kind === "game-2d") return [PIXI_PACKAGE];
  return [];
}

/** Bare import name → bundled declaration for every engine the harness can
 * seed, kind-independent; callers probe for the packages they care about. */
export function engineTypeEntries(workspacePath: string): Array<{ importName: string; declaration: string }> {
  return [THREE_PACKAGE, PIXI_PACKAGE].map((engine) => ({
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
 * corruption; a content-compared manifest plus a payload probe catches both
 * and triggers a clean reseed. Returns true when anything had to be written.
 */
export async function ensureEnginePackages(workspacePath: string, kind: ProjectKind): Promise<boolean> {
  const packages = enginePackages(kind);
  if (!packages.length) return false;

  let changed = false;
  for (const engine of packages) {
    const packageDir = safeChild(workspacePath, "node_modules", engine.name);
    const manifestFile = path.join(packageDir, "package.json");
    const fresh = await fs.readFile(manifestFile, "utf8").catch(() => undefined) === engine.manifest
      && await fs.access(path.join(packageDir, ...engine.probe.split("/"))).then(() => true, () => false);
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
  changed = (await writeIfChanged(path.join(workspacePath, ".gitignore"), "node_modules/\n")) || changed;
  return changed;
}

async function writeIfChanged(file: string, content: string): Promise<boolean> {
  const current = await fs.readFile(file, "utf8").catch(() => undefined);
  if (current === content) return false;
  await fs.writeFile(file, content, "utf8");
  return true;
}
