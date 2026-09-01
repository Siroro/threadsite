import { tool } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// Global typescript installed for the language server; overridable for dev.
const TSC_PATH = process.env.THREADSITE_TSC_PATH || "/usr/local/lib/node_modules/typescript/bin/tsc";

export default tool({
  description:
    "Type/syntax-check files (or whole directories) under site/. TypeScript (.ts/.mts) is checked with tsc (lenient browser flags; single-file mode, so unresolved imports are ignored); JavaScript (.js/.mjs) with node --check. Catches duplicate declarations, unbalanced brackets, invalid tokens, undefined names, and wrong types before the harness build or validation hits them. Takes relative paths like src/game.ts or src/. Returns per-file pass/fail with the checker's error message and line number.",
  args: {
    paths: tool.schema.array(tool.schema.string().min(1)).min(1).max(20).describe("Relative paths under site/ to check: files or directories (directories are scanned for .ts/.mts/.js/.mjs files)"),
  },
  async execute(args, context) {
    const root = path.resolve(context.directory);
    const files: string[] = [];
    for (const input of args.paths) {
      const normalized = input.trim().replaceAll("\\", "/");
      if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part.startsWith("."))) {
        throw new Error(`Path must be relative under site/ with no dot or traversal segments: ${input}`);
      }
      const target = path.resolve(root, "site", normalized.replace(/^\/?site\//i, ""));
      if (!target.startsWith(`${path.resolve(root, "site")}${path.sep}`)) throw new Error(`Path escaped site/: ${input}`);

      const stat = await fs.stat(target).catch(() => undefined);
      if (!stat) throw new Error(`Not found under site/: ${input}`);
      if (stat.isDirectory()) {
        await collect(target, files);
      } else if (/\.(?:ts|mts|js|mjs)$/i.test(target)) {
        files.push(target);
      } else {
        throw new Error(`Not a TypeScript or JavaScript file (.ts/.mts/.js/.mjs): ${input}`);
      }
    }
    if (!files.length) return "No TypeScript or JavaScript files found at the requested path(s).";

    const results: string[] = [];
    let failures = 0;
    for (const file of files.slice(0, 50)) {
      const size = (await fs.stat(file)).size;
      if (size > MAX_FILE_BYTES) {
        results.push(`⚠️ ${path.relative(root, file)} — skipped (${size} bytes exceeds ${MAX_FILE_BYTES})`);
        continue;
      }
      try {
        if (/\.(?:ts|mts)$/i.test(file)) {
          const note = await checkTypeScript(file, root);
          results.push(`✅ ${path.relative(root, file)}${note ? ` (${note})` : ""}`);
        } else {
          // "node" from PATH, never process.execPath: inside the opencode server
          // the exec path is the bun-compiled opencode binary, which rejects
          // --check and would fail every file. The image is node-based, so the
          // real node binary is always on PATH here.
          await execFileAsync("node", ["--check", file], { timeout: 10_000 });
          results.push(`✅ ${path.relative(root, file)}`);
        }
      } catch (error) {
        failures += 1;
        results.push(`❌ ${path.relative(root, file)}\n${summarizeError(error)}`);
      }
    }
    const skipped = files.length - results.length;
    const summary = failures
      ? `${failures} of ${files.length} file(s) have errors.`
      : `All ${files.length} file(s) pass.`;
    return `${summary}${skipped > 0 ? ` (${skipped} beyond the 50-file check limit were not checked.)` : ""}\n\n${results.join("\n")}`;
  },
});

/**
 * Single-file tsc advisory check mirroring the harness gate's lenient flags.
 * Unresolved imports (TS2307) are expected in this mode — siblings, the net
 * client, and vendored libraries only resolve inside a full program — so they
 * are dropped from the report; every other diagnostic is real and shown.
 * Returns a short note when errors were suppressed.
 */
async function checkTypeScript(file: string, root: string): Promise<string> {
  let result: { stdout?: string; stderr?: string };
  try {
    result = await execFileAsync("node", [
      TSC_PATH,
      "--noEmit",
      "--skipLibCheck",
      "--allowJs", "false",
      "--target", "ES2022",
      "--module", "ESNext",
      "--moduleResolution", "Bundler",
      "--lib", "ES2022,DOM,DOM.Iterable",
      "--noImplicitAny", "false",
      file,
    ], { timeout: 30_000, cwd: root });
    return "";
  } catch (error) {
    result = error as { stdout?: string; stderr?: string };
  }
  const lines = [result.stdout, result.stderr].filter(Boolean).join("\n").split(/\r?\n/).filter(Boolean);
  const kept = lines.filter((line) => !/error TS2307: Cannot find module/.test(line) && !/^Found \d+ errors?\b/.test(line) && !/^\s+at\s/.test(line));
  const dropped = lines.length - kept.length;
  if (kept.length) {
    throw new Error(kept.slice(0, 8).join("\n"));
  }
  return dropped ? `${dropped} unresolved-import notice(s) ignored (single-file mode)` : "";
}

async function collect(dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(absolute, out);
    else if (/\.(?:ts|mts|js|mjs)$/i.test(entry.name)) out.push(absolute);
  }
  if (out.length > 500) throw new Error("Directory scan exceeded 500 files; check a narrower path.");
}

function summarizeError(error: unknown): string {
  // stderr first, but never render an empty message: CLIs disagree about which
  // stream carries the error, and execFile failures may only have .message.
  const detail = error as { stderr?: unknown; stdout?: unknown; message?: unknown } | null;
  const raw = typeof error === "object" && error !== null
    ? String(detail?.stderr || detail?.stdout || detail?.message || error)
    : String(error);
  // Keep the error line and its source excerpt; drop the internal stack.
  const lines = raw.split("\n").filter((line) => line.trim() && !/^\s+at\s/.test(line));
  return lines.slice(0, 6).join("\n").trim();
}
