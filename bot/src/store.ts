import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { PersistedState, ProjectRecord, QueuedRequest } from "./types.js";

/** Database reads need durable identity; legacy markers predate explicit IDs. */
export function pendingTurnMatches(current: ProjectRecord["pendingTurn"], expected: ProjectRecord["pendingTurn"]): boolean {
  if (!current || !expected) return false;
  if (current.id || expected.id) return Boolean(current.id && current.id === expected.id);
  return current.startedAt === expected.startedAt && current.statusMessageId === expected.statusMessageId;
}

/**
 * Project/settings persistence on SQLite (node:sqlite): one JSON record per
 * project plus a key/value settings table. Replaced the original state.json
 * single-file store — same interface, but writes are transactional and there
 * is no process-wide write queue keeping renames ordered. A legacy state.json
 * next to the database is imported once on first open and left in place as a
 * backup; a file that fails to parse (or is itself the database) is ignored.
 */
export class Store {
  private readonly db: DatabaseSync;

  private constructor(readonly file: string, db: DatabaseSync) {
    this.db = db;
  }

  static async open(file: string, defaultModel?: string): Promise<Store> {
    // Preserve installations whose STATE_FILE still names the legacy JSON file.
    if (/\.json$/i.test(file)) {
      const handle = await fs.open(file, "r").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      let sqlite = false;
      if (handle) {
        try {
          const header = Buffer.alloc(16);
          await handle.read(header, 0, 16, 0);
          sqlite = header.toString() === "SQLite format 3\0";
        } finally { await handle.close(); }
      }
      if (!sqlite) file = file.replace(/\.json$/i, ".db");
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    // Without a busy timeout node:sqlite fails a write immediately when
    // another process (a rolling restart, a backup, an admin script) holds
    // the write lock, turning ordinary contention into a failed turn.
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("CREATE TABLE IF NOT EXISTS projects (thread_id TEXT PRIMARY KEY, record TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const store = new Store(file, db);
    await store.importLegacyJson(file.replace(/\.db$/i, ".json"));
    if (!store.getModel() && defaultModel) await store.setModel(defaultModel);
    return store;
  }

  /** One-time import of a legacy state.json; anything unreadable is skipped. */
  private async importLegacyJson(jsonFile: string): Promise<void> {
    if (jsonFile === this.file) return;
    if (this.db.prepare("SELECT 1 FROM settings LIMIT 1").get() || this.db.prepare("SELECT 1 FROM projects LIMIT 1").get()) return;
    let state: PersistedState;
    try {
      state = JSON.parse(await fs.readFile(jsonFile, "utf8")) as PersistedState;
      if (state.version !== 1 || !state.projects || !state.settings) return;
    } catch {
      return; // missing, the database file itself, or corrupt: nothing to import
    }
    const insertProject = this.db.prepare(
      "INSERT INTO projects (thread_id, record) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET record = excluded.record",
    );
    const insertSetting = this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    this.db.exec("BEGIN");
    try {
      for (const project of Object.values(state.projects)) {
        if (project?.threadId) insertProject.run(project.threadId, JSON.stringify(project));
      }
      for (const [key, value] of Object.entries(state.settings)) {
        if (value !== undefined) insertSetting.run(key, JSON.stringify(value));
      }
      insertSetting.run("__legacy_imported", "true");
      this.db.exec("COMMIT");
      console.warn(`[threadsite] imported ${Object.keys(state.projects).length} project(s) from legacy ${jsonFile} (left in place as backup)`);
    } catch (error) {
      this.db.exec("ROLLBACK");
      console.warn("[threadsite] legacy state import failed; continuing with the empty database:", error);
    }
  }

  private getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value?: string } | undefined;
    if (row?.value === undefined) return undefined;
    try {
      return (JSON.parse(row.value) ?? undefined) as T | undefined;
    } catch {
      return undefined;
    }
  }

  private async setSetting(key: string, value: unknown): Promise<void> {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  getModel(): string | undefined {
    return this.getSetting<string>("model");
  }

  async setModel(model?: string): Promise<void> {
    await this.setSetting("model", model || null);
  }

  getEffort(): string | undefined {
    return this.getSetting<string>("effort");
  }

  async setEffort(effort?: string): Promise<void> {
    await this.setSetting("effort", effort || null);
  }

  getWebhookSecret(): string | undefined {
    return this.getSetting<string>("webhookSecret");
  }

  /** Stable HMAC secret for the Forgejo push webhooks; generated once and persisted. */
  async ensureWebhookSecret(): Promise<string> {
    const existing = this.getWebhookSecret();
    if (existing) return existing;
    const secret = randomBytes(32).toString("hex");
    await this.setSetting("webhookSecret", secret);
    return secret;
  }

  getProject(threadId: string): ProjectRecord | undefined {
    const row = this.db.prepare("SELECT record FROM projects WHERE thread_id = ?").get(threadId) as { record?: string } | undefined;
    if (!row?.record) return undefined;
    try {
      return JSON.parse(row.record) as ProjectRecord;
    } catch {
      return undefined;
    }
  }

  listProjects(): ProjectRecord[] {
    const rows = this.db.prepare("SELECT record FROM projects").all() as Array<{ record?: string }>;
    const projects: ProjectRecord[] = [];
    for (const row of rows) {
      if (!row.record) continue;
      try {
        projects.push(JSON.parse(row.record) as ProjectRecord);
      } catch {
        // A corrupt row costs one project listing, not the whole store.
      }
    }
    // A legacy/partial row may predate updatedAt; sorting must not throw on it
    // (this runs in /healthz, the gallery refresh, and webhook dispatch).
    return projects.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  listRecoveryProjects(): ProjectRecord[] {
    return this.listProjects().filter((project) => project.pendingTurn || project.pendingQueue?.length || project.pendingRename || project.pendingThreadName);
  }

  async putProject(project: ProjectRecord): Promise<void> {
    this.db.prepare("INSERT INTO projects (thread_id, record) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET record = excluded.record")
      .run(project.threadId, JSON.stringify(project));
  }

  async patchProject(threadId: string, patch: Partial<ProjectRecord>): Promise<ProjectRecord> {
    const current = this.getProject(threadId);
    if (!current) throw new Error(`Unknown project thread ${threadId}`);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.putProject(next);
    return next;
  }

  async deleteProject(threadId: string): Promise<void> {
    this.db.prepare("DELETE FROM projects WHERE thread_id = ?").run(threadId);
  }

  close(): void {
    this.db.close();
  }

  async appendQueuedRequest(threadId: string, request: QueuedRequest): Promise<void> {
    const current = this.getProject(threadId);
    if (!current) throw new Error(`Unknown project thread ${threadId}`);
    const queue = current.pendingQueue ?? [];
    if (queue.some((entry) => entry.statusMessageId === request.statusMessageId)) return;
    await this.patchProject(threadId, { pendingQueue: [...queue, request] });
  }

  /** One persisted snapshot hands just this batch from the queue to crash recovery. */
  async startQueuedTurn(threadId: string, pendingTurn: NonNullable<ProjectRecord["pendingTurn"]>, statusIds: readonly string[]): Promise<ProjectRecord> {
    const current = this.getProject(threadId);
    if (!current) throw new Error(`Unknown project thread ${threadId}`);
    const consumed = new Set(statusIds);
    const remaining = current.pendingQueue?.filter((entry) => !consumed.has(entry.statusMessageId));
    return this.patchProject(threadId, { pendingTurn, pendingQueue: remaining?.length ? remaining : undefined });
  }

  /**
   * Withdraw one waiting request (`/site queue`). Only entries still in
   * pendingQueue can be cancelled: once a turn claims a batch, its entries are
   * gone from here and the caller must not remove the prompt from under it.
   */
  async cancelQueuedRequest(threadId: string, statusMessageId: string): Promise<{ removed: boolean; prompt?: string; remaining: number }> {
    const current = this.getProject(threadId);
    if (!current?.pendingQueue?.length) return { removed: false, remaining: 0 };
    const index = current.pendingQueue.findIndex((entry) => entry.statusMessageId === statusMessageId);
    if (index < 0) return { removed: false, remaining: current.pendingQueue.length };
    const [entry] = current.pendingQueue.splice(index, 1);
    await this.patchProject(threadId, { pendingQueue: current.pendingQueue.length ? current.pendingQueue : undefined });
    return { removed: true, prompt: entry.prompt, remaining: current.pendingQueue.length };
  }

  /**
   * Drop queued requests that will never run because the turn failed before
   * claiming them. Without this they stay in the database and are reported by
   * boot recovery on every restart, and an image-only entry (which recovery
   * skips) can never be removed any other way.
   */
  async dropQueuedRequests(threadId: string, statusIds: readonly string[]): Promise<void> {
    if (!statusIds.length) return;
    const current = this.getProject(threadId);
    if (!current?.pendingQueue?.length) return;
    const dropped = new Set(statusIds);
    const remaining = current.pendingQueue.filter((entry) => !dropped.has(entry.statusMessageId));
    if (remaining.length === current.pendingQueue.length) return;
    await this.patchProject(threadId, { pendingQueue: remaining.length ? remaining : undefined });
  }
}
