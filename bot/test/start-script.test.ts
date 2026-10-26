import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const bash = process.platform === "win32" ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe") : "bash";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-start-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  for (const file of ["start.sh", "scripts/deploy.sh", "scripts/lib.sh"]) {
    await fs.writeFile(path.join(root, file), (await fs.readFile(new URL(`../../${file}`, import.meta.url), "utf8")).replaceAll("\r\n", "\n"), { mode: 0o755 });
  }
  await fs.writeFile(path.join(root, ".env"), "# isolated test\n");
  await fs.mkdir(path.join(root, "bin"));
  await fs.writeFile(path.join(root, "bin", "docker"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$PWD/calls.log"
case "$*" in
  'compose ps --status running -q bot') [[ "\${TEST_RUNNING:-1}" == 1 ]] && echo bot-id; exit 0 ;;
  'compose ps -q') echo running; exit 0 ;;
  inspect*) echo running; exit 0 ;;
  'image prune -f') exit 0 ;;
  *'dist/maintenance.js list'*) [[ "\${TEST_FAIL_LIST:-0}" == 1 ]] && exit 17; printf '123\\tgame-3d\\tready\\tTest Game\\tsite-test-game\\n'; exit 0 ;;
  *'dist/maintenance.js'*'--apply'*) [[ "\${TEST_FAIL_APPLY:-0}" == 1 ]] && exit 42; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
  // The update path runs deploy.sh before starting; a static git stands in for
  // a checkout already at origin/main so the deployment is a no-op. Writing an
  // "origin-short" file moves origin/main ahead and "diff-out" feeds the
  // old..new file list, so a test can simulate pulling new commits.
  await fs.writeFile(path.join(root, "bin", "git"), `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >> "$PWD/git-calls.log"
case "$*" in
  'rev-parse --git-dir') echo .git; exit 0 ;;
  'remote get-url origin') echo https://example.invalid/threadsite.git; exit 0 ;;
  'status --porcelain --untracked-files=no') exit 0 ;;
  fetch*) exit 0 ;;
  checkout*) exit 0 ;;
  'branch --set-upstream-to='*) exit 0 ;;
  for-each-ref*) exit 0 ;;
  log*) exit 0 ;;
  'rev-parse --verify origin/main') echo 1111111111111111111111111111111111111111; exit 0 ;;
  'rev-parse --short origin/main') cat "$PWD/origin-short" 2>/dev/null || echo 1111111; exit 0 ;;
  'rev-parse --short HEAD') echo 1111111; exit 0 ;;
  'rev-parse HEAD') echo 1111111111111111111111111111111111111111; exit 0 ;;
  diff*) [[ -f "$PWD/diff-out" ]] && cat "$PWD/diff-out"; exit 0 ;;
esac
exit 1
`, { mode: 0o755 });
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => exec(bash, ["-c", 'export PATH="$PWD/bin:$PATH"; bash ./start.sh "$@"', "test", ...args], {
    cwd: root, env: { ...process.env, ...env },
  });
  const calls = () => fs.readFile(path.join(root, "calls.log"), "utf8");
  return { root, run, calls };
}

test("start lists games and previews removal without updating Git or stopping services", async (t) => {
  const f = await fixture(t);
  await f.run(["games"]);
  await f.run(["remove", "--thread", "123"]);
  const calls = await f.calls();
  assert.match(calls, /maintenance.js list --kind games/);
  assert.match(calls, /maintenance.js remove --thread 123/);
  assert.doesNotMatch(calls, /compose stop|compose up/);
});

test("start restores a running bot after cleanup failure and propagates the error", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run(["forget", "--repo", "old", "--apply"], { TEST_FAIL_APPLY: "1" }), (error: any) => error.code === 42);
  const calls = await f.calls();
  assert.match(calls, /compose stop bot/);
  assert.match(calls, /maintenance.js forget --repo old --apply/);
  assert.match(calls, /compose up -d --no-deps bot/);
  assert.ok(calls.indexOf("compose stop bot") < calls.indexOf("--apply"));
});

test("cleanup leaves a previously stopped bot stopped", async (t) => {
  const f = await fixture(t);
  await f.run(["remove", "--thread", "123", "--apply"], { TEST_RUNNING: "0" });
  assert.doesNotMatch(await f.calls(), /compose stop|compose up/);
});

test("an unchanged tree starts buildless after the first build stamps it", async (t) => {
  const f = await fixture(t);
  await f.run(["up"]);
  await f.run(["up"]);
  const calls = await f.calls();
  // First start: no stamp yet, so builds are checked and dangling images from
  // the retag are pruned; second start: the stamp matches, so nothing rebuilds.
  assert.equal(calls.match(/^compose up -d --build --remove-orphans$/gm)?.length, 1);
  assert.equal(calls.match(/^compose up -d --remove-orphans$/gm)?.length, 1);
  assert.equal(calls.match(/^image prune -f$/gm)?.length, 1);
  assert.ok(calls.indexOf("compose up -d --remove-orphans") > calls.indexOf("compose up -d --build --remove-orphans"), "the buildless start comes after the stamped one");
  const gitCalls = await fs.readFile(path.join(f.root, "git-calls.log"), "utf8");
  assert.match(gitCalls, /fetch origin/, "the update path really ran deploy.sh");
  await fs.access(path.join(f.root, "data", ".image-build-stamp"));
});

test("--no-update always checks builds even when a stamp says nothing changed", async (t) => {
  const f = await fixture(t);
  await f.run(["up", "--no-update"]);
  await f.run(["up", "--no-update"]);
  const calls = await f.calls();
  // Local edits are invisible to the stamp's commit digest, so this path must
  // never trust it — every start re-checks builds through the layer cache.
  assert.equal(calls.match(/^compose up -d --build --remove-orphans$/gm)?.length, 2);
  assert.doesNotMatch(calls, /^compose up -d --remove-orphans$/m);
  const gitCalls = await fs.readFile(path.join(f.root, "git-calls.log"), "utf8").catch(() => "");
  assert.doesNotMatch(gitCalls, /fetch origin/, "deploy.sh is skipped entirely");
});

// Pulls new commits between the two starts: the update itself must build the
// changed service inside deploy.sh, re-stamp, and leave start.sh buildless.
async function updatedFixture(t: { after(fn: () => Promise<void>): void }, diff: string) {
  const f = await fixture(t);
  await f.run(["up"]);
  await fs.writeFile(path.join(f.root, "origin-short"), "2222222\n");
  await fs.writeFile(path.join(f.root, "diff-out"), diff);
  await f.run(["up"]);
  return f;
}

test("an update builds the changed service in deploy.sh and start.sh stays buildless", async (t) => {
  const f = await updatedFixture(t, "bot/src/index.ts\n");
  const calls = await f.calls();
  assert.match(calls, /^compose build bot$/m, "deploy.sh rebuilt the changed service");
  assert.match(calls, /^compose up -d bot$/m, "deploy.sh recreated the changed service");
  assert.equal(calls.match(/^compose up -d --build --remove-orphans$/gm)?.length, 1, "only the first start full-builds");
  assert.match(calls, /^compose up -d --remove-orphans$/m, "the start after the update is buildless");
  assert.ok(
    calls.lastIndexOf("compose up -d --build --remove-orphans") < calls.indexOf("compose build bot"),
    "the full build precedes the update",
  );
});

test("a stale stamp after a manual pull still reconciles with a full build", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "data"), { recursive: true });
  await fs.writeFile(path.join(f.root, "data", ".image-build-stamp"), "not-the-real-digest\n");
  await fs.writeFile(path.join(f.root, "origin-short"), "2222222\n");
  await fs.writeFile(path.join(f.root, "diff-out"), "bot/src/index.ts\n");
  await f.run(["up"]);
  const calls = await f.calls();
  assert.match(calls, /^compose build bot$/m, "deploy.sh still rebuilds the changed service");
  assert.match(calls, /^compose up -d --build --remove-orphans$/m, "start.sh reconciles every image");
  assert.notEqual(
    await fs.readFile(path.join(f.root, "data", ".image-build-stamp"), "utf8"),
    "not-the-real-digest\n",
    "the reconciling build re-stamped",
  );
});

test("a docker-compose.yml change rebuilds every service", async (t) => {
  const f = await updatedFixture(t, "docker-compose.yml\n");
  const calls = await f.calls();
  assert.match(calls, /^compose build bot opencode gameserver preview$/m);
  assert.match(calls, /^compose up -d bot opencode gameserver preview$/m);
});

test("an update without service code changes stays buildless", async (t) => {
  const f = await updatedFixture(t, "README.md\n");
  const calls = await f.calls();
  assert.doesNotMatch(calls, /^compose build /m, "nothing rebuilds");
  assert.equal(calls.match(/^compose up -d --build --remove-orphans$/gm)?.length, 1, "only the first start builds");
  assert.equal(calls.match(/^compose up -d --remove-orphans$/gm)?.length, 1, "the start after the update is buildless");
});
