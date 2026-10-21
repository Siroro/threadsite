import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import type { Store } from "../src/store.js";
import type { ProjectRecord } from "../src/types.js";

/**
 * Shared per-file test environment: a temp root with the standard env vars,
 * a store registry closed on exit, and a Windows-tolerant cleanup. Each test
 * file calls this once at the top before importing anything from ../src.
 */
export function testRootSetup(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `threadsite-${label}-`));
  process.env.DISCORD_BOT_TOKEN = "test";
  process.env.DISCORD_APPLICATION_ID = "test";
  process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
  process.env.PUBLISH_ROOT = path.join(root, "published");
  process.env.LOG_FILE = path.join(root, "test.log");
  const stores: Store[] = [];
  after(async () => {
    for (const store of stores) {
      try { store.close(); } catch { /* already closed */ }
    }
    // Windows transiently reports ENOTEMPTY/EBUSY while git/index handles
    // close; without retries the cleanup itself fails the suite.
    await fsPromises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  (testRootSetup as { stores?: Store[] }).stores = stores;
  return root;
}

/** Register a store for cleanup; pair with testRootSetup. */
export function trackStore<T extends Store>(store: T): T {
  const stores = (testRootSetup as { stores?: Store[] }).stores;
  stores?.push(store);
  return store;
}

/** Minimal ready-site record for store/registry tests. */
export function testRecord(threadId: string, dir: string, extra: Partial<ProjectRecord> = {}): ProjectRecord {
  const now = new Date().toISOString();
  return { threadId, guildId: "100", parentChannelId: "200", displayName: "Old Name", siteSlug: `old-${threadId}`,
    repoName: `site-old-${threadId}`, sessionId: "fake", workspacePath: dir, projectKind: "site", status: "ready", createdAt: now, updatedAt: now,
    ...extra };
}
