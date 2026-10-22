import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { ProjectRecord } from "../src/types.js";
import type { PurgeServices } from "../src/purge.js";
import { testRootSetup, trackStore } from "./fixtures/root.js";

const root = testRootSetup("purge");
const { config } = await import("../src/config.js");
const { Store } = await import("../src/store.js");
const { planPurge, applyPurge } = await import("../src/purge.js");

function record(threadId: string, patch: Partial<ProjectRecord> = {}): ProjectRecord {
  return { threadId, guildId: "100", parentChannelId: "200", displayName: `Site ${threadId}`, repoName: `site-${threadId}`,
    siteSlug: `slug-${threadId}`, workspacePath: path.join(config.workspaceRoot, "100", threadId), sessionId: `session-${threadId}`,
    status: "ready", projectKind: "site", createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z", ...patch };
}

async function storeWith(name: string, projects: ProjectRecord[]): Promise<InstanceType<typeof Store>> {
  const store = trackStore(await Store.open(path.join(root, `${name}.db`)));
  for (const project of projects) await store.putProject(project);
  return store;
}

function services(overrides: Partial<PurgeServices> = {}) {
  const calls: string[] = [];
  const base: PurgeServices = {
    thread: async (threadId) => ({ guild_id: "100", type: 11 }),
    repositories: async () => [
      { id: 1, name: "site-7001", description: "" },
      { id: 20, name: "orphan-repo", description: "static website generated from Discord thread 7009" },
    ],
    managedRepository: async (repo) => repo.name === "orphan-repo",
    repository: async (name) => name === "site-7001" ? { id: 1, name } : name === "orphan-repo" ? { id: 20, name } : undefined,
    sessions: async () => [
      { id: "session-7001", directory: path.join(config.workspaceRoot, "100", "7001") },
      { id: "session-orphan", directory: path.join(config.workspaceRoot, "100", "7009") },
    ],
    accounts: async () => ["push-aaaaaa", "push-bbbbbb"],
    games: async () => ["live-game", "orphan-game"],
    usageThreads: async () => ["7001", "7009"],
    removeProject: async (threadId) => { calls.push(`project:${threadId}`); },
    removeSessions: async (directory, knownId) => { calls.push(`sessions:${knownId}`); },
    removeRepository: async (name) => { calls.push(`repo:${name}`); },
    removeAccount: async (name) => { calls.push(`account:${name}`); },
    removeGame: async (game) => { calls.push(`game:${game}`); },
    forgetUsage: async (threadId) => { calls.push(`usage:${threadId}`); },
    refreshIndex: async () => { calls.push("index"); },
  };
  return { calls, services: { ...base, ...overrides } };
}

test("plan inventories orphans and excludes every resource a registered project owns", async () => {
  const live = record("7001", { pushAccountNames: ["push-aaaaaa"], multiplayerGameId: "live-game" });
  const store = await storeWith("plan", [live]);
  await fs.mkdir(live.workspacePath, { recursive: true });
  await fs.mkdir(path.join(config.workspaceRoot, "100", "7009"), { recursive: true });
  await fs.mkdir(path.join(config.publishRoot, live.siteSlug), { recursive: true });
  await fs.mkdir(path.join(config.publishRoot, "orphan-slug"), { recursive: true });
  await fs.mkdir(path.join(config.publishRoot, ".staging-orphan-slug-1234567890"), { recursive: true });

  const { calls, services: fake } = services();
  const plan = await planPurge(store, fake);

  assert.deepEqual(plan.missingThreads, []);
  assert.deepEqual(plan.workspaces.map((workspace) => workspace.threadId).sort(), ["7009"]);
  assert.deepEqual(plan.workspaces[0]!.sessionIds, ["session-orphan"]);
  assert.deepEqual(plan.repositories.map((repo) => repo.name), ["orphan-repo"]);
  assert.deepEqual(plan.published.map((entry) => path.basename(entry)).sort(), [".staging-orphan-slug-1234567890", "orphan-slug"]);
  assert.deepEqual(plan.accounts, ["push-bbbbbb"]);
  assert.deepEqual(plan.games, ["orphan-game"]);
  assert.deepEqual(plan.usageThreads, ["7009"]);
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(calls, [], "inventory alone never deletes");
});

test("apply removes the planned orphans, retains live resources, and refreshes the index", async () => {
  const live = record("7001", { pushAccountNames: ["push-aaaaaa"], multiplayerGameId: "live-game" });
  const store = await storeWith("apply", [live]);
  await fs.mkdir(live.workspacePath, { recursive: true });
  await fs.mkdir(path.join(config.workspaceRoot, "110"), { recursive: true });
  await fs.mkdir(path.join(config.workspaceRoot, "100", "7009"), { recursive: true });
  await fs.mkdir(path.join(config.publishRoot, live.siteSlug), { recursive: true });
  await fs.mkdir(path.join(config.publishRoot, "orphan-slug"), { recursive: true });
  const { calls, services: fake } = services();
  const plan = await planPurge(store, fake);
  await applyPurge(store, plan, fake);

  assert.deepEqual(calls.sort(), [
    "account:push-bbbbbb", "game:orphan-game", "index",
    "repo:orphan-repo", `sessions:session-orphan`, "usage:7009",
  ]);
  assert.ok(store.getProject("7001"));
  await fs.access(live.workspacePath);
  await fs.access(path.join(config.publishRoot, live.siteSlug));
  await assert.rejects(fs.access(path.join(config.workspaceRoot, "100", "7009")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(config.workspaceRoot, "110")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(config.publishRoot, "orphan-slug")), { code: "ENOENT" });
});

test("missing Discord threads are torn down; transient lookup failures retain their registration", async () => {
  const dead = record("8001");
  const pending = record("8002", { pendingDeletion: { requestedAt: "2026-10-21T00:00:00Z", reason: "thread-delete" } });
  const flaky = record("8003");
  const store = await storeWith("missing", [dead, pending, flaky]);
  const { calls, services: fake } = services({
    thread: async (threadId) => {
      if (threadId === "8001") throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
      if (threadId === "8003") throw new Error("Discord unavailable");
      return { guild_id: "100", type: 11 };
    },
  });
  const plan = await planPurge(store, fake);
  assert.deepEqual(plan.missingThreads.map((project) => project.threadId).sort(), ["8001", "8002"]);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0]!, /8003/);

  await applyPurge(store, plan, fake);
  assert.deepEqual(calls.filter((call) => call.startsWith("project:")).sort(), ["project:8001", "project:8002"]);
});

test("an unavailable inventory aborts the preview instead of treating everything as orphaned", async () => {
  const store = await storeWith("outage", [record("9001")]);
  const { calls, services: fake } = services({ sessions: async () => { throw new Error("agent service down"); } });
  await assert.rejects(planPurge(store, fake), /agent service down/);
  assert.deepEqual(calls, []);
});

test("registered resources created after the preview are retained during apply", async () => {
  const orphan = record("9101");
  const store = await storeWith("recheck", []);
  const { calls, services: fake } = services({
    sessions: async () => [{ id: "session-orphan", directory: path.join(config.workspaceRoot, "100", "9101") }],
    games: async () => ["orphan-game"],
  });
  const plan = await planPurge(store, fake);
  assert.deepEqual(plan.workspaces.map((workspace) => workspace.threadId), ["9101"]);
  await store.putProject(orphan);
  await assert.rejects(applyPurge(store, plan, fake), /retained/);
  assert.ok(store.getProject(orphan.threadId));
  assert.ok(calls.includes("game:orphan-game"), "other orphans still complete");
});

test("gallery card images are never treated as orphaned sites", async () => {
  const live = record("7001");
  const store = await storeWith("gallery", [live]);
  await fs.mkdir(path.join(config.publishRoot, "__gallery"), { recursive: true });
  await fs.writeFile(path.join(config.publishRoot, "__gallery", `${live.siteSlug}.png`), "png");
  await fs.mkdir(path.join(config.publishRoot, "orphan-slug"), { recursive: true });
  const plan = await planPurge(store, services().services);
  assert.ok(plan.published.every((target) => !target.includes("__gallery")), "gallery assets are harness-owned");
  assert.ok(plan.published.some((target) => target.endsWith("orphan-slug")), "real orphan directories are still caught");
});
