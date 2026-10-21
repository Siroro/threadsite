import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { testRootSetup, trackStore } from "./fixtures/root.js";

const root = testRootSetup("deletion");
const { Store } = await import("../src/store.js");
const { UsageLog } = await import("../src/usage.js");
const { ProjectService } = await import("../src/project.js");
const { reconcileProjectThreads } = await import("../src/thread-cleanup.js");

async function fixture(id: string) {
  const project: ProjectRecord = { threadId: id, guildId: "100", parentChannelId: "300", displayName: `Game ${id}`,
    repoName: `site-game-${id}`, siteSlug: `game-${id}`, siteAliases: [`old-game-${id}`], multiplayerGameId: `tenant-${id}`,
    workspacePath: path.join(root, "workspaces", "100", id), sessionId: `session-${id}`, projectKind: "game-3d", status: "ready",
    pushKey: { username: `push-${id}`, password: "private-password", createdAt: "now" },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await fs.mkdir(path.join(project.workspacePath, "scratch", "car"), { recursive: true });
  await fs.writeFile(path.join(project.workspacePath, "PROJECT_NOTES.md"), "private project notes");
  for (const slug of [project.siteSlug, ...project.siteAliases!]) await fs.mkdir(path.join(root, "published", slug), { recursive: true });
  await fs.mkdir(path.join(root, "published", `.backup-${project.siteSlug}-0123456789`));
  const store = trackStore(await Store.open(path.join(root, `${id}.db`)));
  await store.putProject(project);
  const usage = new UsageLog(path.join(root, `${id}-usage.jsonl`));
  await usage.record({ threadId: id, project: project.displayName, kind: "game-3d" });
  const calls: string[] = [];
  const agent = { deleteSessionsInDirectory: async () => { calls.push("sessions"); }, isBusy: async () => false };
  const forgejo = { deleteRepository: async (repo: string) => { calls.push(`repo:${repo}`); },
    deletePushAccount: async (name: string) => { calls.push(`account:${name}`); }, repoWebUrl: (name: string) => `https://example.invalid/${name}` };
  const service = new ProjectService(store, agent as never, forgejo as never, usage);
  Object.assign(service, { deleteRelayGame: async (game: string) => { calls.push(`game:${game}`); } });
  return { project, store, usage, service, calls, agent, forgejo };
}

test("deleting a thread removes all project resources and duplicate events share one teardown", async () => {
  const f = await fixture("1001");
  const first = f.service.forceDeleteProject(f.project.threadId);
  assert.equal(f.service.forceDeleteProject(f.project.threadId), first);
  await first;
  assert.equal(f.store.getProject(f.project.threadId), undefined);
  for (const target of [f.project.workspacePath, path.join(root, "published", f.project.siteSlug),
    path.join(root, "published", f.project.siteAliases![0]), path.join(root, "published", `.backup-${f.project.siteSlug}-0123456789`)]) {
    await assert.rejects(fs.access(target), { code: "ENOENT" });
  }
  assert.ok(f.calls.includes(`game:${f.project.multiplayerGameId}`));
  assert.ok(f.calls.includes(`account:${f.project.pushKey!.username}`));
  assert.equal(f.calls.filter((call) => call.startsWith("repo:")).length, 1);
  assert.equal((await f.usage.threadTotal(f.project.threadId)).turns, 0);
  await f.service.forceDeleteProject(f.project.threadId);
});

test("partial failure retains durable deletion intent; restart retries without resuming a build", async () => {
  const f = await fixture("1002");
  await f.store.patchProject(f.project.threadId, { pendingTurn: { id: "turn", prompt: "old work", initial: false, startedAt: new Date().toISOString() } });
  const original = f.forgejo.deleteRepository;
  f.forgejo.deleteRepository = async () => { throw new Error("Forgejo unavailable"); };
  await assert.rejects(f.service.forceDeleteProject(f.project.threadId), /Forgejo unavailable/);
  assert.match(f.store.getProject(f.project.threadId)!.pendingDeletion!.lastError!, /Forgejo unavailable/);
  assert.deepEqual(f.store.listRecoveryProjects(), []);
  await assert.rejects(f.store.patchProject(f.project.threadId, { sessionId: "resurrected" }), /deletion is pending/);
  await assert.rejects(f.service.enqueue(f.project.threadId, async () => {}), /deletion is pending/);
  f.store.close();
  const reopened = trackStore(await Store.open(f.store.file));
  f.forgejo.deleteRepository = original;
  const service = new ProjectService(reopened, f.agent as never, f.forgejo as never, f.usage);
  Object.assign(service, { deleteRelayGame: async () => {} });
  await service.forceDeleteProject(f.project.threadId);
  assert.equal(reopened.getProject(f.project.threadId), undefined);
});

test("deletion cancels waiting jobs and waits for delivery before removing files", async () => {
  const f = await fixture("1003");
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const publishing = f.service.enqueue(f.project.threadId, async () => {
    entered(); await gate;
    await fs.writeFile(path.join(root, "published", f.project.siteSlug, "late.html"), "late publication");
  });
  await started;
  let ranQueued = false;
  const queued = f.service.enqueue(f.project.threadId, async () => { ranQueued = true; }).catch(() => {});
  const deleting = f.service.forceDeleteProject(f.project.threadId);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(f.store.getProject(f.project.threadId)!.pendingDeletion);
  await fs.access(f.project.workspacePath);
  release(); await publishing; await deleting; await queued;
  assert.equal(ranQueued, false);
  await assert.rejects(fs.access(path.join(root, "published", f.project.siteSlug)), { code: "ENOENT" });
});

test("shared identities and unsafe paths block deletion before external or recursive removal", async () => {
  const f = await fixture("1004");
  await f.store.putProject({ ...f.project, threadId: "other", workspacePath: path.join(root, "other") });
  await assert.rejects(f.service.forceDeleteProject(f.project.threadId), /shares resources/);
  assert.deepEqual(f.calls, []);
  await fs.access(f.project.workspacePath);
  await f.store.deleteProject("other");
  await f.store.patchProject(f.project.threadId, { pendingDeletion: f.store.getProject(f.project.threadId)!.pendingDeletion, workspacePath: root });
  await assert.rejects(f.service.forceDeleteProject(f.project.threadId), /Unexpected workspace/);
  assert.deepEqual(f.calls, []);
});

test("offline deletion sweep keeps archived threads and ignores permissions, outages and unavailable guilds", async () => {
  const f = await fixture("1005");
  let fetches = 0;
  const removed: string[] = [];
  const services = { available: () => true, fetch: async () => { fetches++; return { archived: true }; },
    remove: async (id: string) => { removed.push(id); } };
  await reconcileProjectThreads(f.store, services);
  for (const code of [50001, 50013, 429, 500]) {
    await reconcileProjectThreads(f.store, { ...services, fetch: async () => { throw { code }; } });
  }
  await reconcileProjectThreads(f.store, { ...services, available: () => false });
  assert.equal(fetches, 1);
  assert.deepEqual(removed, []);
  await reconcileProjectThreads(f.store, { ...services, fetch: async () => { throw { code: 10003 }; } });
  assert.deepEqual(removed, [f.project.threadId]);
  await f.store.patchProject(f.project.threadId, { pendingDeletion: { reason: "thread-delete", requestedAt: "now" } });
  await reconcileProjectThreads(f.store, { ...services, available: () => false });
  assert.equal(removed.length, 2, "durable deletion retries do not depend on Discord availability");
});

test("failed account creation retains the allocated identity so thread deletion removes it", async () => {
  const f = await fixture("1006");
  Object.assign(f.forgejo, { createPushAccount: async () => { throw new Error("create transport failed"); } });
  await assert.rejects(f.service.issuePushKey(f.project.threadId, true), /create transport failed/);
  const names = f.store.getProject(f.project.threadId)!.pushAccountNames!;
  assert.equal(names.length, 2);
  await f.service.forceDeleteProject(f.project.threadId);
  for (const name of names) assert.ok(f.calls.includes(`account:${name}`));
});

test("cleanup retries after local files are gone without reopening deleted agent workspaces", async () => {
  const f = await fixture("1007");
  const forget = f.usage.forgetThread.bind(f.usage);
  f.usage.forgetThread = async () => { throw new Error("Ledger write unavailable"); };
  await assert.rejects(f.service.forceDeleteProject(f.project.threadId), /Ledger write unavailable/);
  await assert.rejects(fs.access(f.project.workspacePath), { code: "ENOENT" });
  assert.equal(f.store.getProject(f.project.threadId)!.pendingDeletion!.agentsDeleted, true);
  f.agent.deleteSessionsInDirectory = async () => { throw new Error("Cannot reopen missing workspace"); };
  f.usage.forgetThread = forget;
  await f.service.forceDeleteProject(f.project.threadId);
  assert.equal(f.store.getProject(f.project.threadId), undefined);
});

test("deletion during initial setup has a durable registration and waits for provisioning to stop", async () => {
  const f = await fixture("1008");
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  Object.assign(f.forgejo, { ensureRepository: async () => { entered(); await gate; throw new Error("Provisioning stopped"); } });
  const creating = f.service.createProject({ threadId: "2008", guildId: "100", parentChannelId: "300", displayName: "New site", initialPrompt: "Build a site" });
  const failed = assert.rejects(creating, /Project deleted during setup/);
  await started;
  const record = f.store.getProject("2008")!;
  assert.equal(record.sessionId, "");
  const deleting = f.service.forceDeleteProject("2008");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fs.access(record.workspacePath);
  release(); await failed; await deleting;
  assert.equal(f.store.getProject("2008"), undefined);
  await assert.rejects(fs.access(record.workspacePath), { code: "ENOENT" });
  assert.ok(f.calls.includes(`repo:${record.repoName}`));
});

test("games that were always singleplayer do not need a relay cleanup request", async () => {
  const f = await fixture("1009");
  await f.store.patchProject(f.project.threadId, { multiplayerGameId: undefined, multiplayerMode: "singleplayer" });
  await f.service.forceDeleteProject(f.project.threadId);
  assert.ok(!f.calls.some((call) => call.startsWith("game:")));
});
