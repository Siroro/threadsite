import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectKind } from "./types.js";
import { ensureGitignoreLines, safeChild } from "./util.js";

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

/**
 * Rapier physics, compat build: the WASM is base64-inlined into the single
 * ESM file, so the workspace bundle needs no .wasm asset handling — the
 * plain esbuild step just works. Declarations are the package's own .d.ts
 * graph (rapier.d.ts → exports → math/dynamics/geometry/pipeline/control →
 * the raw wasm-binding types).
 */
const RAPIER_PACKAGE: EnginePackage = {
  name: "@dimforge/rapier3d-compat",
  version: "0.12.0",
  manifest: JSON.stringify({
    name: "@dimforge/rapier3d-compat",
    version: "0.12.0",
    description: "Rapier 3D physics, compat build with WASM inlined as base64 (harness-seeded, curated manifest)",
    type: "module",
    license: "Apache-2.0",
    main: "./rapier.es.js",
    types: "./rapier.d.ts",
    exports: {
      ".": {
        types: "./rapier.d.ts",
        import: "./rapier.es.js",
      },
    },
  }, null, 2) + "\n",
  files: [
    { from: "@dimforge/rapier3d-compat/rapier.es.js", to: "rapier.es.js" },
    { from: "@dimforge/rapier3d-compat/LICENSE", to: "LICENSE" },
    { from: "@dimforge/rapier3d-compat/rapier.d.ts", to: "rapier.d.ts" },
    { from: "@dimforge/rapier3d-compat/exports.d.ts", to: "exports.d.ts" },
    { from: "@dimforge/rapier3d-compat/math.d.ts", to: "math.d.ts" },
    { from: "@dimforge/rapier3d-compat/init.d.ts", to: "init.d.ts" },
    { from: "@dimforge/rapier3d-compat/coarena.d.ts", to: "coarena.d.ts" },
    { from: "@dimforge/rapier3d-compat/raw.d.ts", to: "raw.d.ts" },
    { from: "@dimforge/rapier3d-compat/rapier_wasm3d.d.ts", to: "rapier_wasm3d.d.ts" },
    { from: "@dimforge/rapier3d-compat/rapier_wasm3d_bg.wasm.d.ts", to: "rapier_wasm3d_bg.wasm.d.ts" },
  ],
  dirs: [
    { from: "@dimforge/rapier3d-compat/control", to: "control" },
    { from: "@dimforge/rapier3d-compat/dynamics", to: "dynamics" },
    { from: "@dimforge/rapier3d-compat/geometry", to: "geometry" },
    { from: "@dimforge/rapier3d-compat/pipeline", to: "pipeline" },
  ],
  typesEntry: "@dimforge/rapier3d-compat/rapier.d.ts",
};

/**
 * BVH acceleration for static three.js geometry — fast raycasts, LOS/hitscan,
 * ground and spatial queries against complex meshes. Ships as an unbundled
 * ESM source tree whose only external import is bare "three" (it resolves
 * through the workspace's own seeded three package); the webgpu/tsl submodules
 * are unreachable from the "." entry and stay out of the bundle.
 */
const THREE_MESH_BVH_PACKAGE: EnginePackage = {
  name: "three-mesh-bvh",
  version: "0.9.14",
  manifest: JSON.stringify({
    name: "three-mesh-bvh",
    version: "0.9.14",
    description: "three-mesh-bvh BVH acceleration for three.js raycasts and spatial queries (harness-seeded, curated manifest)",
    type: "module",
    license: "MIT",
    main: "./src/index.js",
    types: "./src/index.d.ts",
    exports: {
      ".": {
        types: "./src/index.d.ts",
        import: "./src/index.js",
      },
    },
    peerDependencies: { three: ">=0.159.0" },
  }, null, 2) + "\n",
  files: [{ from: "three-mesh-bvh/LICENSE", to: "LICENSE" }],
  dirs: [{ from: "three-mesh-bvh/src", to: "src" }],
  typesEntry: "three-mesh-bvh/src/index.d.ts",
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
  if (kind === "game-3d") return [THREE_PACKAGE, RAPIER_PACKAGE, THREE_MESH_BVH_PACKAGE];
  if (kind === "game-2d") return [PHASER_PACKAGE];
  return [];
}

/** Every file under `dir` as a POSIX-style relative path, for dir freshness
 * checks; an unreadable source dir yields no files (the copy step owns the
 * resulting loud failure instead of a silent wrong-seed). */
async function collectRelativeFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, prefix: string[]): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), [...prefix, entry.name]);
      } else if (entry.isFile()) {
        out.push([...prefix, entry.name].join("/"));
      }
    }
  }
  await walk(dir, []);
  return out.sort();
}

/** Bare import name → bundled declaration for every engine the harness can
 * seed, kind-independent; callers probe for the packages they care about. */
export function engineTypeEntries(workspacePath: string): Array<{ importName: string; declaration: string }> {
  return [THREE_PACKAGE, RAPIER_PACKAGE, THREE_MESH_BVH_PACKAGE, PHASER_PACKAGE].map((engine) => ({
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
 * seeded payload file (single files and every file under the seeded
 * directories, runtime and declarations alike) catches both and triggers a
 * clean reseed. Returns true when anything had to be written.
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
    // remain would otherwise look healthy. Seeded directories get the same
    // treatment per file (listed from the bot-side source, checked in the
    // workspace): three-mesh-bvh's whole runtime is one seeded dir, and a
    // deleted module there must reseed, not fail the build looking fresh.
    // (Contents are covered by the content-compared manifest plus the
    // reseeding of the whole tree.)
    const fresh = await fs.readFile(manifestFile, "utf8").catch(() => undefined) === engine.manifest
      && await Promise.all([
        ...engine.files.map((file) =>
          fs.access(path.join(packageDir, ...file.to.split("/"))).then(() => true, () => false)),
        ...(await Promise.all(engine.dirs.map(async (dir) => {
          const relatives = await collectRelativeFiles(path.join(BOT_NODE_MODULES, ...dir.from.split("/")));
          const target = path.join(packageDir, ...dir.to.split("/"));
          return Promise.all(relatives.map((relative) =>
            fs.access(path.join(target, ...relative.split("/"))).then(() => true, () => false)),
          ).then((checks) => checks.every(Boolean));
        }))),
      ]).then((checks) => checks.every(Boolean));
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

  // The packages are build inputs, not project content: keep them out of git.
  // Ensure the ignore line exists without clobbering anything else the
  // workspace (or the agent's tooling) put in the file.
  changed = (await ensureGitignoreLines(workspacePath, ["node_modules/"])) || changed;
  return changed;
}
