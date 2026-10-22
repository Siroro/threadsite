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
  await fs.writeFile(path.join(root, "start.sh"), (await fs.readFile(new URL("../../start.sh", import.meta.url), "utf8")).replaceAll("\r\n", "\n"));
  await fs.writeFile(path.join(root, ".env"), "# isolated test\n");
  await fs.mkdir(path.join(root, "bin"));
  await fs.writeFile(path.join(root, "bin", "docker"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$PWD/calls.log"
case "$*" in
  'compose ps --status running -q bot') [[ "\${TEST_RUNNING:-1}" == 1 ]] && echo bot-id; exit 0 ;;
  *'dist/maintenance.js list'*) [[ "\${TEST_FAIL_LIST:-0}" == 1 ]] && exit 17; printf '123\\tgame-3d\\tready\\tTest Game\\tsite-test-game\\n'; exit 0 ;;
  *'dist/maintenance.js'*'--apply'*) [[ "\${TEST_FAIL_APPLY:-0}" == 1 ]] && exit 42; exit 0 ;;
esac
exit 0
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
