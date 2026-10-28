import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { testRootSetup } from "./fixtures/root.js";

const root = testRootSetup("usage-ledger-cleanup");
process.env.STATE_DB_FILE = path.join(root, "data", "state.db");
const { config } = await import("../src/config.js");
const { discardLegacyUsageLedger } = await import("../src/maintenance.js");

test("a standalone legacy usage ledger is discarded without touching the live state database", async () => {
  const dataDir = path.dirname(config.stateDbFile);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(config.stateDbFile, "live database");
  for (const suffix of ["", "-wal", "-shm"]) {
    await fs.writeFile(path.join(dataDir, `usage-log.jsonl.sqlite${suffix}`), `stale${suffix}`);
  }
  await discardLegacyUsageLedger();
  for (const suffix of ["", "-wal", "-shm"]) {
    await assert.rejects(fs.access(path.join(dataDir, `usage-log.jsonl.sqlite${suffix}`)), { code: "ENOENT" }, `the stale ledger${suffix} is gone`);
  }
  assert.equal(await fs.readFile(config.stateDbFile, "utf8"), "live database", "the state database is untouched");
  await discardLegacyUsageLedger();
  assert.equal(await fs.readFile(config.stateDbFile, "utf8"), "live database", "re-running the discard stays harmless");
});
