import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { enginePackages, stageEngineSeed } from "../src/engines.js";

/**
 * The production image stages the engine payload with dist/stage-engines.js
 * instead of pruning node_modules, so the engines.ts spec is the only
 * keep-list. These checks guard the staging contract: the staged tree must
 * hold exactly the spec entries at their `from` paths (the layout
 * ensureEnginePackages resolves against — an engines bump that outlives a
 * package layout fails here, not in the first game turn), and a spec naming
 * a missing source must fail loudly before writing anything.
 */

/** Every file under root, as POSIX-style relative paths. */
async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string, prefix: string[]): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await visit(path.join(current, entry.name), [...prefix, entry.name]);
      else files.push([...prefix, entry.name].join("/"));
    }
  }
  await visit(root, []);
  return files.sort();
}

test("engine staging produces the exact payload the seeder spec reads", async () => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-engines-"));
  try {
    const staged = await stageEngineSeed(target);
    assert.equal(new Set(staged).size, staged.length, "staged package names are deduplicated");

    const expected = new Set<string>();
    const stagedNames = new Set<string>();
    for (const kind of ["game-2d", "game-3d"] as const) {
      for (const engine of enginePackages(kind)) {
        stagedNames.add(engine.name);
        for (const file of engine.files) {
          expected.add(file.from);
          await assert.doesNotReject(
            fs.access(path.join(target, ...file.from.split("/"))),
            `${engine.name}: staged file ${file.from}`,
          );
        }
        for (const dir of engine.dirs) {
          for (const relative of await walk(path.join(process.cwd(), "node_modules", ...dir.from.split("/")))) {
            if (dir.declarationsOnly && !relative.endsWith(".d.ts")) continue;
            expected.add(`${dir.from}/${relative}`);
          }
        }
      }
    }
    assert.deepEqual(new Set(staged), stagedNames);
    // Staging contains exactly the specified payload.
    assert.deepEqual(await walk(target), [...expected].sort());
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("engine staging fails loudly when the spec names a missing source", async () => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-engines-"));
  const emptySource = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-empty-"));
  try {
    await assert.rejects(
      stageEngineSeed(target, emptySource),
      /engine seed sources missing .* engines\.ts spec/,
    );
    // The preflight must run before any writes: a failed staging leaves no
    // half-staged tree behind.
    const entries = await fs.readdir(target).catch(() => []);
    assert.deepEqual(entries, []);
  } finally {
    await fs.rm(target, { recursive: true, force: true });
    await fs.rm(emptySource, { recursive: true, force: true });
  }
});
