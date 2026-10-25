import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

process.env.DISCORD_BOT_TOKEN = "test";
process.env.DISCORD_APPLICATION_ID = "test";
const { captureWorkingTreeSnapshot, workingTreeStats } = await import("../src/git.js");
const exec = promisify(execFile);

async function trackedWorkspace(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-stats-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(path.join(workspace, "site", "css"), { recursive: true });
  await exec("git", ["init", "-b", "main"], { cwd: workspace });
  await exec("git", ["config", "user.name", "Test"], { cwd: workspace });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
  await fs.writeFile(path.join(workspace, "site", "index.html"), "<html>\n<body>\n<p>hello</p>\n</body>\n</html>\n");
  await fs.writeFile(path.join(workspace, "site", "css", "old.css"), "a {\n  color: red;\n}\n\n");
  await exec("git", ["add", "-A"], { cwd: workspace });
  await exec("git", ["commit", "-m", "baseline"], { cwd: workspace });
  return workspace;
}

test("per-file line counts and binary markers come from real diffs", async (t) => {
  const workspace = await trackedWorkspace(t);
  const baseline = await captureWorkingTreeSnapshot(workspace);
  await fs.writeFile(path.join(workspace, "site", "index.html"), "<html>\n<body>\n<h1>Title</h1>\n<p>hello</p>\n<p>new</p>\n</body>\n</html>\n");
  await fs.mkdir(path.join(workspace, "site", "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "site", "src", "main.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\n");
  await fs.mkdir(path.join(workspace, "site", "assets"), { recursive: true });
  await fs.writeFile(path.join(workspace, "site", "assets", "font.woff2"), Buffer.from([0x00, 0x01, 0x02, 0x0a, 0x00]));
  await fs.rm(path.join(workspace, "site", "css", "old.css"));

  const stats = await workingTreeStats(workspace, baseline);
  assert.deepEqual(stats.paths, ["site/assets/font.woff2", "site/css/old.css", "site/index.html", "site/src/main.ts"]);
  const byPath = new Map(stats.entries!.map((entry) => [entry.path, entry]));
  assert.deepEqual(byPath.get("site/src/main.ts"), { path: "site/src/main.ts", additions: 5 });
  assert.deepEqual(byPath.get("site/index.html"), { path: "site/index.html", additions: 2, deletions: 0 });
  assert.deepEqual(byPath.get("site/css/old.css"), { path: "site/css/old.css", additions: 0, deletions: 4 });
  assert.deepEqual(byPath.get("site/assets/font.woff2"), { path: "site/assets/font.woff2", binary: true });
  assert.equal(stats.files, 4);
});

test("a turn resuming on a failed turn's preserved edits counts only its own lines per file", async (t) => {
  const workspace = await trackedWorkspace(t);
  const firstBaseline = await captureWorkingTreeSnapshot(workspace);
  await fs.writeFile(path.join(workspace, "site", "index.html"), "<html>\n<body>\n<h1>Title</h1>\n<p>hello</p>\n</body>\n</html>\n");
  const first = await workingTreeStats(workspace, firstBaseline);
  assert.equal(first.entries!.length, 1);
  assert.deepEqual(first.entries![0], { path: "site/index.html", additions: 1, deletions: 0 });

  // The failed turn's edits stay in the tree, so the next baseline includes them.
  const secondBaseline = await captureWorkingTreeSnapshot(workspace);
  await fs.writeFile(path.join(workspace, "site", "index.html"), "<html>\n<body>\n<h1>Title</h1>\n<p>hello</p>\n<p>new</p>\n</body>\n</html>\n");
  const second = await workingTreeStats(workspace, secondBaseline);
  assert.deepEqual(second.entries, [{ path: "site/index.html", additions: 1, deletions: 0 }]);
});
