import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { REST } from "discord.js";
import type { ProjectRecord } from "../src/types.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-maintenance-"));
process.env.DISCORD_BOT_TOKEN = "test";
process.env.DISCORD_APPLICATION_ID = "test";
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.PUBLISH_ROOT = path.join(root, "published");
process.env.LOG_FILE = path.join(root, "test.log");
const { config } = await import("../src/config.js");
const { Store } = await import("../src/store.js");
const { selectProjects, checkedRemovalPath, removeDiscordThread, removeProjects } = await import("../src/maintenance.js");
const stores: InstanceType<typeof Store>[] = [];
after(async () => {
  for (const store of stores) store.close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function record(threadId: string, patch: Partial<ProjectRecord> = {}): ProjectRecord {
  return { threadId, guildId: "100", parentChannelId: "200", displayName: `Game ${threadId}`, repoName: `site-game-${threadId}`,
    siteSlug: `game-${threadId}`, workspacePath: path.join(config.workspaceRoot, "100", threadId), sessionId: `session-${threadId}`,
    status: "ready", projectKind: "game-3d", createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z", ...patch };
}

async function fixture(name: string, projects: ProjectRecord[]) {
  const store = await Store.open(path.join(root, `${name}.db`));
  stores.push(store);
  await store.setModel("saved-model");
  for (const project of projects) {
    await store.putProject(project);
    await fs.mkdir(project.workspacePath, { recursive: true });
    for (const slug of [project.siteSlug, ...(project.siteAliases ?? [])]) await fs.mkdir(path.join(config.publishRoot, slug), { recursive: true });
  }
  const calls: string[] = [];
  const services = {
    busy: async (_project: ProjectRecord) => false,
    deleteRepository: async (repo: string) => { calls.push(`repo:${repo}`); },
    deleteThread: async (project: ProjectRecord) => { calls.push(`thread:${project.threadId}`); },
  };
  return { store, calls, services };
}

test("selection uses exact thread/repo/game matches, deduplicates, and rejects ambiguity", () => {
  const a = record("1001");
  const b = record("1002", { displayName: a.displayName });
  const c = record("1003", { projectKind: "site", displayName: "Website" });
  assert.deepEqual(selectProjects([a, b, c], { threads: [a.threadId], repos: [a.repoName], games: [] }), [a]);
  assert.throws(() => selectProjects([a, b], { threads: [], repos: [], games: [a.displayName] }), /found 2/);
  assert.throws(() => selectProjects([a, b], { threads: [], repos: ["site-game"], games: [] }), /found 0/);
  assert.throws(() => selectProjects([c], { threads: [], repos: [], games: ["Website"] }), /found 0/);
  assert.throws(() => selectProjects([a], { threads: [], repos: [], games: [] }), /Select a project/);
});

test("full removal backs up SQLite and removes only selected resources including site aliases", async () => {
  const a = record("2001", { siteAliases: ["old-game-2001"] });
  const b = record("2002");
  const f = await fixture("full", [a, b]);
  await removeProjects(f.store, [a], "remove", f.services);
  assert.deepEqual(f.calls, [`repo:${a.repoName}`, `thread:${a.threadId}`]);
  assert.equal(f.store.getProject(a.threadId), undefined);
  assert.ok(f.store.getProject(b.threadId));
  assert.equal(f.store.getModel(), "saved-model");
  await assert.rejects(fs.access(a.workspacePath), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(config.publishRoot, a.siteSlug)), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(config.publishRoot, "old-game-2001")), { code: "ENOENT" });
  await fs.access(b.workspacePath);
  const backupName = (await fs.readdir(root)).find((name) => name.startsWith("full.db.before-cleanup-"))!;
  const snapshot = new DatabaseSync(path.join(root, backupName), { readOnly: true });
  try { assert.equal(snapshot.prepare("SELECT count(*) AS n FROM projects").get()!.n, 2); } finally { snapshot.close(); }
});

test("forget preserves files and does not invoke thread or repository deletion", async () => {
  const project = record("3001");
  const f = await fixture("forget", [project]);
  await removeProjects(f.store, [project], "forget", f.services);
  assert.deepEqual(f.calls, []);
  assert.equal(f.store.getProject(project.threadId), undefined);
  await fs.access(project.workspacePath);
  await fs.access(path.join(config.publishRoot, project.siteSlug));
});

test("pending work, busy agents, and failures leave the record and files available for retry", async () => {
  const project = record("4001");
  const pending = record("4002", { pendingTurn: { prompt: "Saved edit", initial: false, startedAt: "now" } });
  const f = await fixture("failures", [project, pending]);
  await assert.rejects(removeProjects(f.store, [project, pending], "remove", f.services), /pending work/);
  assert.deepEqual(f.calls, [], "preflight the complete selection before deleting anything");
  await assert.rejects(removeProjects(f.store, [project], "remove", { ...f.services, busy: async () => true }), /active agent/);
  await assert.rejects(removeProjects(f.store, [project], "remove", { ...f.services, deleteRepository: async () => { throw new Error("Forbidden"); } }), /Forbidden/);
  assert.ok(f.store.getProject(project.threadId));
  await fs.access(project.workspacePath);
  assert.deepEqual(f.calls, []);
  await f.store.patchProject(project.threadId, { displayName: "Changed" });
  await assert.rejects(removeProjects(f.store, [project], "forget", f.services), /record changed/);
});

test("removal rejects shared resources and unexpected workspace paths", async () => {
  const project = record("5001");
  const other = record("5002", { siteAliases: [project.siteSlug] });
  const f = await fixture("shared", [project, other]);
  await assert.rejects(removeProjects(f.store, [project], "remove", f.services), /shares resources/);
  const changed = await f.store.patchProject(project.threadId, { workspacePath: root });
  await assert.rejects(removeProjects(f.store, [changed], "remove", f.services), /Unexpected workspace/);
  assert.deepEqual(f.calls, []);
});

test("recursive cleanup refuses root/outside targets and linked ancestors", async () => {
  await assert.rejects(checkedRemovalPath(root, root), /outside the configured root/);
  await assert.rejects(checkedRemovalPath(root, path.dirname(root)), /outside the configured root/);
  const outside = path.join(root, "outside");
  const base = path.join(root, "link-test");
  await fs.mkdir(outside);
  await fs.mkdir(base);
  await fs.symlink(outside, path.join(base, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(checkedRemovalPath(base, path.join(base, "linked", "project")), /symlink/);
});

test("Discord removal verifies channel type and guild and tolerates an already deleted thread", async () => {
  let deleted = 0;
  const rest = { get: async () => ({ type: 0, guild_id: "100" }), delete: async () => { deleted += 1; } };
  const project = record("6001");
  await assert.rejects(removeDiscordThread(project, rest as unknown as REST), /not this project's thread/);
  rest.get = async () => ({ type: 11, guild_id: "wrong" });
  await assert.rejects(removeDiscordThread(project, rest as unknown as REST), /not this project's thread/);
  assert.equal(deleted, 0);
  rest.get = async () => ({ type: 11, guild_id: "100" });
  await removeDiscordThread(project, rest as unknown as REST);
  assert.equal(deleted, 1);
  rest.get = async () => { throw Object.assign(new Error("Unknown Channel"), { code: 10003 }); };
  await removeDiscordThread(project, rest as unknown as REST);
  assert.equal(deleted, 1);
});
