import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkExpandedCommand } from "./command-policy.mjs";

test("expanded commands permit useful local cleanup and searches without external execution or traversal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-command-policy-"));
  await fs.mkdir(path.join(root, "site", "assets"), { recursive: true });
  for (const command of ["rg player site/src", "find site -type f -name '*.ts'", "rm -f site/assets/old.zip", "rm -rf scratch/experiment"]) {
    await checkExpandedCommand(command, root);
  }
  for (const command of ["rm -rf site", "rm -rf /workspace", "rm site/../AGENTS.md", "rm site/.env", "rm site/net/client.js", "rm site/js/main.js",
    "rm site/package.json", "rm site/assets/*", "rm site/assets/old.zip; git reset --hard", "rm site/assets/old.zip $(pwd)",
    "find site -exec rm {} ;", "find site -delete", "find site/../ -type f", "rg --pre node site"]) {
    await assert.rejects(checkExpandedCommand(command, root), undefined, command);
  }
  await assert.rejects(checkExpandedCommand("rm site/config.js", root, "site/net"));
  await assert.rejects(checkExpandedCommand("rm site/config.js", root, "../other-project"));
  await checkExpandedCommand("rm old.zip", root, "site/assets");
});
