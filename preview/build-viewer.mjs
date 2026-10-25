// Bundles the harness asset viewer (viewer/viewer-main.js) into dist/ with
// three.js, the glTF loader and its Draco decoder. Run after npm ci; the
// preview image keeps only dist/ plus production dependencies.
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const out = path.join(root, "dist");
const three = path.join(root, "node_modules", "three");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: [path.join(root, "viewer", "viewer-main.js")],
  outfile: path.join(out, "app.js"),
  bundle: true, format: "esm", target: "es2022", minify: true, legalComments: "none",
  logLevel: "warning",
});

await cp(path.join(root, "viewer", "viewer.html"), path.join(out, "viewer.html"));
// DRACOLoader fetches these by name from its decoder path (/__viewer/draco/).
await cp(path.join(three, "examples", "jsm", "libs", "draco"), path.join(out, "draco"), { recursive: true });

console.log("viewer bundled into preview/dist");
