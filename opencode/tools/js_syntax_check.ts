import { tool } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export default tool({
  description:
    "Syntax-check JavaScript files (or whole directories) under site/ with node --check. Catches duplicate declarations, unbalanced brackets, invalid tokens, and other parse errors before the browser hits them. Takes relative paths like js/game.js or js/. Returns per-file pass/fail with the parser's error message and line number.",
  args: {
    paths: tool.schema.array(tool.schema.string().min(1)).min(1).max(20).describe("Relative paths under site/ to check: files or directories (directories are scanned for .js/.mjs files)"),
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
      } else if (/\.(js|mjs)$/i.test(target)) {
        files.push(target);
      } else {
        throw new Error(`Not a JavaScript file (.js/.mjs): ${input}`);
      }
    }
    if (!files.length) return "No JavaScript files found at the requested path(s).";

    const results: string[] = [];
    let failures = 0;
    for (const file of files.slice(0, 50)) {
      const size = (await fs.stat(file)).size;
      if (size > MAX_FILE_BYTES) {
        results.push(`⚠️ ${path.relative(root, file)} — skipped (${size} bytes exceeds ${MAX_FILE_BYTES})`);
        continue;
      }
      try {
        // "node" from PATH, never process.execPath: inside the opencode server
        // the exec path is the bun-compiled opencode binary, which rejects
        // --check and would fail every file. The image is node-based, so the
        // real node binary is always on PATH here.
        await execFileAsync("node", ["--check", file], { timeout: 10_000 });
        results.push(`✅ ${path.relative(root, file)}`);
      } catch (error) {
        failures += 1;
        results.push(`❌ ${path.relative(root, file)}\n${summarizeError(error)}`);
      }
    }
    const skipped = files.length - results.length;
    const summary = failures
      ? `${failures} of ${files.length} file(s) have syntax errors.`
      : `All ${files.length} file(s) parse cleanly.`;
    return `${summary}${skipped > 0 ? ` (${skipped} beyond the 50-file check limit were not checked.)` : ""}\n\n${results.join("\n")}`;
  },
});

async function collect(dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(absolute, out);
    else if (/\.(js|mjs)$/i.test(entry.name)) out.push(absolute);
  }
  if (out.length > 500) throw new Error("Directory scan exceeded 500 JavaScript files; check a narrower path.");
}

function summarizeError(error: unknown): string {
  // stderr first, but never render an empty message: CLIs disagree about which
  // stream carries the error, and execFile failures may only have .message.
  const detail = error as { stderr?: unknown; stdout?: unknown; message?: unknown } | null;
  const raw = typeof error === "object" && error !== null
    ? String(detail?.stderr || detail?.stdout || detail?.message || error)
    : String(error);
  // Keep the SyntaxError line and its source excerpt; drop the internal stack.
  const lines = raw.split("\n").filter((line) => line.trim() && !/^\s+at\s/.test(line));
  return lines.slice(0, 4).join("\n").trim();
}
