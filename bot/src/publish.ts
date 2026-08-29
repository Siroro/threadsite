import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
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
  await validateInlineScripts(root);
  await validateAssetReferences(root);
  await validateScriptTypes(root, scripts);
  return { files, bytes };
}

/** Parse every JS file with node --check so syntax errors never reach the browser. */
async function validateScriptSyntax(root: string, scripts: string[]): Promise<void> {
  for (const script of scripts) {
    await checkScriptSyntax(script, `site/${path.relative(root, script).replaceAll(path.sep, "/")}`);
  }
}

/** node --check one script; `label` names it in the thrown error. */
async function checkScriptSyntax(absolute: string, label: string): Promise<void> {
  let result: { stderr?: string };
  try {
    result = await execFileAsync(process.execPath, ["--check", absolute], { timeout: 10_000 });
  } catch (error) {
    result = error as { stderr?: string };
  }
  if (result.stderr?.trim()) {
    const first = result.stderr.split("\n").find((line) => line.includes("Error:") && !line.trim().startsWith("at ")) ?? result.stderr.split("\n")[0];
    throw new Error(`JavaScript syntax error in ${label}: ${first.trim()}`);
  }
}

/**
 * Syntax-check JavaScript embedded in <script> blocks and JSON embedded in
 * import maps: standalone .js files are covered by validateScriptSyntax, but
 * inline blocks reach the browser just the same. Type-checking inline code is
 * impractical (its relative imports cannot be relocated), so this pass is
 * syntax-only.
 */
async function validateInlineScripts(root: string): Promise<void> {
  const checks: Array<{ extension: ".js" | ".mjs" | ".json"; body: string; label: string }> = [];
  for (const html of await listHtmlFiles(root)) {
    const rel = `site/${path.relative(root, html).replaceAll(path.sep, "/")}`;
    const source = await fs.readFile(html, "utf8");
    let index = 0;
    for (const [, attrs = "", body = ""] of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      index += 1;
      if (tagAttr(attrs, "src")) continue;
      if (!body.trim()) continue;
      const type = tagAttr(attrs, "type").toLowerCase();
      const label = `${rel} (inline <script> #${index})`;
      if (type === "importmap") checks.push({ extension: ".json", body, label });
      else if (type === "module") checks.push({ extension: ".mjs", body, label });
      else if (!type || /^(?:text|application)\/(?:java|ecma)script$/.test(type)) checks.push({ extension: ".js", body, label });
    }
  }
  if (!checks.length) return;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-inline-"));
  try {
    for (const [i, check] of checks.entries()) {
      if (check.extension === ".json") {
        try {
          JSON.parse(check.body);
        } catch (error) {
          throw new Error(`JavaScript syntax error in ${check.label}: import map is not valid JSON: ${String((error as Error).message ?? error)}`);
        }
        continue;
      }
      const file = path.join(tempDir, `inline-${i}${check.extension}`);
      await fs.writeFile(file, check.body, "utf8");
      await checkScriptSyntax(file, check.label);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Local <script src> and stylesheet <link href> references must point at real
 * files inside the site, and must be relative: sites are served under a path
 * prefix, so site-root-absolute URLs like "/js/main.js" 404 in production.
 * Remote URLs, data/blob URIs, fragments, and template placeholders are left
 * alone, and non-stylesheet links (favicons etc.) are only checked when
 * already relative.
 */
async function validateAssetReferences(root: string): Promise<void> {
  for (const html of await listHtmlFiles(root)) {
    const rel = `site/${path.relative(root, html).replaceAll(path.sep, "/")}`;
    const source = await fs.readFile(html, "utf8");
    const references: Array<{ kind: string; url: string; enforceRelative: boolean }> = [];
    for (const [, attrs = ""] of source.matchAll(/<script\b([^>]*)>/gi)) {
      const src = tagAttr(attrs, "src");
      if (src) references.push({ kind: "<script src>", url: src, enforceRelative: true });
    }
    for (const [, attrs = ""] of source.matchAll(/<link\b([^>]*)>/gi)) {
      const href = tagAttr(attrs, "href");
      if (href) {
        const relAttr = tagAttr(attrs, "rel").toLowerCase();
        references.push({ kind: `<link rel="${relAttr || "?"}">`, url: href, enforceRelative: /stylesheet/.test(relAttr) });
      }
    }
    for (const reference of references) {
      const url = reference.url.trim();
      if (!url || url.startsWith("#")) continue;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) continue;
      if (url.includes("${")) continue;
      if (url.startsWith("/")) {
        if (reference.enforceRelative) {
          throw new Error(`Broken local reference in ${rel}: ${reference.kind} "${url}" is a site-root-absolute path, but the site is served under a path prefix — use a relative URL.`);
        }
        continue;
      }
      const clean = url.split("#")[0].split("?")[0];
      if (!clean) continue;
      let decoded: string;
      try {
        decoded = decodeURIComponent(clean);
      } catch {
        throw new Error(`Broken local reference in ${rel}: ${reference.kind} "${url}" is not a valid URL encoding.`);
      }
      const resolved = path.resolve(path.dirname(html), decoded);
      if (!resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Broken local reference in ${rel}: ${reference.kind} "${url}" points outside the site directory.`);
      }
      const exists = await fs.access(resolved).then(() => true, () => false);
      if (!exists) {
        throw new Error(`Broken local reference in ${rel}: ${reference.kind} points at missing local file "${url}".`);
      }
    }
  }
}

/** Value of a quoted attribute (double or single) inside a tag's attribute string. */
function tagAttr(attrs: string, name: string): string {
  const match = attrs.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

/**
 * Check authored browser JavaScript with tsc. Deliberately lenient: strict null
 * checks are off (DOM APIs return nullable types everywhere and generated code
 * rarely guards them), TS2307 diagnostics for non-relative imports are
 * dropped because CDN/import-map dependencies like `three` have no local
 * node_modules to resolve against, and TS2339 diagnostics on DOM base-type
 * receivers are dropped because un-narrowed DOM lookups are idiomatic here.
 */
async function validateScriptTypes(root: string, scripts: string[]): Promise<void> {
  const authoredScripts = scripts.filter((script) =>
    path.relative(root, script).replaceAll(path.sep, "/") !== "js/threadsite-net.js",
  );
  if (!authoredScripts.length) return;

  const typeScriptCli = path.join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
  const typeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-types-"));
  const args = [
    typeScriptCli,
    "--noEmit",
    "--allowJs",
    "--checkJs",
    "--noImplicitAny",
    "false",
    "--target",
    "ES2022",
    "--module",
    "ESNext",
    "--moduleResolution",
    "Bundler",
    "--lib",
    "ES2022,DOM,DOM.Iterable",
    "--skipLibCheck",
    "--typeRoots",
    typeRoot,
    ...authoredScripts,
  ];
  let result: { stdout?: string; stderr?: string };
  let processError: unknown;
  try {
    result = await execFileAsync(process.execPath, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    processError = error;
    result = error as { stdout?: string; stderr?: string };
  } finally {
    await fs.rm(typeRoot, { recursive: true, force: true });
  }
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const significant = raw
    .split("\n")
    .filter(
      (line) =>
        !isUnresolvedExternalImport(line) &&
        !isVendoredClientDiagnostic(line) &&
        !isDomBaseTypeDiagnostic(line),
    )
    .join("\n")
    .trim();
  if (significant) throw new Error(`JavaScript type-check error:\n${significant}`);
  if (processError && !raw) throw new Error(`JavaScript type-checker failed: ${String(processError)}`);
  await validateElementIds(root, authoredScripts);
}

/** Matches TS2307 lines for bare package imports (`three`), not relative paths (`./foo`). */
function isUnresolvedExternalImport(line: string): boolean {
  const match = line.match(/error TS2307: Cannot find module '([^']+)'/);
  return match !== null && !/^[./]/.test(match[1]);
}

/**
 * Diagnostics from the vendored relay client. It is excluded from the tsc input
 * list above, but tsc still follows relative imports into it — without this
 * filter, harness-owned code could fail a game's turn. Its syntax is already
 * covered by the node --check pass, which includes it.
 */
function isVendoredClientDiagnostic(line: string): boolean {
  return /[\\/]js[\\/]threadsite-net\.js\(/.test(line);
}

/**
 * TS2339 diagnostics whose receiver is a DOM base type. `querySelector`,
 * `event.target`, and Node-family traversal return these, so members that live
 * only on HTMLElement or the form controls (`dataset`, `style`, `value`) flag
 * as errors even though the browser resolves them dynamically on the matched
 * element — narrowing would just force casts into generated code. Property
 * typos on these receivers are indistinguishable from that pattern and pass
 * too; validateElementIds remains the guard for missing elements.
 */
function isDomBaseTypeDiagnostic(line: string): boolean {
  return /error TS2339: Property '[^']+' does not exist on type '(?:Element|HTMLElement|SVGElement|EventTarget|Node|ChildNode)'\.$/
    .test(line);
}

/**
 * Verify that every literal ID looked up in authored JS actually exists somewhere
 * in the site. This replaces strict-null-check enforcement of DOM lookups: a
 * typo'd ID is the real bug class, and this catches it with zero noise. IDs are
 * collected from static HTML, JS markup strings (innerHTML templates), `.id`
 * assignments, and setAttribute("id", ...) so dynamically created elements are
 * recognized. Computed (non-literal) lookup arguments can't be checked and are
 * skipped.
 */
async function validateElementIds(root: string, scripts: string[]): Promise<void> {
  const knownIds = new Set<string>();
  const lookups: { file: string; id: string }[] = [];

  const htmlFiles: string[] = [];
  async function walkHtml(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const absolute = safeChild(dir, entry.name);
      if (entry.isDirectory()) await walkHtml(absolute);
      else if (/\.x?html?$/i.test(entry.name)) htmlFiles.push(absolute);
    }
  }
  await walkHtml(root);
  for (const html of htmlFiles) {
    for (const id of extractHtmlIds(await fs.readFile(html, "utf8"))) knownIds.add(id);
  }

  for (const script of scripts) {
    const source = await fs.readFile(script, "utf8");
    for (const id of extractDynamicIds(source)) knownIds.add(id);
    const rel = path.relative(root, script).replaceAll(path.sep, "/");
    for (const id of extractLiteralLookupIds(source)) lookups.push({ file: rel, id });
  }

  const missing = lookups.filter(({ id }) => !knownIds.has(id));
  if (missing.length) {
    const lines = missing.map(({ file, id }) => `- js/${file}: getElementById/querySelector references missing id "${id}"`);
    throw new Error(
      `JavaScript type-check error:\nElement ID mismatch: some DOM lookups reference ids that do not exist in the site HTML or are never created by the JS. Fix the id names in the JS or add the elements to the HTML.\n${lines.join("\n")}`,
    );
  }
}

/** All id="..." attribute values in an HTML document (double- or single-quoted). */
function extractHtmlIds(html: string): string[] {
  return [...html.matchAll(/\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map((m) => m[1] ?? m[2] ?? "")
    .filter(Boolean);
}

/** IDs created at runtime by the JS itself: markup strings, `.id =`, setAttribute("id", ...). */
function extractDynamicIds(source: string): string[] {
  const ids: string[] = [];
  // id="..." inside any JS string or template literal (innerHTML/insertAdjacentHTML payloads)
  for (const m of source.matchAll(/\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) ids.push(m[1] ?? m[2] ?? "");
  // .id = 'value' / .id = "value"
  for (const m of source.matchAll(/\.id\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) ids.push(m[1] ?? m[2] ?? "");
  // setAttribute("id", "value")
  for (const m of source.matchAll(/setAttribute\(\s*["']id["']\s*,\s*(?:"([^"]*)"|'([^']*)')\s*\)/g)) {
    ids.push(m[1] ?? m[2] ?? "");
  }
  return ids.filter(Boolean);
}

/** Literal argument IDs from getElementById("x") and querySelector("#x"). */
function extractLiteralLookupIds(source: string): string[] {
  const ids: string[] = [];
  for (const m of source.matchAll(/getElementById\(\s*(?:"([^"]+)"|'([^']+)')\s*\)/g)) ids.push(m[1] ?? m[2] ?? "");
  for (const m of source.matchAll(/querySelector\(\s*["']#([A-Za-z][\w-]*)["']\s*\)/g)) ids.push(m[1] ?? "");
  return ids;
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
