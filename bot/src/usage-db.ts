import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { log } from "./logger.js";
import type { UsageEntry, UsageTotal } from "./usage.js";
import { UsageSummaries } from "./usage-summary.js";

const openings = new Map<string, Promise<void>>();

/** Indexed current revisions. The legacy JSONL is imported transactionally once and retained. */
export class UsageDatabase {
  readonly file: string;
  private initialized = false;
  private readonly summaries = new UsageSummaries();
  private readonly statements = new WeakMap<DatabaseSync, {
    deleted: ReturnType<DatabaseSync["prepare"]>; entry: ReturnType<DatabaseSync["prepare"]>;
    deleteModels: ReturnType<DatabaseSync["prepare"]>; model: ReturnType<DatabaseSync["prepare"]>;
  }>();
  constructor(readonly legacyFile: string, file?: string) {
    this.file = path.resolve(file ?? `${legacyFile}.sqlite`);
    if (this.file === path.resolve(legacyFile)) throw new Error("Usage database and legacy ledger must be different files");
  }

  private open(): DatabaseSync {
    const db = new DatabaseSync(this.file);
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON");
      return db;
    } catch (error) { db.close(); throw error; }
  }

  async ready(): Promise<void> {
    if (this.initialized) return;
    let opening = openings.get(this.file);
    if (!opening) {
      opening = this.initialize();
      openings.set(this.file, opening);
      void opening.finally(() => { if (openings.get(this.file) === opening) openings.delete(this.file); }).catch(() => {});
    }
    await opening;
    this.initialized = true;
  }

  private async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const db = this.open();
    try {
      const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
      if (version > 3) throw new Error(`Usage database schema version ${version} is newer than this bot supports`);
      db.exec(`PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS usage_deleted (thread_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS usage_entries (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ts TEXT NOT NULL, started_at TEXT, record TEXT NOT NULL,
          generation_ms REAL, timed_output_tokens INTEGER,
          output_tokens_per_second REAL GENERATED ALWAYS AS (timed_output_tokens * 1000.0 / NULLIF(generation_ms, 0)) STORED);
        CREATE INDEX IF NOT EXISTS usage_by_thread_order ON usage_entries(thread_id, ts, id);
        CREATE INDEX IF NOT EXISTS usage_by_time_order ON usage_entries(ts, id);
        DROP INDEX IF EXISTS usage_by_thread;
        DROP INDEX IF EXISTS usage_by_time;
        CREATE INDEX IF NOT EXISTS usage_by_started_at ON usage_entries(started_at);
        CREATE TABLE IF NOT EXISTS usage_models (entry_id TEXT NOT NULL REFERENCES usage_entries(id) ON DELETE CASCADE,
          model TEXT NOT NULL, input_tokens INTEGER NOT NULL, cache_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
          cost REAL NOT NULL, generation_ms REAL, timed_output_tokens INTEGER,
          output_tokens_per_second REAL GENERATED ALWAYS AS (timed_output_tokens * 1000.0 / NULLIF(generation_ms, 0)) STORED, PRIMARY KEY(entry_id, model));
        CREATE INDEX IF NOT EXISTS usage_models_by_model ON usage_models(model, entry_id);
        PRAGMA user_version = 3;`);
      UsageSummaries.create(db);
      if (db.prepare("SELECT value FROM usage_meta WHERE key = 'legacy_import_v1'").get()
        && db.prepare("SELECT value FROM usage_meta WHERE key = 'thread_summary_v2'").get()) return;
      db.exec("BEGIN IMMEDIATE");
      try {
        // Check again after obtaining the write lock in case another process migrated it.
        if (!db.prepare("SELECT value FROM usage_meta WHERE key = 'legacy_import_v1'").get()) {
          let exists = true;
          try { await fs.access(this.legacyFile); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            exists = false;
          }
          if (exists) {
            const lines = createInterface({ input: createReadStream(this.legacyFile, { encoding: "utf8" }), crlfDelay: Infinity });
            for await (const line of lines) {
              if (!line.trim()) continue;
              let entry: UsageEntry;
              try { entry = JSON.parse(line) as UsageEntry; }
              catch { log("warn", "usage.entry_parse_failed", { file: this.legacyFile }); continue; }
              if (entry?.v === 1 && typeof entry.id === "string" && typeof entry.ts === "string" && typeof entry.threadId === "string") this.put(db, entry, false);
            }
          }
          db.prepare("INSERT INTO usage_meta(key,value) VALUES ('legacy_import_v1','done')").run();
        }
        if (!db.prepare("SELECT value FROM usage_meta WHERE key = 'thread_summary_v2'").get()) {
          // Summary tables are derived data: rebuild them atomically when the
          // schema changes or an earlier setup was interrupted.
          db.exec("DROP TABLE IF EXISTS usage_thread_totals; DROP TABLE IF EXISTS usage_thread_models");
          UsageSummaries.create(db);
          for (const row of db.prepare("SELECT record FROM usage_entries").iterate()) {
            this.summaries.adjust(db, JSON.parse(String(row.record)) as UsageEntry, 1);
          }
          db.prepare("INSERT INTO usage_meta(key,value) VALUES ('thread_summary_v2','done')").run();
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } finally { db.close(); }
  }

  private put(db: DatabaseSync, entry: UsageEntry, updateSummary = true, previous?: UsageEntry): void {
    let statements = this.statements.get(db);
    if (!statements) {
      statements = {
        deleted: db.prepare("SELECT 1 FROM usage_deleted WHERE thread_id = ?"),
        entry: db.prepare(`INSERT INTO usage_entries(id,thread_id,ts,started_at,record,generation_ms,timed_output_tokens) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET thread_id=excluded.thread_id, ts=excluded.ts, started_at=excluded.started_at, record=excluded.record,
            generation_ms=excluded.generation_ms, timed_output_tokens=excluded.timed_output_tokens`),
        deleteModels: db.prepare("DELETE FROM usage_models WHERE entry_id = ?"),
        model: db.prepare(`INSERT INTO usage_models(entry_id,model,input_tokens,cache_tokens,output_tokens,cost,generation_ms,timed_output_tokens)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(entry_id,model) DO UPDATE SET
          input_tokens=excluded.input_tokens, cache_tokens=excluded.cache_tokens, output_tokens=excluded.output_tokens,
          cost=excluded.cost, generation_ms=excluded.generation_ms, timed_output_tokens=excluded.timed_output_tokens`),
      };
      this.statements.set(db, statements);
    }
    if (statements.deleted.get(entry.threadId)) return;
    if (updateSummary) {
      if (previous) this.summaries.adjust(db, previous, -1);
      this.summaries.adjust(db, entry, 1);
    }
    statements.entry.run(entry.id, entry.threadId, entry.ts, entry.startedAt ?? null, JSON.stringify(entry),
      entry.generationMs ?? null, entry.timedOutputTokens ?? null);
    statements.deleteModels.run(entry.id);
    for (const model of entry.models ?? []) statements.model.run(entry.id, model.model, model.inputTokens, model.cacheTokens,
      model.outputTokens, model.cost, model.generationMs ?? null, model.timedOutputTokens ?? null);
  }

  async putEntry(entry: UsageEntry): Promise<void> {
    await this.ready();
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.prepare("SELECT record FROM usage_entries WHERE id = ?").get(entry.id) as { record: string } | undefined;
        const previous = row ? JSON.parse(row.record) as UsageEntry : undefined;
        if (previous && previous.inputTokens + previous.outputTokens > entry.inputTokens + entry.outputTokens) {
          entry = { ...entry, inputTokens: previous.inputTokens, outputTokens: previous.outputTokens,
            cacheTokens: previous.cacheTokens, cost: previous.cost, models: previous.models };
        }
        if (previous?.startedAt && !entry.startedAt) entry.startedAt = previous.startedAt;
        // A sparse recovery revision must not erase previously measured throughput.
        if (previous && entry.generationMs === undefined && previous.generationMs !== undefined) {
          entry = { ...entry, generationMs: previous.generationMs, timedOutputTokens: previous.timedOutputTokens };
        }
        if (previous) entry.models = entry.models.map((model) => {
          const old = previous.models.find((item) => item.model === model.model);
          return model.generationMs === undefined && old?.generationMs !== undefined
            ? { ...model, generationMs: old.generationMs, timedOutputTokens: old.timedOutputTokens } : model;
        });
        this.put(db, entry, true, previous);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } finally { db.close(); }
  }

  async entries(threadId?: string, since?: string): Promise<UsageEntry[]> {
    await this.ready();
    const db = this.open();
    try {
      const rows = threadId !== undefined
        ? db.prepare("SELECT record FROM usage_entries WHERE thread_id = ? ORDER BY ts, id").all(threadId)
        : since !== undefined ? db.prepare("SELECT record FROM usage_entries WHERE ts >= ? ORDER BY ts, id").all(since)
        : db.prepare("SELECT record FROM usage_entries ORDER BY ts, id").all();
      return rows.map((row) => JSON.parse(row.record as string) as UsageEntry);
    } finally { db.close(); }
  }

  async threadTotal(threadId: string): Promise<UsageTotal & { lastTs?: string }> {
    await this.ready();
    const db = this.open();
    try {
      db.exec("BEGIN");
      try {
        const total = this.summaries.read(db, threadId);
        db.exec("COMMIT");
        return total;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } finally { db.close(); }
  }

  async threadIds(): Promise<string[]> {
    await this.ready();
    const db = this.open();
    try { return db.prepare("SELECT DISTINCT thread_id FROM usage_entries").all().map((row) => String(row.thread_id)); }
    finally { db.close(); }
  }

  async forget(threadId: string): Promise<void> {
    await this.ready();
    // Scrub every legacy revision before the database deletion; a failed scrub
    // leaves the indexed entry in place so cleanup can safely be retried.
    let raw: string | undefined;
    try { raw = await fs.readFile(this.legacyFile, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (raw !== undefined) {
      const lines = raw.split("\n").filter((line) => { try { return JSON.parse(line).threadId !== threadId; } catch { return true; } });
      const temporary = `${this.legacyFile}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temporary, "wx", 0o600);
        try { await handle.writeFile(lines.join("\n")); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, this.legacyFile);
      } finally { await fs.rm(temporary, { force: true }); }
    }
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT OR IGNORE INTO usage_deleted(thread_id) VALUES (?)").run(threadId);
        db.prepare("DELETE FROM usage_entries WHERE thread_id = ?").run(threadId);
        db.prepare("DELETE FROM usage_thread_models WHERE thread_id = ?").run(threadId);
        db.prepare("DELETE FROM usage_thread_totals WHERE thread_id = ?").run(threadId);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { db.close(); }
  }
}
