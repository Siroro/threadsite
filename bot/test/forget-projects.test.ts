import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../../scripts/forget-projects.mjs", import.meta.url));

test("stale-registration cleanup previews, deletes only exact matches, and backs up on request", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-forget-"));
  const database = path.join(root, "state.db");
  const db = new DatabaseSync(database);
  t.after(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE projects(thread_id TEXT PRIMARY KEY, record TEXT); CREATE TABLE settings(key TEXT, value TEXT)");
  db.prepare("INSERT INTO settings VALUES (?, ?)").run("model", "saved-model");
  const insert = db.prepare("INSERT INTO projects VALUES (?, ?)");
  insert.run("stale", JSON.stringify({ repoName: "deleted-repo", displayName: "Old game" }));
  insert.run("keep", JSON.stringify({ repoName: "deleted-repo-other" }));
  const run = (...args: string[]) => exec(process.execPath, [script, "--db", database, "--repo", "deleted-repo", ...args]);
  assert.match((await run()).stdout, /Dry run: 1/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM projects").get()!.n, 2);
  assert.match((await run("--apply")).stdout, /Removed 1 stale/);
  assert.equal(db.prepare("SELECT thread_id FROM projects").get()!.thread_id, "keep");
  assert.equal(db.prepare("SELECT value FROM settings").get()!.value, "saved-model");
  assert.deepEqual((await fs.readdir(root)).filter((file) => file.includes(".before-forget-")), []);
  assert.match((await run("--apply")).stdout, /No matching registrations/);
  insert.run("stale", JSON.stringify({ repoName: "deleted-repo", displayName: "Old game" }));
  assert.match((await run("--apply", "--backup")).stdout, /Removed 1 stale/);
  const backups = (await fs.readdir(root)).filter((file) => file.includes(".before-forget-"));
  assert.equal(backups.length, 1);
  const saved = new DatabaseSync(path.join(root, backups[0]), { readOnly: true });
  assert.equal(saved.prepare("SELECT count(*) AS n FROM projects").get()!.n, 2);
  saved.close();
  insert.run("pending", JSON.stringify({ repoName: "deleted-repo", pendingTurn: { prompt: "saved work" } }));
  await assert.rejects(run("--apply"), /has pending work/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM projects").get()!.n, 2);
});
