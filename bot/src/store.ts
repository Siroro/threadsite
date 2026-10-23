import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { CollaborationSettings, ContributionKind, ContributionTally, ProjectApproval, ProjectRecord, QueuedRequest } from "./types.js";

/** Durable turn identity: matches by the stable id assigned when the turn is claimed. */
export function pendingTurnMatches(current: ProjectRecord["pendingTurn"], expected: ProjectRecord["pendingTurn"]): boolean {
  return Boolean(current && expected && current.id === expected.id);
}

/**
 * Project/settings persistence on SQLite (node:sqlite): one JSON record per
 * project plus a key/value settings table. Writes are transactional and there
 * is no process-wide write queue keeping renames ordered.
 */
export class Store {
  private readonly db: DatabaseSync;

  private constructor(readonly file: string, db: DatabaseSync) {
    this.db = db;
  }

  static async open(file: string, defaultModel?: string): Promise<Store> {
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
    db.exec("CREATE TABLE IF NOT EXISTS card_state (thread_id TEXT NOT NULL, card_key TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (thread_id, card_key))");
    db.exec("CREATE TABLE IF NOT EXISTS project_approvals (thread_id TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(thread_id, id))");
    const store = new Store(file, db);
    if (!store.getModel() && defaultModel) await store.setModel(defaultModel);
    return store;
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

  /** Runtime backup-model list; undefined follows OPENCODE_FAILOVER_MODELS. */
  getFailoverModels(): string[] | undefined {
    return this.getSetting<string[]>("failoverModels");
  }

  async setFailoverModels(models: string[] | null): Promise<void> {
    await this.setSetting("failoverModels", models);
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
    return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  listRecoveryProjects(): ProjectRecord[] {
    return this.listProjects().filter((project) => !project.pendingDeletion && (project.pendingTurn || project.pendingQueue?.length || project.pendingRename || project.pendingThreadName || project.pendingNaming));
  }

  async putProject(project: ProjectRecord): Promise<void> {
    if (this.getProject(project.threadId)?.pendingDeletion && !project.pendingDeletion) throw new Error("Project deletion is pending.");
    this.db.prepare("INSERT INTO projects (thread_id, record) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET record = excluded.record")
      .run(project.threadId, JSON.stringify(project));
  }

  async patchProject(threadId: string, patch: Partial<ProjectRecord>): Promise<ProjectRecord> {
    const current = this.getProject(threadId);
    if (!current) throw new Error(`Unknown project thread ${threadId}`);
    if (current.pendingDeletion && !patch.pendingDeletion) throw new Error("Project deletion is pending.");
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.putProject(next);
    return next;
  }

  async deleteProject(threadId: string): Promise<void> {
    this.db.prepare("DELETE FROM project_approvals WHERE thread_id = ?").run(threadId);
    this.db.prepare("DELETE FROM card_state WHERE thread_id = ?").run(threadId);
    this.db.prepare("DELETE FROM projects WHERE thread_id = ?").run(threadId);
  }

  /** Public card snapshots and interaction drafts, kept separate from project lifecycle writes. */
  getCardState<T>(threadId: string, key: string): T | undefined {
    const row = this.db.prepare("SELECT record FROM card_state WHERE thread_id = ? AND card_key = ?").get(threadId, key) as { record?: string } | undefined;
    if (!row?.record) return undefined;
    try { return JSON.parse(row.record) as T; } catch { return undefined; }
  }

  /** Synchronous read/merge/write: a click claims its state before any network await. */
  patchCardState<T extends object>(threadId: string, key: string, patch: Partial<T>): T {
    const project = this.getProject(threadId);
    if (!project || project.pendingDeletion) throw new Error("This project is no longer available.");
    const next = { ...this.getCardState<T>(threadId, key), ...patch } as T;
    this.db.prepare("INSERT INTO card_state (thread_id, card_key, record) VALUES (?, ?, ?) ON CONFLICT(thread_id, card_key) DO UPDATE SET record = excluded.record")
      .run(threadId, key, JSON.stringify(next));
    return next;
  }

  /** Durable single-flight claim, including across overlapping bot processes. */
  claimCardAction<T extends { status: string }>(threadId: string, key: string, record: T): boolean {
    const project = this.getProject(threadId);
    if (!project || project.pendingDeletion) return false;
    const result = this.db.prepare("INSERT INTO card_state (thread_id, card_key, record) VALUES (?, ?, ?) ON CONFLICT(thread_id, card_key) DO UPDATE SET record = excluded.record WHERE json_extract(card_state.record, '$.status') IN ('ready', 'retry')")
      .run(threadId, key, JSON.stringify(record));
    return Number(result.changes) === 1;
  }

  close(): void {
    this.db.close();
  }

  setCollaboration(threadId: string, settings: CollaborationSettings, expectedRevision: number, ownerId?: string): void {
    const current = this.getProject(threadId);
    if (!current || current.pendingDeletion) throw new Error("This project is no longer available.");
    if ((current.collaboration?.revision ?? 0) !== expectedRevision) throw new Error("Collaboration settings changed. Refresh the panel before editing them.");
    const record = { ...current, collaboration: settings, ...(ownerId ? { ownerId } : {}) };
    const result = this.db.prepare("UPDATE projects SET record = ? WHERE thread_id = ? AND COALESCE(json_extract(record, '$.collaboration.revision'), 0) = ?")
      .run(JSON.stringify(record), threadId, expectedRevision);
    if (!Number(result.changes)) throw new Error("Collaboration settings changed. Refresh the panel before editing them.");
  }

  getApproval(threadId: string, id: string): ProjectApproval | undefined {
    const row = this.db.prepare("SELECT record FROM project_approvals WHERE thread_id = ? AND id = ?").get(threadId, id) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as ProjectApproval : undefined;
  }

  listApprovals(threadId: string): Omit<ProjectApproval, "attachments">[] {
    const rows = this.db.prepare("SELECT json_remove(record, '$.attachments') AS record FROM project_approvals WHERE thread_id = ? ORDER BY id").all(threadId) as { record: string }[];
    return rows.map((row) => JSON.parse(row.record) as Omit<ProjectApproval, "attachments">);
  }

  addApproval(threadId: string, request: ProjectApproval): void {
    if (this.getApproval(threadId, request.id)) return;
    const project = this.getProject(threadId);
    if (!project || project.pendingDeletion) throw new Error("This project is no longer available.");
    const result = this.db.prepare(`INSERT OR IGNORE INTO project_approvals SELECT ?, ?, ?
      WHERE (SELECT COUNT(*) FROM project_approvals WHERE thread_id = ?) < 20`)
      .run(threadId, request.id, JSON.stringify(request), threadId);
    if (!Number(result.changes)) throw new Error("This project already has 20 requests waiting for approval.");
  }

  rejectApproval(threadId: string, id: string): boolean {
    return Number(this.db.prepare("DELETE FROM project_approvals WHERE thread_id = ? AND id = ?").run(threadId, id).changes) > 0;
  }

  /** Approval and queue admission are one transaction: a crash cannot lose or double-admit a request. */
  approveRequest(threadId: string, id: string, request: QueuedRequest): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getProject(threadId);
      if (!current || current.pendingDeletion) throw new Error("This project is no longer available.");
      if (!this.getApproval(threadId, id)) { this.db.exec("ROLLBACK"); return false; }
      const queue = current.pendingQueue ?? [];
      if (!queue.some((entry) => entry.statusMessageId === request.statusMessageId)) queue.push(request);
      this.db.prepare("UPDATE projects SET record = ? WHERE thread_id = ?").run(JSON.stringify({ ...current, pendingQueue: queue }), threadId);
      this.db.prepare("DELETE FROM project_approvals WHERE thread_id = ? AND id = ?").run(threadId, id);
      this.db.exec("COMMIT");
      return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  async appendQueuedRequest(threadId: string, request: QueuedRequest): Promise<void> {
    const current = this.getProject(threadId);
    if (!current) throw new Error(`Unknown project thread ${threadId}`);
    const queue = current.pendingQueue ?? [];
    if (queue.some((entry) => entry.statusMessageId === request.statusMessageId)) return;
    await this.patchProject(threadId, { pendingQueue: [...queue, request] });
  }

  /**
   * Count one user contribution on the project record. A lost tally must never
   * disturb the flow that earned it, so callers treat errors as advisory; a
   * project pending deletion simply stops counting.
   */
  async addContribution(threadId: string, userId: string, kind: ContributionKind): Promise<void> {
    if (!userId) return;
    const current = this.getProject(threadId);
    if (!current || current.pendingDeletion) return;
    const tally: ContributionTally = { ...(current.contributors?.[userId] ?? { turns: 0, steers: 0, answers: 0 }) };
    tally[kind] += 1;
    await this.putProject({
      ...current,
      contributors: { ...(current.contributors ?? {}), [userId]: tally },
      updatedAt: new Date().toISOString(),
    });
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
