import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import type { ProjectRecord } from "./types.js";
import { htmlEscape, safeChild } from "./util.js";

const execFileAsync = promisify(execFile);

const BLOCKED_SERVER_EXTENSIONS = new Set([
  // The generated tree is served by host Apache, not only by Docker. Keep obvious
  // server-executable/config formats out even though arbitrary static file types are allowed.
  ".php", ".php3", ".php4", ".php5", ".php7", ".php8", ".phtml", ".phar",
  ".cgi", ".fcgi", ".pl", ".pm", ".py", ".pyw", ".rb", ".rhtml",
  ".sh", ".bash", ".zsh", ".fish", ".ksh", ".csh",
  ".asp", ".aspx", ".ashx", ".asmx", ".jsp", ".jspx", ".war",
  ".shtml", ".shtm", ".stm",
]);

export interface SiteStats { files: number; bytes: number }

export async function validateSite(siteDir: string): Promise<SiteStats> {
  const root = path.resolve(siteDir);
  const index = safeChild(root, "index.html");
  const indexStat = await fs.lstat(index).catch(() => undefined);
  if (!indexStat?.isFile()) throw new Error("Generated site must contain site/index.html");

  let files = 0;
  let bytes = 0;
  const scripts: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) throw new Error(`Dotfiles are not publishable: ${entry.name}`);
      const absolute = safeChild(root, path.relative(root, dir), entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Symlinks are not publishable: ${path.relative(root, absolute)}`);
      if (stat.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Unsupported filesystem entry: ${path.relative(root, absolute)}`);
      const extension = path.extname(entry.name).toLowerCase();
      if (BLOCKED_SERVER_EXTENSIONS.has(extension)) {
        throw new Error(`Blocked server-executable file extension '${extension}': ${path.relative(root, absolute)}`);
      }
      if (extension === ".js" || extension === ".mjs") scripts.push(absolute);
      files += 1;
      bytes += stat.size;
      if (files > config.maxSiteFiles) throw new Error(`Site exceeds MAX_SITE_FILES (${config.maxSiteFiles})`);
      if (bytes > config.maxSiteBytes) throw new Error(`Site exceeds MAX_SITE_BYTES (${config.maxSiteBytes})`);
    }
  }

  await walk(root);
  await validateScriptSyntax(root, scripts);
  return { files, bytes };
}

/** Parse every JS file with node --check so syntax errors never reach the browser. */
async function validateScriptSyntax(root: string, scripts: string[]): Promise<void> {
  for (const script of scripts) {
    let result: { stderr?: string };
    try {
      result = await execFileAsync(process.execPath, ["--check", script], { timeout: 10_000 });
    } catch (error) {
      result = error as { stderr?: string };
    }
    if (result.stderr?.trim()) {
      const first = result.stderr.split("\n").find((line) => line.includes("Error:") && !line.trim().startsWith("at ")) ?? result.stderr.split("\n")[0];
      throw new Error(
        `JavaScript syntax error in site/${path.relative(root, script).replaceAll(path.sep, "/")}: ${first.trim()}`,
      );
    }
  }
}

export async function publishSite(siteDir: string, siteSlug: string): Promise<void> {
  await fs.mkdir(config.publishRoot, { recursive: true });
  const target = safeChild(config.publishRoot, siteSlug);
  const suffix = crypto.randomBytes(5).toString("hex");
  const staging = safeChild(config.publishRoot, `.staging-${siteSlug}-${suffix}`);
  const backup = safeChild(config.publishRoot, `.backup-${siteSlug}-${suffix}`);

  await fs.rm(staging, { recursive: true, force: true });
  await fs.cp(siteDir, staging, { recursive: true, dereference: false, force: true });
  await versionAssetReferences(staging);

  let hadOld = false;
  try {
    await fs.rename(target, backup);
    hadOld = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    await fs.rename(staging, target);
    if (hadOld) await fs.rm(backup, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    if (hadOld) await fs.rename(backup, target).catch(() => undefined);
    throw error;
  }
}

/**
 * Rewrite local CSS/JS references in published HTML with content-hash query
 * strings (style.css?v=a1b2c3) so a fresh deploy always busts browser/CDN
 * caches, while unchanged files keep their URLs and stay cached. Only relative
 * same-site references are touched; remote URLs and non-asset links pass
 * through untouched. Runs on the staging copy, so the workspace source and the
 * git history stay clean.
 */
async function versionAssetReferences(stagingRoot: string): Promise<void> {
  const htmlFiles = await listHtmlFiles(stagingRoot);
  for (const html of htmlFiles) {
    const original = await fs.readFile(html, "utf8");
    const hashCache = new Map<string, string>();
    let rewritten = original.replace(
      /(\b(?:src|href)\s*=\s*)(["'])([^"']+)\2/gi,
      (match, attribute: string, quote: string, url: string) => {
        const versioned = versionUrl(url, stagingRoot, path.dirname(html), hashCache);
        return versioned ? `${attribute}${quote}${versioned}${quote}` : match;
      },
    );
    // ES module imports inside inline <script type="module"> blocks.
    rewritten = rewritten.replace(
      /(from\s+|import\s*\(\s*|import\s+)(["'])(\.{1,2}\/[^"']+\.js)\2/gi,
      (match, prefix: string, quote: string, url: string) => {
        const versioned = versionUrl(url, stagingRoot, path.dirname(html), hashCache);
        return versioned ? `${prefix}${quote}${versioned}${quote}` : match;
      },
    );
    if (rewritten !== original) await fs.writeFile(html, rewritten, "utf8");
  }
}

function versionUrl(
  rawUrl: string,
  stagingRoot: string,
  htmlDir: string,
  hashCache: Map<string, string>,
): string | undefined {
  const [reference, ...rest] = rawUrl.split("#");
  const hashFragment = rest.length ? `#${rest.join("#")}` : "";
  const [pathPart, ...queryRest] = reference.split("?");
  const existingQuery = queryRest.length ? `?${queryRest.join("?")}` : "";
  if (!/\.(css|js|mjs)$/i.test(pathPart)) return undefined;
  // Only relative references resolve against this site; absolute paths,
  // remote URLs, and protocol-relative URLs are left alone.
  if (/^(?:[a-z]+:)?\/\//i.test(pathPart) || pathPart.startsWith("/") || pathPart.startsWith("data:")) return undefined;

  const resolved = path.resolve(htmlDir, decodeURIComponent(pathPart));
  if (!resolved.startsWith(`${stagingRoot}${path.sep}`)) return undefined;
  const cached = hashCache.get(resolved);
  if (cached) return `${pathPart}${existingQuery || `?v=${cached}`}${hashFragment}`;
  const content = fsSync.readFileSync(resolved);
  if (!content.length) return undefined;
  const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 10);
  hashCache.set(resolved, hash);
  return `${pathPart}${existingQuery || `?v=${hash}`}${hashFragment}`;
}

async function listHtmlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (/\.html?$/i.test(entry.name)) out.push(absolute);
    }
  }
  await walk(root);
  return out;
}

export function siteUrl(project: ProjectRecord): string {
  return `${config.publicSitesBaseUrl}/${encodeURIComponent(project.siteSlug)}/`;
}

export async function publishIndex(projects: ProjectRecord[], repoUrl: (repo: string) => string): Promise<void> {
  if (!config.publicIndexEnabled) return;
  await fs.mkdir(config.publishRoot, { recursive: true });
  const rows = projects
    .filter((p) => p.status === "ready")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((project) => `
      <li>
        <a class="site" href="${htmlEscape(`${config.publicSitesBaseUrl}/${encodeURIComponent(project.siteSlug)}/`)}">${htmlEscape(project.displayName)}</a>
        <span>·</span>
        <a href="${htmlEscape(repoUrl(project.repoName))}">source</a>
        <small>${htmlEscape(new Date(project.updatedAt).toLocaleString("en-GB", { timeZone: "UTC" }))} UTC</small>
      </li>`)
    .join("\n");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Discord-built sites</title><style>
:root{font-family:ui-sans-serif,system-ui,sans-serif;color-scheme:dark;background:#111;color:#eee}body{max-width:900px;margin:4rem auto;padding:0 1.25rem}h1{font-size:clamp(2rem,7vw,4rem);margin-bottom:.25rem}p{color:#aaa}ul{padding:0;list-style:none}li{display:flex;gap:.65rem;align-items:baseline;flex-wrap:wrap;padding:1rem 0;border-bottom:1px solid #333}.site{font-size:1.25rem;font-weight:700}a{color:#9ecbff}small{margin-left:auto;color:#888}@media(max-width:600px){small{width:100%;margin-left:0}}
</style></head><body><h1>Discord-built sites</h1><p>Each site has a public git history. Newest updates first.</p><ul>${rows || "<li>No sites yet.</li>"}</ul></body></html>`;
  await fs.writeFile(safeChild(config.publishRoot, "index.html"), html, "utf8");
}
