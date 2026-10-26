import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_FILES = 1000;
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
  ".m4a": "audio/mp4", ".flac": "audio/flac", ".aac": "audio/aac",
};

// Manifest kinds mirror what the asset viewer can render.
const MANIFEST_KINDS = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image",
  ".avif": "image", ".bmp": "image", ".svg": "image",
  ".glb": "model", ".gltf": "model",
  ".wav": "audio", ".mp3": "audio", ".ogg": "audio", ".m4a": "audio", ".flac": "audio", ".aac": "audio",
  ".mp4": "video", ".webm": "video",
  ".woff": "font", ".woff2": "font", ".ttf": "font", ".otf": "font",
  ".json": "data", ".txt": "data", ".csv": "data", ".xml": "data",
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

/** Recursive site/assets listing for the viewer manifest, symlink-free. */
async function assetManifest(workspaceRoot, project) {
  const root = await checkedPath(workspaceRoot, [...project.split("/"), "site", "assets"])
    .catch((error) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw error;
    });
  const files = [];
  let truncated = false;
  const walk = async (directory, prefix) => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_MANIFEST_FILES) { truncated = true; return; }
      if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
      else if (entry.isFile()) {
        const stat = await fs.stat(path.join(directory, entry.name));
        if (stat.size > MAX_FILE_BYTES) continue;
        files.push({ path: relative, bytes: stat.size,
          kind: MANIFEST_KINDS[path.extname(entry.name).toLowerCase()] || "other" });
      }
    }
  };
  try {
    if (root) await walk(root, "");
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  }
  return { project, files, truncated };
}

async function bundle(workspaceRoot, project, view) {
  const workspace = await checkedPath(workspaceRoot, project.split("/"));
  const site = await checkedPath(workspace, view ? ["scratch", view] : ["site"]);
  const projectSite = path.join(workspace, "site");
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
  if (!entries.length) return { site, outputs: new Map() };

  // Keep these production flags aligned with bot/src/build.ts. Only write and
  // the containment plugin differ: previews never touch the workspace/bundles.
  const result = await esbuild.build({
    absWorkingDir: site, entryPoints: entries, outdir: "js", outbase: "src",
    bundle: true, format: "esm", splitting: true, target: "es2022",
    legalComments: "eof", sourcemap: false, minify: true, metafile: true, logLevel: "silent",
    chunkNames: "chunks/[name]-[hash]", assetNames: "assets/[name]-[hash]", write: false,
    loader: { ".glb": "file", ".gltf": "file" },
    preserveSymlinks: true,
    plugins: [{
      name: "preview-boundary",
      setup(build) {
        build.onLoad({ filter: /.*/ }, async ({ path: file }) => {
          const modules = path.join(workspace, "node_modules");
          const root = inside(site, file) ? site : view && inside(projectSite, file) ? projectSite : inside(modules, file) ? modules : undefined;
          if (!root) throw new Error("Preview imports must stay inside the current view, site/ or the project's node_modules/.");
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
    site,
    outputs: new Map(result.outputFiles.map((file) => [path.relative(site, file.path).split(path.sep).join("/"), file.contents])),
  };
}

// Concurrent esbuild builds are bounded because each one is CPU-heavy and this
// container shares its cores with Chromium's software rasterizer. Requests
// beyond the limit wait their turn.
const MAX_CONCURRENT_BUILDS = Number(process.env.PREVIEW_BUILD_CONCURRENCY || 4);
const BUILD_QUEUE_TIMEOUT_MS = Number(process.env.PREVIEW_BUILD_QUEUE_TIMEOUT_MS || 30_000);
// Cached snapshots are what non-HTML requests (js/, css/, assets) are served
// from. Keep enough for concurrent threads so one thread's reload does not evict
// another thread's assets mid-load.
const SNAPSHOT_CACHE_SIZE = Number(process.env.PREVIEW_SNAPSHOT_CACHE || 16);

export function createPreviewServer({ workspaceRoot, viewerDist } = {}) {
  const root = path.resolve(workspaceRoot);
  // Harness-owned viewer bundle (viewer.html/app.js/draco), built by
  // build-viewer.mjs; absent in bare checkouts, which serves a clear error.
  const dist = path.resolve(viewerDist || path.join(path.dirname(fileURLToPath(import.meta.url)), "dist"));
  const snapshots = new Map();
  const pending = new Map();
  let activeBuilds = 0;
  const waiting = [];
  function acquireBuildSlot() {
    if (activeBuilds < MAX_CONCURRENT_BUILDS) {
      activeBuilds += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => { clearTimeout(timer); resolve(); },
        reject,
      };
      const timer = setTimeout(() => {
        const index = waiting.indexOf(waiter);
        if (index >= 0) waiting.splice(index, 1);
        reject(new Error("Preview is busy; try again shortly."));
      }, BUILD_QUEUE_TIMEOUT_MS);
      timer.unref?.();
      waiting.push(waiter);
    });
  }
  function releaseBuildSlot() {
    const next = waiting.shift();
    // Hand the slot straight to the next waiter; only decrement when idle.
    if (next) next.grant();
    else activeBuilds -= 1;
  }
  async function rebuild(project, view) {
    const key = view ? `${project}/__scratch/${view}` : project;
    if (pending.has(key)) return pending.get(key);
    // Drop the previous snapshot first so a broken edit cannot show stale JS.
    snapshots.delete(key);
    const task = (async () => {
      await acquireBuildSlot();
      try {
        return await bundle(root, project, view);
      } finally {
        releaseBuildSlot();
      }
    })().then((snapshot) => {
      snapshots.set(key, snapshot);
      while (snapshots.size > SNAPSHOT_CACHE_SIZE) snapshots.delete(snapshots.keys().next().value);
      return snapshot;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  return http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
    if (req.url === "/health") { res.writeHead(200); res.end(req.method === "HEAD" ? undefined : "ok"); return; }
    let pathname;
    // A bad escape is the client's fault; answer 400 instead of letting the
    // generic catch below classify the URIError as a 500.
    try { pathname = decodeURIComponent((req.url || "/").split("?")[0]); }
    catch { res.writeHead(400); res.end("Malformed percent-encoding in the request path."); return; }
    try {
      // The harness viewer bundle is project-independent and shared by every
      // __assets page; serve it from the built dist, never from a workspace.
      if (pathname === "/__viewer" || pathname.startsWith("/__viewer/")) {
        const parts = pathname.split("/").slice(2).filter(Boolean);
        if (!parts.length || parts.some((part) => part.startsWith("."))) { res.writeHead(404); res.end(); return; }
        const file = await checkedPath(dist, parts).catch(() => undefined);
        const stat = file && await fs.stat(file).catch(() => undefined);
        if (!stat?.isFile()) { res.writeHead(404); res.end(); return; }
        if (stat.size > MAX_FILE_BYTES) throw new Error("Viewer file exceeds 32 MiB.");
        res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
        res.end(req.method === "HEAD" ? undefined : await fs.readFile(file));
        return;
      }
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
      try { await checkedPath(root, project.split("/")); }
      catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") {
          for (const key of snapshots.keys()) if (key === project || key.startsWith(`${project}/`)) snapshots.delete(key);
        }
        throw error;
      }
      const parts = segments.slice(2);
      // Harness asset viewer: one page per project showing every site/assets
      // file. The HTML and JS come from the shared bundle; the manifest and
      // the assets themselves come from this project.
      if (parts[0] === "__assets") {
        parts.shift();
        if (!parts.length && !pathname.endsWith("/")) {
          res.writeHead(302, { Location: `${pathname}/` }); res.end(); return;
        }
        if (parts.length === 1 && parts[0] === "manifest.json") {
          const manifest = await assetManifest(root, project);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(req.method === "HEAD" ? undefined : `${JSON.stringify(manifest)}\n`);
          return;
        }
        if (parts.length && !(parts.length === 1 && parts[0] === "index.html")) {
          res.writeHead(404); res.end("The asset viewer serves only its page and manifest."); return;
        }
        const page = await fs.readFile(path.join(dist, "viewer.html")).catch(() => undefined);
        if (page === undefined) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("ThreadSite preview: asset viewer bundle is not built (run node build-viewer.mjs).");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(req.method === "HEAD" ? undefined : page);
        return;
      }
      let view;
      if (parts[0] === "__scratch") {
        view = parts[1];
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(view || "")) {
          res.writeHead(404); res.end("Scratch views use scratch/<name>/index.html and src/main.ts; name must be 1–64 letters, digits, hyphens or underscores."); return;
        }
        parts.splice(0, 2);
        if (!parts.length && !pathname.endsWith("/")) {
          res.writeHead(302, { Location: `${pathname}/` }); res.end(); return;
        }
      }
      if (pathname.endsWith("/")) parts.push("index.html");
      // Shared runtime assets bypass the full scene's build. Relative paths in
      // a shared CSS/data file continue to resolve within this same mount.
      const sharedAsset = view && parts[0] === "__site";
      if (sharedAsset) {
        parts.shift();
        if (!["assets", "css", "data"].includes(parts[0])) {
          res.writeHead(404); res.end("Scratch shared files must be under site/assets, site/css or site/data."); return;
        }
      }
      if (["src", "net", "node_modules"].includes(parts[0])) {
        res.writeHead(404); res.end("Source files are not deployed."); return;
      }
      const relative = parts.join("/");
      const key = view ? `${project}/__scratch/${view}` : project;
      // HTML navigation/reload always builds current edits, including imports.
      const snapshot = sharedAsset
        ? { site: await checkedPath(root, [...project.split("/"), "site"]), outputs: new Map() }
        : /\.html?$/i.test(relative) || !snapshots.has(key)
          ? await rebuild(project, view) : await (pending.get(key) || snapshots.get(key));
      let body = snapshot.outputs.get(relative);
      if (!body) {
        if (parts[0] === "js") {
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
