import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectKind } from "./types.js";
import { ensureGitignoreLines, safeChild } from "./util.js";

/** The bot's own node_modules — the seed source for workspace packages in a
 * dev checkout (and the source build-time staging reads; see stageEngineSeed). */
const BOT_NODE_MODULES = path.join(process.cwd(), "node_modules");

/**
 * Staged engine payload baked into the production image by
 * `npm run stage:engines` at build time, so the runtime carries only the
 * bytes the seeder reads instead of full engine package trees. A dev
 * checkout has no engine-seed/ and falls back to node_modules above.
 */
const ENGINE_SEED_ROOT = path.join(process.cwd(), "engine-seed");

/** Where this process reads engine payload files: the staged tree when the
 * image provides one, otherwise the dev checkout's node_modules. */
async function engineSourceRoot(): Promise<string> {
  return fs.access(ENGINE_SEED_ROOT).then(() => ENGINE_SEED_ROOT, () => BOT_NODE_MODULES);
}

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
  files: Array<{ from: string; to: string; content?: string }>;
  /** Recursive trees; declarationsOnly excludes runtime builds beside .d.ts files. */
  dirs: Array<{ from: string; to: string; declarationsOnly?: boolean }>;
  /** Package-relative path of the TypeScript declaration entry. */
  typesEntry: string;
}

const THREE_PACKAGE: EnginePackage = {
  name: "three",
  version: "0.186.1",
  manifest: JSON.stringify({
    name: "three",
    version: "0.186.1",
    description: "three.js browser ESM build (harness-seeded, curated manifest)",
    type: "module",
    license: "MIT",
    main: "./build/three.module.js",
    types: "./index.d.ts",
    exports: {
      ".": {
        types: "./index.d.ts",
        import: "./build/three.module.js",
      },
      // The seeded addons subset (glTF/Draco loaders, meshopt decoder) keeps
      // the canonical three import paths working for model loading.
      "./addons/*": "./examples/jsm/*",
      "./examples/jsm/*": "./examples/jsm/*",
    },
  }, null, 2) + "\n",
  // Runtime: the module build plus its internal core dependency (0.186+ ships
  // no minified builds; the harness bundle minifies). Types: the
  // DefinitelyTyped tree, which is a src/**/*.d.ts graph reached from index.d.ts.
  // Addons: exactly the glTF loading graph (GLTFLoader + the utils it imports,
  // DRACOLoader, the meshopt decoder) with matching declarations, so 3D
  // projects load models without vendoring loaders by hand. KTX2Loader ships
  // types only — GLTFLoader.d.ts imports it; skipLibCheck leaves its body
  // unchecked and GLTFLoader.js never imports it at runtime.
  files: [
    { from: "three/build/three.module.js", to: "build/three.module.js" },
    { from: "three/build/three.core.js", to: "build/three.core.js" },
    { from: "three/LICENSE", to: "LICENSE" },
    { from: "@types/three/index.d.ts", to: "index.d.ts" },
    { from: "three/examples/jsm/loaders/GLTFLoader.js", to: "examples/jsm/loaders/GLTFLoader.js" },
    { from: "three/examples/jsm/loaders/DRACOLoader.js", to: "examples/jsm/loaders/DRACOLoader.js" },
    { from: "three/examples/jsm/utils/BufferGeometryUtils.js", to: "examples/jsm/utils/BufferGeometryUtils.js" },
    { from: "three/examples/jsm/utils/SkeletonUtils.js", to: "examples/jsm/utils/SkeletonUtils.js" },
    { from: "three/examples/jsm/libs/meshopt_decoder.module.js", to: "examples/jsm/libs/meshopt_decoder.module.js" },
    { from: "@types/three/examples/jsm/loaders/GLTFLoader.d.ts", to: "examples/jsm/loaders/GLTFLoader.d.ts" },
    { from: "@types/three/examples/jsm/loaders/DRACOLoader.d.ts", to: "examples/jsm/loaders/DRACOLoader.d.ts" },
    { from: "@types/three/examples/jsm/loaders/KTX2Loader.d.ts", to: "examples/jsm/loaders/KTX2Loader.d.ts" },
    { from: "@types/three/examples/jsm/utils/BufferGeometryUtils.d.ts", to: "examples/jsm/utils/BufferGeometryUtils.d.ts" },
    { from: "@types/three/examples/jsm/utils/SkeletonUtils.d.ts", to: "examples/jsm/utils/SkeletonUtils.d.ts" },
    { from: "@types/three/examples/jsm/libs/meshopt_decoder.module.d.ts", to: "examples/jsm/libs/meshopt_decoder.module.d.ts" },
  ],
  dirs: [{ from: "@types/three/src", to: "src" }],
  typesEntry: "three/index.d.ts",
};

/**
 * Rapier physics, compat build: the WASM is base64-inlined into the single
 * ESM file (its `init()` decodes the embedded blob), so the workspace bundle
 * needs no .wasm asset handling — the plain esbuild step just works. 0.21
 * moved the payload under dist/ (entry `rapier.mjs`). Declarations are the
 * package's own .d.ts graph (rapier.d.ts → exports → math/dynamics/geometry/
 * pipeline/control → the raw wasm-binding types).
 */
const RAPIER_PACKAGE: EnginePackage = {
  name: "@dimforge/rapier3d-compat",
  version: "0.21.0",
  manifest: JSON.stringify({
    name: "@dimforge/rapier3d-compat",
    version: "0.21.0",
    description: "Rapier 3D physics, compat build with WASM inlined as base64 (harness-seeded, curated manifest)",
    type: "module",
    license: "Apache-2.0",
    main: "./rapier.mjs",
    types: "./rapier.d.ts",
    exports: {
      ".": {
        types: "./rapier.d.ts",
        import: "./rapier.mjs",
      },
    },
  }, null, 2) + "\n",
  files: [
    { from: "@dimforge/rapier3d-compat/dist/rapier.mjs", to: "rapier.mjs" },
    { from: "@dimforge/rapier3d-compat/LICENSE", to: "LICENSE" },
    { from: "@dimforge/rapier3d-compat/dist/rapier.d.ts", to: "rapier.d.ts" },
    { from: "@dimforge/rapier3d-compat/dist/exports.d.ts", to: "exports.d.ts" },
    { from: "@dimforge/rapier3d-compat/dist/math.d.ts", to: "math.d.ts" },
    { from: "@dimforge/rapier3d-compat/dist/init.d.ts", to: "init.d.ts" },
    { from: "@dimforge/rapier3d-compat/dist/coarena.d.ts", to: "coarena.d.ts" },
    { from: "@dimforge/rapier3d-compat/dist/raw.d.ts", to: "raw.d.ts" },
    { from: "@dimforge/rapier3d-compat/dist/rapier_wasm3d.d.ts", to: "rapier_wasm3d.d.ts" },
    { from: "@dimforge/rapier3d-compat/dist/rapier_wasm3d_bg.wasm.d.ts", to: "rapier_wasm3d_bg.wasm.d.ts" },
  ],
  dirs: [
    { from: "@dimforge/rapier3d-compat/dist/control", to: "control" },
    { from: "@dimforge/rapier3d-compat/dist/dynamics", to: "dynamics" },
    { from: "@dimforge/rapier3d-compat/dist/geometry", to: "geometry" },
    { from: "@dimforge/rapier3d-compat/dist/pipeline", to: "pipeline" },
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
  version: "0.9.16",
  manifest: JSON.stringify({
    name: "three-mesh-bvh",
    version: "0.9.16",
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

const EXCALIBUR_PACKAGE: EnginePackage = {
  name: "excalibur",
  version: "0.32.0",
  manifest: JSON.stringify({
    name: "excalibur",
    version: "0.32.0",
    description: "Excalibur browser ESM build (harness-seeded, curated manifest)",
    type: "module",
    license: "BSD-2-Clause",
    sideEffects: false,
    main: "./build/esm/excalibur.js",
    types: "./build/dist/excalibur.d.ts",
    exports: {
      ".": {
        types: "./build/dist/excalibur.d.ts",
        import: "./build/esm/excalibur.js",
        default: "./build/esm/excalibur.js",
      },
    },
  }, null, 2) + "\n",
  files: [
    { from: "excalibur/build/esm/excalibur.js", to: "build/esm/excalibur.js" },
    { from: "excalibur/build/dist/excalibur.d.ts", to: "build/dist/excalibur.d.ts" },
    { from: "excalibur/LICENSE.md", to: "LICENSE.md" },
  ],
  // The declaration graph shares dist/ with large UMD/development builds.
  // Seed all declarations, including nested imports, without those runtimes.
  dirs: [{ from: "excalibur/build/dist", to: "build/dist", declarationsOnly: true }],
  typesEntry: "excalibur/build/dist/excalibur.d.ts",
};

/** The engine packages a project kind depends on; sites get none. */
/**
 * Types-only companion for three's glTF addons: @types/three's
 * meshopt_decoder declaration re-exports `meshoptimizer/decoder`, which needs
 * this package beside three for authored code and the type gate to resolve.
 * The runtime decoder is three's own self-contained module; only the
 * declaration ships here.
 */
const MESHOPT_TYPES_PACKAGE: EnginePackage = {
  name: "meshoptimizer",
  version: "1.1.1",
  manifest: JSON.stringify({
    name: "meshoptimizer",
    version: "1.1.1",
    description: "meshoptimizer (harness-seeded, declarations for three/addons decoder imports)",
    type: "module",
    license: "MIT",
    types: "./meshopt_decoder.d.ts",
    exports: {
      "./decoder": { types: "./meshopt_decoder.d.ts", default: "./meshopt_decoder.mjs" },
    },
  }, null, 2) + "\n",
  files: [
    { from: "meshoptimizer/meshopt_decoder.d.ts", to: "meshopt_decoder.d.ts" },
  ],
  dirs: [],
  typesEntry: "meshoptimizer/meshopt_decoder.d.ts",
};

export function enginePackages(kind: ProjectKind): EnginePackage[] {
  if (kind === "game-3d") return [THREE_PACKAGE, MESHOPT_TYPES_PACKAGE, RAPIER_PACKAGE, THREE_MESH_BVH_PACKAGE];
  if (kind === "game-2d") return [EXCALIBUR_PACKAGE];
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

async function directoryFiles(sourceRoot: string, dir: EnginePackage["dirs"][number]): Promise<string[]> {
  const files = await collectRelativeFiles(path.join(sourceRoot, ...dir.from.split("/")));
  return dir.declarationsOnly ? files.filter((file) => file.endsWith(".d.ts")) : files;
}

async function copyEngineDirectory(sourceRoot: string, targetRoot: string, dir: EnginePackage["dirs"][number]): Promise<void> {
  if (!dir.declarationsOnly) {
    await fs.cp(path.join(sourceRoot, ...dir.from.split("/")), safeChild(targetRoot, ...dir.to.split("/")), { recursive: true, force: true });
    return;
  }
  for (const relative of await directoryFiles(sourceRoot, dir)) {
    const source = path.join(sourceRoot, ...dir.from.split("/"), ...relative.split("/"));
    const target = safeChild(targetRoot, ...dir.to.split("/"), ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
}

/** Bare import name → bundled declaration for every engine the harness can
 * seed, kind-independent; callers probe for the packages they care about.
 * The three entry also maps its seeded addon subpaths (three/addons/*,
 * three/examples/jsm/*) onto the workspace package so the validation gate's
 * tsconfig paths resolve glTF loader imports the way the exports map does at
 * runtime — the gate's mirror directory has no node_modules to walk. */
export function engineTypeEntries(workspacePath: string): Array<{ importName: string; declaration: string }> {
  return [THREE_PACKAGE, MESHOPT_TYPES_PACKAGE, RAPIER_PACKAGE, THREE_MESH_BVH_PACKAGE, EXCALIBUR_PACKAGE].map((engine) => ({
    importName: engine.name,
    declaration: safeChild(workspacePath, "node_modules", ...engine.typesEntry.split("/")),
  })).concat([
    { importName: "three/addons/*", declaration: safeChild(workspacePath, "node_modules", "three", "examples", "jsm", "*") },
    { importName: "three/examples/jsm/*", declaration: safeChild(workspacePath, "node_modules", "three", "examples", "jsm", "*") },
    { importName: "meshoptimizer/decoder", declaration: safeChild(workspacePath, "node_modules", "meshoptimizer", "meshopt_decoder.d.ts") },
  ]);
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
  const sourceRoot = await engineSourceRoot();
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
          const relatives = await directoryFiles(sourceRoot, dir);
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
      const target = path.join(packageDir, ...file.to.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (file.content !== undefined) await fs.writeFile(target, file.content, "utf8");
      else await fs.copyFile(path.join(sourceRoot, ...file.from.split("/")), target);
    }
    for (const dir of engine.dirs) {
      await copyEngineDirectory(sourceRoot, packageDir, dir);
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

/**
 * Stage the exact engine payload the seeder reads into `targetDir`, as a
 * node_modules-shaped subtree holding the spec entries at their `from` paths
 * (`<targetDir>/three/build/…`,
 * `<targetDir>/@dimforge/rapier3d-compat/dist/…`) — the layout
 * ensureEnginePackages resolves its `from` paths against, so the staged tree
 * is a drop-in source root. Always reads from `sourceRoot` (default: the
 * bot's own node_modules, complete at image build time) — never the staged
 * tree — and preflights every spec entry before writing, so a layout drift
 * between engines.ts and the installed packages fails the build naming the
 * missing paths, never the first game turn at runtime. Returns the staged
 * package names, deduplicated across kinds.
 */
export async function stageEngineSeed(targetDir: string, sourceRoot: string = BOT_NODE_MODULES): Promise<string[]> {
  const engines: EnginePackage[] = [];
  for (const kind of ["game-2d", "game-3d"] as const) {
    for (const engine of enginePackages(kind)) {
      if (!engines.some((existing) => existing.name === engine.name)) engines.push(engine);
    }
  }

  const missing: string[] = [];
  for (const engine of engines) {
    for (const file of engine.files) {
      await fs.access(path.join(sourceRoot, ...file.from.split("/"))).catch(() => missing.push(file.from));
    }
    for (const dir of engine.dirs) {
      await fs.access(path.join(sourceRoot, ...dir.from.split("/"))).catch(() => missing.push(`${dir.from}/`));
    }
  }
  if (missing.length) {
    throw new Error(`engine seed sources missing from ${sourceRoot}: the engines.ts spec no longer matches the installed packages. Missing: ${missing.join(", ")}`);
  }

  for (const engine of engines) {
    // Replace each package subtree with exactly the specified payload.
    const tops = new Set<string>();
    for (const entry of [...engine.files.map((file) => file.from), ...engine.dirs.map((dir) => dir.from)]) {
      const parts = entry.split("/");
      tops.add(parts[0].startsWith("@") && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0]);
    }
    for (const top of tops) {
      await fs.rm(safeChild(targetDir, ...top.split("/")), { recursive: true, force: true });
    }
    for (const file of engine.files) {
      const target = safeChild(targetDir, ...file.from.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (file.content !== undefined) await fs.writeFile(target, file.content, "utf8");
      else await fs.copyFile(path.join(sourceRoot, ...file.from.split("/")), target);
    }
    for (const dir of engine.dirs) {
      await copyEngineDirectory(sourceRoot, targetDir, { ...dir, to: dir.from });
    }
  }
  return engines.map((engine) => engine.name);
}
