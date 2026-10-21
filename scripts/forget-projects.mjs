// Remove explicitly named stale registrations only. Run with the bot stopped.
// Defaults to a dry run; --apply saves a full SQLite backup before deleting.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";

const repositories = new Set();
let apply = false;
let database = process.env.STATE_DB_FILE?.trim()
  || `${(process.env.STATE_FILE?.trim() || "/data/state.json").replace(/\.json$/i, "")}.db`;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--apply") apply = true;
  else if ((arg === "--repo" || arg === "--db") && args[index + 1] && !args[index + 1].startsWith("--")) {
    const value = args[++index];
    if (arg === "--repo") repositories.add(value);
    else database = value;
  } else throw new Error(`Unknown or incomplete argument: ${arg}. Use --repo NAME (repeatable), --db FILE, and optionally --apply.`);
}
if (!repositories.size) throw new Error("Specify at least one exact repository name with --repo NAME. Stop the bot before using --apply.");

// Resolve an existing file: a typo must never create a new, empty database.
database = await fs.realpath(path.resolve(database));
const source = new DatabaseSync(database, { readOnly: true });
let matches;
let backupFile;
try {
  matches = source.prepare("SELECT thread_id, record FROM projects").all().filter((row) => repositories.has(JSON.parse(row.record).repoName));
  for (const row of matches) {
    const project = JSON.parse(row.record);
    if (project.pendingTurn || project.pendingQueue?.length || project.pendingRename || project.pendingThreadName) {
      throw new Error(`Refusing to forget ${project.repoName}: it has pending work. Stop/reconcile that project first.`);
    }
    console.log(JSON.stringify({ threadId: row.thread_id, repoName: project.repoName, displayName: project.displayName, status: project.status }));
  }
  if (apply && matches.length) {
    backupFile = `${database}.before-forget-${randomUUID()}.db`;
    const file = await fs.open(backupFile, "wx", 0o600);
    await file.close();
    await backup(source, backupFile);
    console.log(`SQLite backup: ${backupFile}`);
  }
} finally {
  source.close();
}

if (!apply) {
  console.log(`Dry run: ${matches.length} matching registration(s). No changes made. Stop the bot, then add --apply to remove these records only.`);
} else if (!matches.length) {
  console.log("No matching registrations. No changes made.");
} else {
  const db = new DatabaseSync(database);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    const remove = db.prepare("DELETE FROM projects WHERE thread_id = ? AND record = ?");
    for (const row of matches) {
      if (remove.run(row.thread_id, row.record).changes !== 1) throw new Error(`Project ${row.thread_id} changed during cleanup; no records removed. Stop the bot and retry.`);
    }
    db.exec("COMMIT");
    console.log(`Removed ${matches.length} stale registration(s). Workspaces, published sites, repositories, and settings were preserved.`);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}
