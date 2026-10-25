import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import { engineTypeEntries } from "./engines.js";
import { currentHead } from "./git.js";
import { log } from "./logger.js";
import { parseProjectDescription, parseProjectChangelog } from "./project-docs.js";
import { renderGallery } from "./gallery.js";
import { publicGalleryUrl, type GalleryProject } from "./gallery-model.js";
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

/**
 * The deploy-identity file written into every published site root. Pages carry
 * an injected loader (see injectUpdateChecker) that polls it; a changed
 * `version` means a newer deploy is live and the page reloads itself. The name
 * is reserved by the harness — a same-named workspace file is overwritten on
 * publish.
 */
export const VERSION_FILE = "threadsite-version.json";

export async function validateSite(siteDir: string): Promise<SiteStats> {
  const root = path.resolve(siteDir);
  const index = safeChild(root, "index.html");
  const indexStat = await fs.lstat(index).catch(() => undefined);
  if (!indexStat?.isFile()) throw new Error("Generated site must contain site/index.html");

  let files = 0;
  let bytes = 0;
  const scripts: string[] = [];
  const tsSources: string[] = [];

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
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      if (extension === ".js" || extension === ".mjs") scripts.push(absolute);
      if (/\.d\.[cm]?ts$/.test(entry.name)) {
        // Declaration files carry no runnable code (the harness-owned net
        // client's types live under site/net/), so they may sit anywhere.
        if (relative.startsWith("src/")) tsSources.push(absolute);
      } else if (extension === ".ts" || extension === ".mts") {
        // Only the site/src/ tree is compiled and bundled; TypeScript anywhere
        // else (js/, css/, assets/, page folders) would ship as dead weight
        // that no browser executes. Repairable, so it rides the type-check
        // error channel into the one-shot repair round-trip.
        if (!relative.startsWith("src/")) {
          throw new Error(`JavaScript type-check error: TypeScript file site/${relative} is outside site/src/, and only the src/ tree is compiled. Move it below site/src/.`);
        }
        tsSources.push(absolute);
      }
      if (/\.(?:tsx|cts|jsx)$/.test(extension)) {
        throw new Error(`JavaScript type-check error: site/${relative} uses unsupported script type '${extension}'; write plain TypeScript (.ts) under site/src/.`);
      }
      files += 1;
      bytes += stat.size;
      if (files > config.maxSiteFiles) throw new Error(`Site exceeds MAX_SITE_FILES (${config.maxSiteFiles})`);
      if (bytes > config.maxSiteBytes) throw new Error(`Site exceeds MAX_SITE_BYTES (${config.maxSiteBytes})`);
    }
  }

  await walk(root);
  if (!tsSources.length && scripts.some((file) => path.relative(root, file).replaceAll(path.sep, "/").startsWith("js/"))) {
    throw new Error("JavaScript type-check error: site/js/ requires TypeScript source under site/src/.");
  }
  await validateScriptSyntax(root, scripts);
  await validateInlineScripts(root);
  await validateAssetReferences(root);
  await validateModuleResolution(root);
  if (tsSources.length) await validateTypeScriptSources(root, tsSources, scripts);
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
  for (const html of await listFiles(root, /\.html?$/i)) {
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
  for (const html of await listFiles(root, /\.html?$/i)) {
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
      if (reference.kind === "<script src>" && /\.(?:ts|mts)$/i.test(url.split("#")[0].split("?")[0])) {
        throw new Error(`Broken local reference in ${rel}: ${reference.kind} "${url}" points at TypeScript source, which browsers cannot execute; reference the compiled bundle (js/<name>.js) instead.`);
      }
      if (url.startsWith("/")) {
        if (reference.enforceRelative) {
          throw new Error(`Broken local reference in ${rel}: ${reference.kind} "${url}" is a site-root-absolute path, but the site is served under a path prefix; use a relative URL.`);
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

/**
 * Runtime-resolved module references the tag-level checks cannot see: import
 * map targets and the relative imports of inline module scripts — and,
 * transitively, every local file those load. A split browser library (e.g.
 * three.js's ESM wrapper re-exporting a sibling core build) 404s only when the
 * browser executes its internal `import "./sibling.js"`, so an agent that
 * vendors just the wrapper ships a broken site through every other check.
 * This pass resolves the chain at validation time and fails the turn naming
 * the missing file, so the fix lands in the same turn instead of as a live
 * 404. Bundled js/ output needs no scanning — the bundler already proved its
 * own graph — but files reached from an import map or inline script are
 * followed regardless of where they live.
 */
async function validateModuleResolution(root: string): Promise<void> {
  for (const html of await listFiles(root, /\.html?$/i)) {
    const rel = `site/${path.relative(root, html).replaceAll(path.sep, "/")}`;
    const source = await fs.readFile(html, "utf8");
    const queue: Array<{ from: string; kind: string; specifier: string }> = [];
    for (const [, attrs = "", body = ""] of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const type = tagAttr(attrs, "type").toLowerCase();
      const src = tagAttr(attrs, "src");
      if (type === "importmap") {
        let map: { imports?: Record<string, unknown>; scopes?: Record<string, Record<string, unknown>> };
        try {
          map = JSON.parse(body) as typeof map;
        } catch {
          continue; // malformed import maps already fail the inline JSON check
        }
        const values = [
          ...Object.values(map.imports ?? {}),
          ...Object.values(map.scopes ?? {}).flatMap((scope) => Object.values(scope ?? {})),
        ];
        for (const value of values) {
          if (typeof value !== "string") continue;
          const clean = value.trim().split("#")[0].split("?")[0];
          // Prefix mappings end in "/"; remote/absolute/data targets resolve
          // elsewhere (or cannot be checked) — only same-site relative ones.
          if (!clean || clean.endsWith("/") || !clean.startsWith(".") || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value.trim())) continue;
          queue.push({ from: html, kind: `import map target "${value.trim()}"`, specifier: clean });
        }
      } else if (type === "module") {
        // Inline modules resolve their specifiers against this HTML file;
        // src'd modules (bundled output is self-consistent by construction)
        // get their import chain followed.
        if (src) {
          const clean = src.trim().split("#")[0].split("?")[0];
          if (clean && clean.startsWith(".") && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src.trim())) {
            queue.push({ from: html, kind: `module script "${src.trim()}"`, specifier: clean });
          }
        } else {
          for (const specifier of staticRelativeImports(body)) {
            queue.push({ from: html, kind: `inline module import "${specifier}"`, specifier });
          }
        }
      }
    }
    if (!queue.length) continue;

    const visited = new Set<string>();
    while (queue.length) {
      const item = queue.shift()!;
      const resolved = resolveLocalSpecifier(item.from, item.specifier);
      if (resolved === undefined) continue;
      const relative = path.relative(root, resolved).replaceAll(path.sep, "/");
      const via = path.relative(root, item.from).replaceAll(path.sep, "/") || "index.html";
      if (!resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(
          `Broken local reference in ${rel}: ${item.kind}, loaded from site/${via}, resolves to site/${relative}, which is outside the site directory and never published (workspace files such as node_modules/). Import the engine from site/src/ TypeScript so it is bundled, or move the referenced file under site/.`,
        );
      }
      if (!await fs.access(resolved).then(() => true, () => false)) {
        throw new Error(
          `Broken local reference in ${rel}: ${item.kind}, loaded from site/${via}, resolves to missing file site/${relative}. If this is a split library (an ESM wrapper re-exporting sibling builds), vendor every file it imports, or import the harness-vendored copy instead.`,
        );
      }
      if (visited.has(resolved) || visited.size > 200) continue;
      visited.add(resolved);
      if (/\.(?:m?js)$/i.test(resolved)) {
        const code = await fs.readFile(resolved, "utf8").catch(() => "");
        for (const specifier of staticRelativeImports(code)) {
          queue.push({ from: resolved, kind: `import "${specifier}" (via site/${relative})`, specifier });
        }
      }
    }
  }
}

/**
 * Relative module specifiers in JavaScript/TypeScript source: `from "…"`,
 * side-effect/dynamic `import "…"` / `import("…")`. Remote, bare, data, and
 * absolute specifiers are left alone — they resolve through other means
 * (import maps, CDNs) or are not checkable.
 */
function staticRelativeImports(code: string): string[] {
  const out: string[] = [];
  for (const [, quote = "", specifier = ""] of code.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*(["'])([^"'\n]+)\1/g)) {
    void quote;
    if (specifier.startsWith(".")) out.push(specifier);
  }
  return out;
}

/** Resolve a relative specifier against its importing file, contained to site/. */
function resolveLocalSpecifier(fromFile: string, specifier: string): string | undefined {
  const clean = specifier.split("#")[0].split("?")[0];
  if (!clean.startsWith(".")) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    return undefined;
  }
  return path.resolve(path.dirname(fromFile), decoded);
}

/** Value of a quoted attribute (double or single) inside a tag's attribute string. */
function tagAttr(attrs: string, name: string): string {
  const match = attrs.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

/**
 * Type-check the authored TypeScript sources of a bundled project: a temp
 * mirror carries site/src/ verbatim and the harness-owned net files verbatim
 * (real types for call sites, never inputs); the harness-seeded engine
 * packages contribute their REAL declarations through absolute tsconfig
 * `paths`, and hand-downloaded vendored files under assets/ become any-typed
 * stubs with their real export names. tsc runs from a tsconfig in the mirror
 * with implicit-any and DOM lookup lenience; the bundled
 * site/js/ output is not checked here (it is compiler output and already
 * covered by node --check).
 */
async function validateTypeScriptSources(root: string, tsSources: string[], scripts: string[]): Promise<void> {
  const mirrorRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-ts-"));
  try {
    const inputs: string[] = [];
    for (const absolute of tsSources) {
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      const mirrored = path.join(mirrorRoot, ...relative.split("/"));
      await fs.mkdir(path.dirname(mirrored), { recursive: true });
      await fs.writeFile(mirrored, await fs.readFile(absolute, "utf8"), "utf8");
      // Authored src/ declarations join the program: ambient declarations
      // (the harness-seeded media.d.ts, or agent-written wildcard modules)
      // only take effect as inputs, while module-shaped declarations under
      // net/ or assets/ keep resolving through their import paths.
      if (!/\.d\.[cm]?ts$/.test(relative) || relative.startsWith("src/")) inputs.push(relative);
    }

    // Harness-owned net files stay real so authored imports resolve: the
    // client's declarations give call sites the full typed API (the .js is
    // never an input; with checkJs off nothing reports from the .js itself).
    for (const name of [
      "net/threadsite-net.js", "net/threadsite-net.d.ts",
      "net/net-config.js", "net/net-config.d.ts",
      "net/threadsite-player.js", "net/threadsite-player.d.ts",
      "leaderboards/threadsite-leaderboards.js", "leaderboards/threadsite-leaderboards.d.ts",
      "leaderboards/threadsite-player.js", "leaderboards/threadsite-player.d.ts",
      "leaderboards/leaderboards-config.js", "leaderboards/leaderboards-config.d.ts",
    ]) {
      const content = await fs.readFile(safeChild(root, ...name.split("/")), "utf8").catch(() => undefined);
      if (content === undefined) continue;
      const mirrored = path.join(mirrorRoot, ...name.split("/"));
      await fs.mkdir(path.dirname(mirrored), { recursive: true });
      await fs.writeFile(mirrored, content, "utf8");
    }

    // Agent-vendored libraries under assets/ become any-typed stubs with their
    // real export names for authored imports.
    for (const script of scripts) {
      const relative = path.relative(root, script).replaceAll(path.sep, "/");
      if (!isVendoredLibrary(relative)) continue;
      const mirrored = path.join(mirrorRoot, ...relative.split("/"));
      await fs.mkdir(path.dirname(mirrored), { recursive: true });
      await fs.writeFile(stubPath(mirrored), vendorStub(await fs.readFile(script, "utf8")), "utf8");
    }

    // The harness-seeded engine packages (workspace node_modules/) contribute
    // their REAL TypeScript declarations: bare "three"/"excalibur" resolve onto
    // them through tsconfig paths (absolute, pointing into the workspace — no
    // copying), so authored engine code is type-checked against the library's
    // actual API, matching what the agent's language server sees.
    const workspacePath = path.resolve(root, "..");
    const paths: Record<string, string[]> = {};
    for (const engine of engineTypeEntries(workspacePath)) {
      // Wildcard entries (three/addons/*) substitute per-import; probe the
      // directory they map onto rather than the literal star path.
      const probe = engine.declaration.endsWith("*") ? path.dirname(engine.declaration) : engine.declaration;
      if (await fs.access(probe).then(() => true, () => false)) {
        paths[engine.importName] = [engine.declaration.replaceAll(path.sep, "/")];
      }
    }

    const tsconfig = {
      compilerOptions: {
        noEmit: true,
        allowJs: true,
        checkJs: false,
        noImplicitAny: false,
        allowSyntheticDefaultImports: false,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        skipLibCheck: true,
        typeRoots: [],
        paths,
      },
      files: inputs,
    };
    await fs.writeFile(path.join(mirrorRoot, "tsconfig.json"), JSON.stringify(tsconfig), "utf8");

    if (inputs.length) {
      const typeScriptCli = path.join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
      let result: { stdout?: string; stderr?: string };
      let processError: unknown;
      try {
        result = await execFileAsync(process.execPath, [typeScriptCli, "-p", path.join(mirrorRoot, "tsconfig.json")], {
          cwd: mirrorRoot,
          timeout: 60_000,
          maxBuffer: 8 * 1024 * 1024,
        });
      } catch (error) {
        processError = error;
        result = error as { stdout?: string; stderr?: string };
      }
      const raw = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      const mirrorPosix = mirrorRoot.replaceAll(path.sep, "/");
      const significant = significantDiagnostics(raw)
        .replaceAll(`${mirrorPosix}/`, "")
        .replaceAll(`${mirrorRoot}${path.sep}`, "");
      if (significant) throw new Error(`JavaScript type-check error:\n${significant}`);
      if (processError && !raw) throw new Error(`JavaScript type-checker failed: ${String(processError)}`);
    }
  } finally {
    await fs.rm(mirrorRoot, { recursive: true, force: true });
  }
  await validateElementIds(root, tsSources);
}

/** Downloaded vendor/library files live below `assets/` per the AGENTS.md contract. */
function isVendoredLibrary(relative: string): boolean {
  return relative.startsWith("assets/");
}

/** Sibling declaration path that tsc prefers over a `.js`/`.mjs` module file. */
function stubPath(mirrored: string): string {
  return mirrored.endsWith(".mjs") ? `${mirrored.slice(0, -4)}.d.mts` : `${mirrored.slice(0, -3)}.d.ts`;
}

/**
 * A `.d.ts` stand-in for a vendored module: its real export names, parsed from
 * the source, re-declared as `any`. Namespace, named, and default imports all
 * resolve without the implementation entering the tsc program. `export … from`
 * re-exports are copied through so chunked bundles lead to their own stubs. A
 * module with no detectable ESM exports (CommonJS-style bundle) gets an
 * `export = any` shape instead. The default export is only declared when the
 * source has one, so a browser-fatal `import lib from` still fails the gate.
 */
function vendorStub(source: string): string {
  const header = "// ThreadSite vendored-module stub: exports are any; the implementation is never type-checked.";
  const names = new Set<string>();
  const reExports = new Set<string>();
  let hasDefault = /\bexport\s+default\b/.test(source);

  for (const match of source.matchAll(/\bexport\s*\{[^}]*\}\s*from\s*(["'])([^"']*)\1/g)) {
    reExports.add(match[0].trim());
  }
  for (const match of source.matchAll(/\bexport\s*\*(?:\s+as\s+\w+)?\s*from\s*(["'])([^"']*)\1/g)) {
    reExports.add(match[0].trim());
  }
  for (const [, clause = ""] of source.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const piece of clause.split(",")) {
      const item = piece.trim();
      if (!item) continue;
      const nameMatch = item.match(/^(?:(\w+)\s+as\s+)?(?:"([^"]+)"|'([^']+)'|(\w+))$/);
      if (!nameMatch) continue;
      const exported = nameMatch[4] ?? nameMatch[2] ?? nameMatch[3] ?? nameMatch[1];
      if (exported === "default") hasDefault = true;
      else if (/^[A-Za-z_$][\w$]*$/.test(exported)) names.add(exported);
    }
  }
  for (const match of source.matchAll(/\bexport\s+(?:async\s+)?(?:const|let|var|function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }

  if (!names.size && !reExports.size && !hasDefault) {
    return `${header}\ndeclare const threadsiteVendorModule: any;\nexport = threadsiteVendorModule;\n`;
  }
  const lines = [header];
  for (const name of [...names].sort()) lines.push(`export declare const ${name}: any;`);
  if (hasDefault) lines.push("declare const threadsiteVendorDefault: any;", "export default threadsiteVendorDefault;");
  lines.push(...reExports);
  return `${lines.join("\n")}\n`;
}

/**
 * tsc diagnostics can span multiple lines (indented detail under the header),
 * so filtering line-by-line would orphan those detail lines. Output is grouped
 * instead: an unindented `file(line,col): error TSxxxx:` (or global
 * `error TSxxxx:`) header opens a block, following indented lines belong to
 * it, and lenience rules drop whole blocks. The trailing `Found N errors.`
 * count is pre-filter and dropped.
 */
function significantDiagnostics(raw: string): string {
  const kept: string[] = [];
  let dropping = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s/.test(line)) {
      if (!dropping && line.trim()) kept.push(line);
    } else if (!line.trim() || /^Found \d+ errors?\b/.test(line)) {
      continue;
    } else if (/error TS\d+:/.test(line)) {
      dropping = isIgnoredDiagnostic(line);
      if (!dropping) kept.push(line);
    } else {
      dropping = false;
      kept.push(line);
    }
  }
  return kept.join("\n").trim();
}

function isIgnoredDiagnostic(header: string): boolean {
  return (
    isVendoredFileDiagnostic(header) ||
    isDomBaseTypeDiagnostic(header)
  );
}

/**
 * Diagnostics from vendored files: the relay client (kept real in the mirror
 * for authored call-site types, but never an input — it lives in site/net/
 * with its declarations) and, as defense in depth, anything under `assets/` —
 * the stubs normally keep vendored implementations out of the tsc program
 * entirely. Its syntax is already covered by the `node --check` pass, which
 * includes it.
 */
function isVendoredFileDiagnostic(line: string): boolean {
  return /(?:^|[\\/])(?:assets[\\/][^(]*|net[\\/]threadsite-net\.js)\(/.test(line);
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
    const lines = missing.map(({ file, id }) => `- ${file}: getElementById/querySelector references missing id "${id}"`);
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
  // Apache receives runtime files only. Authored TypeScript and the unbundled
  // harness net client are build inputs; esbuild has already folded them into
  // the minified site/js bundles.
  try {
    await fs.cp(siteDir, staging, {
      recursive: true,
      dereference: false,
      force: true,
      filter: (source) => {
        const relative = path.relative(siteDir, source);
        if (!relative) return true;
        const root = relative.split(path.sep)[0];
        return root !== "src" && root !== "net" && root !== "leaderboards";
      },
    });
    await stampDeployVersion(staging, await workspaceCommit(siteDir));
    await versionAssetReferences(staging);
  } catch (error) {
    // publishRoot is Apache's DocumentRoot: a leftover .staging-* tree would be
    // served (or at least sit there) forever, and dot-dirs are invisible to
    // every other sweep in this module.
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  let hadOld = false;
  try {
    await fs.rename(target, backup);
    hadOld = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  try {
    await fs.rename(staging, target);
    if (hadOld) await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (hadOld) await fs.rename(backup, target).catch(() => undefined);
    throw error;
  }
}

/**
 * Recover from a publish that died between the two renames (a crash or a
 * container stop leaves the live site missing with its content in
 * `.backup-*`), and delete staging/backup leftovers from failed publishes.
 * Runs at boot, before anything republishes.
 */
export async function recoverPublishRoot(): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(config.publishRoot);
  } catch {
    return; // publishRoot does not exist yet
  }
  const stale: Array<{ name: string; slug: string; kind: "staging" | "backup" }> = [];
  for (const name of entries) {
    const match = /^\.(staging|backup)-(.+)-[0-9a-f]{10}$/.exec(name);
    if (match) stale.push({ name, slug: match[2], kind: match[1] as "staging" | "backup" });
  }
  let restored = 0;
  let removed = 0;
  for (const entry of stale) {
    const absolute = safeChild(config.publishRoot, entry.name);
    if (entry.kind === "staging") {
      await fs.rm(absolute, { recursive: true, force: true }).catch(() => undefined);
      removed += 1;
      continue;
    }
    // A backup only matters when the live directory it belongs to is missing.
    const live = safeChild(config.publishRoot, entry.slug);
    const liveExists = await fs.access(live).then(() => true, () => false);
    if (!liveExists) {
      await fs.rename(absolute, live).catch(() => undefined);
      restored += 1;
    } else {
      await fs.rm(absolute, { recursive: true, force: true }).catch(() => undefined);
      removed += 1;
    }
  }
  if (restored || removed) log("info", "publish.stale_swept", { restored, removed });
}

/** Local asset file types whose references get versioned query strings. */
const CACHEABLE_ASSET_RE = /\.(?:css|js|mjs)$/i;

/**
 * Keep shared links (including subpages, query strings and fragments) usable
 * after a rename. The alias directory is the site's previous publish target,
 * so everything in it is replaced: HTML becomes a redirect stub and every
 * other asset (js/, css/, images) is deleted, otherwise the old URLs keep
 * serving the pre-rename site indefinitely.
 */
export async function publishSiteRedirects(aliases: readonly string[], siteSlug: string): Promise<void> {
  for (const alias of aliases) {
    if (alias === siteSlug) continue;
    const root = safeChild(config.publishRoot, alias);
    await fs.mkdir(root, { recursive: true });
    const pages = new Set(["index.html"]);
    const staleFiles: string[] = [];
    const directories: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error("Redirect directories must not contain symlinks.");
        const file = safeChild(root, path.relative(root, dir), entry.name);
        if (entry.isDirectory()) {
          directories.push(file);
          await walk(file);
        } else if (/\.html?$/i.test(entry.name)) {
          pages.add(path.relative(root, file));
        } else {
          staleFiles.push(file);
        }
      }
    }
    if ((await fs.lstat(root)).isSymbolicLink()) throw new Error("Redirect directories must not be symlinks.");
    await walk(root);
    for (const page of pages) {
      const relative = page.replaceAll(path.sep, "/").replace(/(^|\/)index\.html$/i, "$1");
      const url = `${config.publicSitesBaseUrl}/${encodeURIComponent(siteSlug)}/${relative.split("/").map(encodeURIComponent).join("/")}`;
      const literal = JSON.stringify(url).replaceAll("<", "\\u003c");
      await fs.writeFile(safeChild(root, page), `<!doctype html><meta charset="utf-8"><title>Site moved</title><meta http-equiv="refresh" content="0;url=${htmlEscape(url)}"><link rel="canonical" href="${htmlEscape(url)}"><script>location.replace(${literal}+location.search+location.hash)</script><a href="${htmlEscape(url)}">Open the renamed site</a>\n`, "utf8");
    }
    for (const file of staleFiles) await fs.rm(file, { recursive: true, force: true }).catch(() => undefined);
    // Deepest first, so a directory emptied by the deletions goes away too.
    for (const dir of directories.sort((a, b) => b.length - a.length)) {
      await fs.rmdir(dir).catch(() => undefined);
    }
    await fs.writeFile(path.join(root, VERSION_FILE), JSON.stringify({ version: `redirect-${siteSlug}` }), "utf8");
  }
}

/**
 * Deploy identity for the update check: a digest over the staged tree's
 * relative paths and file contents, computed BEFORE any rewriting so the id is
 * a pure function of the workspace's site/ tree. Republishing an unchanged
 * site yields the same id (no spurious reloads), and any content change — a
 * new turn, a repair, a restamped net-config — yields a different one. The
 * file also records the source git commit, so a live browser can be traced to
 * the exact Forgejo commit it was deployed from.
 */
async function stampDeployVersion(stagingRoot: string, sourceCommit: string | null): Promise<string> {
  const hash = crypto.createHash("sha256");
  for (const file of (await listFiles(stagingRoot, /.*/)).sort()) {
    hash.update(`${path.relative(stagingRoot, file).replaceAll(path.sep, "/")}\0`);
    hash.update(await fs.readFile(file));
    hash.update("\0");
  }
  const version = hash.digest("hex").slice(0, 12);
  await fs.writeFile(
    path.join(stagingRoot, VERSION_FILE),
    `${JSON.stringify({ version, commit: sourceCommit, publishedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  await injectUpdateChecker(stagingRoot, version);
  return version;
}

/**
 * HEAD commit of the git repo the site directory lives in (the workspace repo
 * mirrored to Forgejo), or null when there is none — observability only; a
 * missing repo must never block a publish. Routed through bot/src/git.ts like
 * every generated-workspace Git operation, so a missing project repository is
 * refused instead of silently resolving a parent repository's HEAD.
 */
async function workspaceCommit(siteDir: string): Promise<string | null> {
  try {
    return await currentHead(path.dirname(siteDir));
  } catch {
    return null;
  }
}

/**
 * Append the self-update loader to every published HTML page (the workspace
 * source stays untouched — this runs on the staging copy, after validation, so
 * generated code never sees or maintains it). The loader knows its own
 * deploy id and the relative URL of the site root's version file (pages may
 * sit in subdirectories, so the prefix is computed per page). It re-fetches
 * the version file periodically and on tab focus/visibility — never before
 * load, so the check does not compete with the game's own startup fetches —
 * and when the live deploy id differs, reloads the page: hidden tabs reload
 * immediately so the player comes back to the new version, visible tabs get a
 * one-second notice first so a mid-game reload is never mistaken for a crash.
 * Multiplayer games simply rejoin their room through the vendored client's
 * normal connect flow, exactly like a manual refresh.
 */
/**
 * Matches any previously injected update-checker script block (the loader's
 * `var DEPLOYED` assignment is its unique anchor). Republishing a tree that
 * already carries a loader — e.g. rename recovery publishing the previously
 * live site — must replace it, not append a second copy: two loaders stamped
 * with different deploy ids against one version file reload the page forever.
 * Recreated per use because the regex is global.
 */
function deployedSnippetRe(): RegExp {
  return /<script>(?:(?!<\/script>)[\s\S])*?var DEPLOYED = "[0-9a-f]+";(?:(?!<\/script>)[\s\S])*?<\/script>/gi;
}

export async function injectUpdateChecker(stagingRoot: string, version: string): Promise<void> {
  for (const html of await listFiles(stagingRoot, /\.html?$/i)) {
    const source = await fs.readFile(html, "utf8");
    // Relative hops from this page's directory up to the site root.
    const up = path.relative(path.dirname(html), stagingRoot).replaceAll(path.sep, "/");
    const versionUrl = `${up ? `${up}/` : "./"}${VERSION_FILE}`;
    const snippet = updateCheckerSnippet(version, versionUrl);
    // Idempotent: every existing loader collapses into one stamped with this
    // deploy's id (also repairing pages that carry two from an older bug). A
    // replacer function keeps `$` sequences in the snippet literal.
    let loaders = 0;
    const replaced = source.replace(deployedSnippetRe(), () => (loaders++ === 0 ? snippet : ""));
    let updated: string;
    if (replaced !== source) {
      updated = replaced;
    } else {
      // Insert before the LAST </body>: an earlier literal (e.g. inside an
      // inline script's markup string) must not swallow the injection.
      let insertAt = -1;
      for (const match of source.matchAll(/<\/body>/gi)) insertAt = match.index ?? insertAt;
      updated = insertAt >= 0
        ? `${source.slice(0, insertAt)}${snippet}${source.slice(insertAt)}`
        : `${source}${snippet}`;
    }
    if (updated !== source) await fs.writeFile(html, updated, "utf8");
  }
}

/** The injected loader: a classic inline <script>, stamped for one deploy. */
function updateCheckerSnippet(version: string, versionUrl: string): string {
  return `<script>
(function () {
  "use strict";
  var DEPLOYED = ${JSON.stringify(version)};
  var VERSION_URL = ${JSON.stringify(versionUrl)};
  var CHECK_MS = 30000;
  var overlay = null;
  var checking = false;
  function adoptNewVersion() {
    if (document.hidden) { location.reload(); return; }
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.setAttribute("style", "position:fixed;right:16px;bottom:16px;z-index:2147483647;background:rgba(17,17,17,.92);color:#eee;font:13px/1.5 system-ui,ui-sans-serif,sans-serif;padding:10px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:none");
      overlay.textContent = "New version available, updating…";
      (document.body || document.documentElement).appendChild(overlay);
      setTimeout(function () { location.reload(); }, 1200);
    }
  }
  function check() {
    if (checking) return;
    checking = true;
    fetch(VERSION_URL, { cache: "no-store" })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (data) {
        if (data && typeof data.version === "string" && data.version !== DEPLOYED) adoptNewVersion();
      })
      .catch(function () {})
      .then(function () { checking = false; });
  }
  setInterval(check, CHECK_MS);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) check(); });
  window.addEventListener("focus", check);
  if (document.readyState === "complete") setTimeout(check, 3000);
  else window.addEventListener("load", function () { setTimeout(check, 3000); });
})();
</script>`;
}


/**
 * Relative import/export specifiers that point at cacheable assets:
 * `import "./x.js"`, `import { a } from "./x.js"`, `import("./x.mjs")`,
 * `export * from "./y.js"`. A specifier may already carry a query or fragment
 * (an authored `?v=`, or a `?v=` written by an earlier versioning pass that
 * must be updatable for the fixed point to converge). Recreated per pass
 * because the regex is global.
 */
function relativeAssetImportRe(): RegExp {
  return /((?:\bfrom|\bimport)\s*\(?\s*)(["'])(\.{1,2}\/[^"'?#]*\.(?:m?js|css)(?:[?#][^"']*)?)\2/gi;
}

/**
 * Rewrite local asset references in published HTML and JS with content-hash
 * query strings (game.js?v=a1b2c3) so a fresh deploy always busts browser/CDN
 * caches, while unchanged files keep their URLs and stay cached. Only relative
 * same-site references are touched; remote URLs and non-asset links pass
 * through untouched. ES module import specifiers inside published JS files are
 * rewritten too: index.html may load main.js?v=…, but main.js imports
 * "./game.js" verbatim, so without this a returning visitor's browser keeps
 * serving its cached game.js (and everything game.js imports) until that
 * URL's Cache-Control expires, never asking for the redeployed files.
 *
 * Hashes are computed from each file's post-rewrite bytes, so a file's version
 * always describes the exact bytes its URL serves. Because rewriting an
 * importer (embedding a dependency's new ?v=) changes the importer's own
 * content, the rewrite runs to a fixed point: one pass settles leaf files and
 * each further pass settles one more level of import depth. Cyclic import
 * graphs cannot converge, so the pass count is capped. Runs on the staging
 * copy, so the workspace source and the git history stay clean.
 */
export async function versionAssetReferences(stagingRoot: string): Promise<void> {
  const pages = await listFiles(stagingRoot, /\.html?$/i);
  const scripts = await listFiles(stagingRoot, /\.(?:js|mjs)$/i);
  const MAX_PASSES = 8;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const hashes = await hashCacheableAssets(stagingRoot);
    const version = (rawUrl: string, resolveDir: string): string | undefined => {
      const [reference, ...rest] = rawUrl.split("#");
      const hashFragment = rest.length ? `#${rest.join("#")}` : "";
      const [pathPart, ...queryRest] = reference.split("?");
      if (!CACHEABLE_ASSET_RE.test(pathPart)) return undefined;
      // Only relative references resolve against this site; absolute paths,
      // remote URLs, and protocol-relative URLs are left alone.
      if (/^(?:[a-z]+:)?\/\//i.test(pathPart) || pathPart.startsWith("/") || pathPart.startsWith("data:")) return undefined;

      const resolved = path.resolve(resolveDir, decodeURIComponent(pathPart));
      if (!resolved.startsWith(`${stagingRoot}${path.sep}`)) return undefined;
      // A reference the rewriter cannot resolve (dangling href, a "./x.js"
      // mentioned in a comment) passes through unversioned rather than failing
      // the publish.
      const hash = hashes.get(resolved);
      if (!hash) return undefined;
      // Replace (not merely add) the v parameter: a stale v from an earlier
      // pass or from authored source must never pin the URL to old bytes.
      const others = queryRest.join("?").split("&").filter((param) => param && !/^v=/i.test(param));
      return `${pathPart}?${[...others, `v=${hash}`].join("&")}${hashFragment}`;
    };

    let changed = false;
    for (const html of pages) {
      const original = await fs.readFile(html, "utf8");
      let rewritten = original.replace(
        /(\b(?:src|href)\s*=\s*)(["'])([^"']+)\2/gi,
        (match, attribute: string, quote: string, url: string) => {
          const versioned = version(url, path.dirname(html));
          return versioned ? `${attribute}${quote}${versioned}${quote}` : match;
        },
      );
      // ES module imports inside inline <script type="module"> blocks.
      rewritten = rewritten.replace(relativeAssetImportRe(), (match, prefix: string, quote: string, url: string) => {
        const versioned = version(url, path.dirname(html));
        return versioned ? `${prefix}${quote}${versioned}${quote}` : match;
      });
      if (rewritten !== original) {
        await fs.writeFile(html, rewritten, "utf8");
        changed = true;
      }
    }

    for (const script of scripts) {
      const original = await fs.readFile(script, "utf8");
      const rewritten = original.replace(relativeAssetImportRe(), (match, prefix: string, quote: string, url: string) => {
        const versioned = version(url, path.dirname(script));
        return versioned ? `${prefix}${quote}${versioned}${quote}` : match;
      });
      if (rewritten !== original) {
        await fs.writeFile(script, rewritten, "utf8");
        changed = true;
      }
    }

    if (!changed) return;
  }
  log("warn", "publish.asset_versioning_unstable", { stagingRoot, passes: MAX_PASSES });
}

/** Content hash (10 hex chars) for every non-empty cacheable asset, by absolute path. */
async function hashCacheableAssets(stagingRoot: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const file of await listFiles(stagingRoot, CACHEABLE_ASSET_RE)) {
    const content = await fs.readFile(file);
    if (content.length) hashes.set(file, crypto.createHash("sha256").update(content).digest("hex").slice(0, 10));
  }
  return hashes;
}

async function listFiles(root: string, namePattern: RegExp): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (namePattern.test(entry.name)) out.push(absolute);
    }
  }
  await walk(root);
  return out;
}

export function siteUrl(project: ProjectRecord): string {
  return `${config.publicSitesBaseUrl}/${encodeURIComponent(project.siteSlug)}/`;
}

/** Harness-owned gallery assets at the publish root; the leading underscores keep cleanup from reading them as site slugs. */
const GALLERY_DIR = "__gallery";

function galleryPreviewPath(slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) throw new Error(`Invalid gallery slug: ${slug}`);
  return safeChild(config.publishRoot, GALLERY_DIR, `${slug}.png`);
}

/** Persist the turn-end preview screenshot as the project's public gallery card image. */
export async function saveGalleryPreview(slug: string, bytes: Uint8Array): Promise<void> {
  const file = galleryPreviewPath(slug);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}

/** Best-effort move of a project's gallery card image across a rename. */
export async function moveGalleryPreview(fromSlug: string, toSlug: string): Promise<void> {
  const from = galleryPreviewPath(fromSlug);
  if (!await fs.stat(from).catch(() => undefined)) return;
  const to = galleryPreviewPath(toSlug);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
  await fs.rm(from, { force: true });
}

/** Public documents must be small regular files, never workspace symlinks. */
async function readGalleryDocument(file: string): Promise<string | undefined> {
  const stat = await fs.lstat(file).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return undefined;
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch(() => undefined);
  if (!handle) return undefined;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > 64 * 1024) return undefined;
    const content = await handle.readFile("utf8");
    return Buffer.byteLength(content) <= 64 * 1024 ? content : undefined;
  } finally { await handle.close(); }
}

let galleryPublishTail: Promise<void> = Promise.resolve();
export async function publishIndex(projects: ProjectRecord[], repoUrl: (repo: string) => string): Promise<void> {
  if (!config.publicIndexEnabled) return;
  const next = galleryPublishTail.catch(() => undefined).then(async () => {
    const candidates = await Promise.all(projects.map(async (project): Promise<GalleryProject | undefined> => {
      if (project.pendingDeletion || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(project.siteSlug)) return undefined;
      const published = safeChild(config.publishRoot, project.siteSlug);
      // A failed update must not hide a working, previously published project.
      if (project.status !== "ready") {
        if (project.status !== "error" || !(await fs.lstat(path.join(published, "index.html")).catch(() => undefined))?.isFile()) return undefined;
      }
      const url = publicGalleryUrl(siteUrl(project));
      if (!url) return undefined;
      const kind = project.projectKind === "game-2d" || project.projectKind === "game-3d" ? project.projectKind : "site";
      const [rawDescription, rawChangelog, rawVersion, hasImage] = await Promise.all([
        project.status === "ready" ? readGalleryDocument(path.join(project.workspacePath, "DESCRIPTION.md")) : undefined,
        project.status === "ready" ? readGalleryDocument(path.join(project.workspacePath, "CHANGELOG.md")) : undefined,
        readGalleryDocument(path.join(published, VERSION_FILE)),
        fs.lstat(galleryPreviewPath(project.siteSlug)).then((stat) => stat.isFile() && !stat.isSymbolicLink(), () => false),
      ]);
      const description = parseProjectDescription(rawDescription);
      const changelog = parseProjectChangelog(rawChangelog);
      const date = (value: string): string => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "1970-01-01T00:00:00.000Z";
      let updatedAt = date(project.updatedAt);
      try {
        const version = JSON.parse(rawVersion ?? "null") as { publishedAt?: string } | null;
        if (version?.publishedAt && Number.isFinite(Date.parse(version.publishedAt))) updatedAt = date(version.publishedAt);
      } catch { /* Legacy publications can lack deployment metadata. */ }
      return {
        id: crypto.createHash("sha256").update(`gallery:${project.threadId}`).digest("hex").slice(0, 20),
        name: project.displayName.slice(0, 180), kind,
        mode: kind === "site" ? null : project.multiplayerMode ?? "arena",
        url, source: publicGalleryUrl(repoUrl(project.repoName)),
        image: hasImage ? `${config.publicSitesBaseUrl}/${GALLERY_DIR}/${encodeURIComponent(project.siteSlug)}.png?v=${encodeURIComponent(updatedAt)}` : null,
        pitch: (description?.pitch ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
        play: description?.play?.slice(0, 6000) ?? "",
        changeTitle: changelog?.title?.slice(0, 160) ?? "", change: changelog?.body?.slice(0, 3000) ?? "",
        createdAt: date(project.createdAt), updatedAt,
      };
    }));
    const cards = candidates.filter((project): project is GalleryProject => Boolean(project)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const html = await renderGallery(cards);
    const tempDir = safeChild(config.publishRoot, GALLERY_DIR);
    await fs.mkdir(tempDir, { recursive: true });
    const temp = path.join(tempDir, `index-${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, html, "utf8");
      await fs.rename(temp, safeChild(config.publishRoot, "index.html"));
    } finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
  });
  galleryPublishTail = next;
  await next;
}
