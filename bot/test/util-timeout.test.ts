import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { withTimeout } from "../src/util.js";

test("settled operations release timeout handles so the process can exit", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval",
    `import { withTimeout } from './src/util.ts';
     const result = await withTimeout(Promise.reject(new Error('failed')), 60000);
     if (result !== undefined) throw new Error('unexpected result');
     console.log('settled');`,
  ], { cwd: new URL("..", import.meta.url), timeout: 5000 });
  assert.equal(stdout.trim(), "settled");
});

test("timeouts preserve successful results and settle stalled operations", async () => {
  assert.equal(await withTimeout(Promise.resolve(42), 1000), 42);
  assert.equal(await withTimeout(new Promise<never>(() => {}), 10), undefined);
});
