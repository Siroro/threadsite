import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import * as esbuild from "esbuild";

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".gif": "image/gif", ".ico": "image/x-icon", ".avif": "image/avif",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".mp4": "video/mp4",
  ".webm": "video/webm", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
  ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
};

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Refuse links at every component, including ancestors of the site directory.
async function checkedPath(root, parts) {
  let target = root;
  for (const part of parts) {
    target = path.join(target, part);
    if ((await fs.lstat(target)).isSymbolicLink()) throw new Error("Preview does not follow symlinks.");
  }
  return target;
}

async function bundle(workspaceRoot, project) {
  const workspace = await checkedPath(workspaceRoot, project.split("/"));
  const site = await checkedPath(workspace, ["site"]);
  const source = path.join(site, "src");
  let entries = [];
  try {
    await checkedPath(site, ["src"]);
    entries = (await fs.readdir(source, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.(?:ts|mts)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name))
      .map((entry) => `src/${entry.name}`).sort();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!entries.length) {
    const sources = await fs.readdir(source, { recursive: true, withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    // Match the harness's no-entry case: nested TS alone cannot keep old JS alive.
    const compiled = sources.some((entry) => entry.isFile() && /\.(?:ts|mts)$/.test(entry.name));
    return { site, outputs: new Map(), compiled };
  }

  // Keep these production flags aligned with bot/src/build.ts. Only write and
  // the containment plugin differ: previews never touch the workspace/bundles.
  const result = await esbuild.build({
    absWorkingDir: site, entryPoints: entries, outdir: "js", outbase: "src",
    bundle: true, format: "esm", splitting: true, target: "es2022",
    legalComments: "eof", sourcemap: false, minify: true, metafile: true, logLevel: "silent",
    chunkNames: "chunks/[name]-[hash]", assetNames: "assets/[name]-[hash]", write: false,
    preserveSymlinks: true,
    plugins: [{
      name: "preview-boundary",
      setup(build) {
        build.onLoad({ filter: /.*/ }, async ({ path: file }) => {
          const modules = path.join(workspace, "node_modules");
          const root = inside(site, file) ? site : inside(modules, file) ? modules : undefined;
          if (!root) throw new Error("Preview imports must stay inside site/ or the project's node_modules/.");
          await checkedPath(workspaceRoot, path.relative(workspaceRoot, file).split(path.sep));
          if ((await fs.stat(file)).size > MAX_FILE_BYTES) throw new Error("Preview input exceeds 32 MiB.");
          // Let esbuild choose its native loader; this hook only checks access.
          return undefined;
        });
      },
    }],
  });
  if (result.outputFiles.reduce((total, file) => total + file.contents.length, 0) > MAX_FILE_BYTES) {
    throw new Error("Preview bundles exceed 32 MiB.");
  }
  return {
    site, compiled: true,
    outputs: new Map(result.outputFiles.map((file) => [path.relative(site, file.path).split(path.sep).join("/"), file.contents])),
  };
}

export function createPreviewServer({ workspaceRoot }) {
  const root = path.resolve(workspaceRoot);
  const snapshots = new Map();
  const pending = new Map();
  async function rebuild(project) {
    if (pending.has(project)) return pending.get(project);
    if (pending.size >= 2) throw new Error("Preview is busy; try again shortly.");
    // Drop the previous snapshot first so a broken edit cannot show stale JS.
    snapshots.delete(project);
    const task = bundle(root, project).then((snapshot) => {
      snapshots.set(project, snapshot);
      while (snapshots.size > 4) snapshots.delete(snapshots.keys().next().value);
      return snapshot;
    }).finally(() => pending.delete(project));
    pending.set(project, task);
    return task;
  }

  return http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
    if (req.url === "/health") { res.writeHead(200); res.end(req.method === "HEAD" ? undefined : "ok"); return; }
    try {
      const pathname = decodeURIComponent((req.url || "/").split("?")[0]);
      const segments = pathname.split("/").slice(1);
      // Workspaces use <Discord guild id>/<Discord thread id>.
      if (!/^\d{1,24}$/.test(segments[0]) || !/^\d{1,24}$/.test(segments[1])) {
        res.writeHead(404); res.end("Unknown preview project."); return;
      }
      if (segments.at(-1) === "") segments.pop();
      if (segments.some((part) => !part || part.startsWith(".") || /[\\\x00:]/.test(part))) {
        res.writeHead(403); res.end("Invalid preview path."); return;
      }
      if (segments.length === 2 && !pathname.endsWith("/")) {
        res.writeHead(302, { Location: `${pathname}/` }); res.end(); return;
      }
      const project = segments.slice(0, 2).join("/");
      const parts = segments.slice(2);
      if (pathname.endsWith("/")) parts.push("index.html");
      if (["src", "net", "node_modules"].includes(parts[0])) {
        res.writeHead(404); res.end("Source files are not deployed."); return;
      }
      const relative = parts.join("/");
      // HTML navigation/reload always builds current edits, including imports.
      const snapshot = /\.html?$/i.test(relative) || !snapshots.has(project)
        ? await rebuild(project) : await (pending.get(project) || snapshots.get(project));
      let body = snapshot.outputs.get(relative);
      if (!body) {
        if (snapshot.compiled && parts[0] === "js") {
          res.writeHead(404); res.end("Not emitted by the current TypeScript build."); return;
        }
        const file = await checkedPath(snapshot.site, parts);
        const stat = await fs.stat(file);
        if (!stat.isFile()) { res.writeHead(404); res.end(); return; }
        if (stat.size > MAX_FILE_BYTES) throw new Error("Preview file exceeds 32 MiB.");
        body = await fs.readFile(file);
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(relative).toLowerCase()] || "application/octet-stream" });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (error) {
      const missing = error.code === "ENOENT" || error.code === "ENOTDIR";
      const message = error.errors?.length
        ? (await esbuild.formatMessages(error.errors.slice(0, 8), { kind: "error", color: false })).join("\n")
        : error.message;
      res.writeHead(missing ? 404 : 500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : `ThreadSite preview: ${message}`);
    }
  });
}
