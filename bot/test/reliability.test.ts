import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-reliability-"));
process.env.DISCORD_BOT_TOKEN = "test";
process.env.DISCORD_APPLICATION_ID = "test";
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.PUBLISH_ROOT = path.join(root, "published");
process.env.LOG_FILE = path.join(root, "test.log");
process.env.BROWSER_QA_ENABLED = "false";
process.env.PUBLIC_SITES_BASE_URL = "https://sites.example.invalid";
const { buildSite } = await import("../src/build.js");
const { ensureEnginePackages } = await import("../src/engines.js");
const { ProjectService, TurnStoppedError } = await import("../src/project.js");
const { ForgejoClient } = await import("../src/forgejo.js");
const { Store, pendingTurnMatches } = await import("../src/store.js");
const { UsageLog } = await import("../src/usage.js");
const { config } = await import("../src/config.js");
const { publishSite, validateSite } = await import("../src/publish.js");
const { currentHead, ensureGitRepository, ensureLocalBaseline, commitAndPush, turnRevertTarget } = await import("../src/git.js");
import type { OpenCodeHarness, PromptResult } from "../src/opencode.js";
import type { ProjectRecord } from "../src/types.js";
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
const stores: InstanceType<typeof Store>[] = [];
async function openStore(file: string) {
  const store = await Store.open(file);
  stores.push(store);
  return store;
}
after(async () => {
  for (const store of stores) store.close();
  // Windows transiently reports ENOTEMPTY/EBUSY while git/index handles close;
  // without retries the cleanup itself fails the suite.
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function workspace(name: string): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, "site/src"), { recursive: true });
  await fs.writeFile(path.join(dir, "site/index.html"), '<html><body><script type="module" src="js/main.js"></script></body></html>');
  await fs.writeFile(path.join(dir, "site/src/main.ts"), 'console.log("baseline");');
  return dir;
}

test("production rejects external JSON even through a vendored transitive import", async () => {
  const dir = await workspace("escape");
  await fs.mkdir(path.join(dir, "site/assets"));
  await fs.writeFile(path.join(root, "fake-secret.json"), '{"secret":"PRIVATE_TEST_MARKER"}');
  await fs.writeFile(path.join(dir, "site/assets/vendor.js"), 'import value from "../../../fake-secret.json"; export const secret = value.secret;');
  await fs.writeFile(path.join(dir, "site/src/main.ts"), 'import { secret } from "../assets/vendor.js"; console.log(secret);');
  await assert.rejects(buildSite(dir), /Build imports must stay inside/);
  await assert.rejects(fs.access(path.join(dir, "site/js/main.js")), { code: "ENOENT" });
});

test("production rejects absolute and sibling-project imports", async () => {
  const dir = await workspace("absolute-escape");
  const sibling = await workspace("sibling");
  for (const specifier of [path.join(sibling, "site/src/main.ts").replaceAll("\\", "/"), "../../../sibling/site/src/main.ts"]) {
    await fs.writeFile(path.join(dir, "site/src/main.ts"), `import ${JSON.stringify(specifier)};`);
    await assert.rejects(buildSite(dir), /Build imports must stay inside/);
  }
});

test("production accepts local modules and the real seeded engine package graph", async () => {
  const dir = await workspace("engine");
  await ensureEnginePackages(dir, "game-3d");
  await fs.writeFile(path.join(dir, "site/src/main.ts"), 'import * as THREE from "three"; import { MeshBVH } from "three-mesh-bvh"; console.log(new THREE.Vector3(), MeshBVH);');
  assert.ok((await buildSite(dir)).emitted > 0);
});

test("production rejects symlinked imports and output directories", async () => {
  const outside = path.join(root, "linked-files");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.js"), 'export const secret = "PRIVATE_TEST_MARKER";');
  for (const output of [false, true]) {
    const dir = await workspace(`links-${output}`);
    const destination = path.join(dir, output ? "site/js" : "site/assets");
    await fs.symlink(outside, destination, process.platform === "win32" ? "junction" : "dir");
    if (!output) await fs.writeFile(path.join(dir, "site/src/main.ts"), 'import { secret } from "../assets/secret.js"; console.log(secret);');
    await assert.rejects(buildSite(dir), /symlinks/);
  }
});

test("production refuses nested output links before writing generated chunks", async () => {
  const dir = await workspace("nested-output-link");
  const outside = path.join(root, "outside-chunks");
  await fs.mkdir(outside);
  await fs.mkdir(path.join(dir, "site/js"));
  await fs.symlink(outside, path.join(dir, "site/js/chunks"), process.platform === "win32" ? "junction" : "dir");
  await fs.writeFile(path.join(dir, "site/src/main.ts"), 'import { label } from "./shared.js"; console.log(label);');
  await fs.writeFile(path.join(dir, "site/src/other.ts"), 'import { label } from "./shared.js"; console.log(label);');
  await fs.writeFile(path.join(dir, "site/src/shared.ts"), 'export const label = "shared chunk";');
  await assert.rejects(buildSite(dir), /symlinks/);
  assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(fs.access(path.join(dir, "site/js/main.js")), { code: "ENOENT" });
});

function record(threadId: string, dir: string): ProjectRecord {
  const now = new Date().toISOString();
  return { threadId, guildId: "100", parentChannelId: "200", displayName: "Old Name", siteSlug: `old-${threadId}`,
    repoName: `site-old-${threadId}`, sessionId: "fake", workspacePath: dir, projectKind: "site", status: "ready", createdAt: now, updatedAt: now };
}

test("queue-only projects recover after reopening; atomic claims preserve overflow and new arrivals", async () => {
  const file = path.join(root, "queue-state.json");
  const store = await openStore(file);
  await store.putProject(record("queue", root));
  const image = { mime: "image/png", filename: "reference.png", dataUrl: "data:image/png;base64,eA==" };
  const author = { name: "Requester", email: "requester@example.invalid" };
  await Promise.all([
    store.appendQueuedRequest("queue", { prompt: "first", statusMessageId: "a", images: [image], author }),
    store.appendQueuedRequest("queue", { prompt: "overflow", statusMessageId: "b" }),
  ]);
  let reopened = await openStore(file);
  assert.equal(reopened.listRecoveryProjects()[0].threadId, "queue");
  assert.deepEqual(reopened.getProject("queue")!.pendingQueue![0].images, [image]);
  assert.deepEqual(reopened.getProject("queue")!.pendingQueue![0].author, author);
  await store.startQueuedTurn("queue", { prompt: "first", initial: false, startedAt: new Date().toISOString(), images: [image] }, ["a"]);
  await store.appendQueuedRequest("queue", { prompt: "new arrival", statusMessageId: "c" });
  reopened = await openStore(file);
  assert.equal(reopened.getProject("queue")!.pendingTurn!.prompt, "first");
  assert.deepEqual(reopened.getProject("queue")!.pendingQueue!.map((entry) => entry.statusMessageId), ["b", "c"]);
  assert.deepEqual(reopened.getProject("queue")!.pendingTurn!.images, [image]);
});

test("one queued request can be cancelled without consuming the rest", async () => {
  const file = path.join(root, "cancel-queue.db");
  const store = await openStore(file);
  await store.putProject(record("cancel", root));
  await store.appendQueuedRequest("cancel", { prompt: "first", statusMessageId: "a" });
  await store.appendQueuedRequest("cancel", { prompt: "second", statusMessageId: "b" });
  await store.appendQueuedRequest("cancel", { prompt: "third", statusMessageId: "c" });

  const cancelled = await store.cancelQueuedRequest("cancel", "b");
  assert.equal(cancelled.removed, true);
  assert.equal(cancelled.prompt, "second");
  assert.equal(cancelled.remaining, 2);

  const reopened = await openStore(file);
  assert.deepEqual(reopened.getProject("cancel")!.pendingQueue!.map((entry) => entry.statusMessageId), ["a", "c"]);
  assert.equal((await reopened.cancelQueuedRequest("cancel", "missing")).removed, false);
  assert.equal(reopened.getProject("cancel")!.pendingQueue!.length, 2);
});

test("turn identity survives database reads and rejects a superseding turn", async () => {
  const store = await openStore(path.join(root, "identity.db"));
  await store.putProject(record("identity", root));
  const marker = { id: "turn-one", prompt: "first", initial: false, startedAt: new Date().toISOString() };
  await store.patchProject("identity", { pendingTurn: marker });
  await store.patchProject("identity", { lastError: "unrelated change" });
  assert.ok(pendingTurnMatches(store.getProject("identity")!.pendingTurn, marker));
  await store.patchProject("identity", { pendingTurn: { ...marker, id: "turn-two" } });
  assert.equal(pendingTurnMatches(store.getProject("identity")!.pendingTurn, marker), false);
  assert.equal(pendingTurnMatches(undefined, undefined), false);
});

test("legacy JSON imports once and never replaces newer recovery work on restart", async () => {
  const legacy = path.join(root, "legacy-state.json");
  await fs.writeFile(legacy, JSON.stringify({ version: 1, settings: {}, projects: { legacy: record("legacy", root) } }));
  const store = await openStore(legacy);
  await store.appendQueuedRequest("legacy", { prompt: "new work", statusMessageId: "new-status" });
  const reopened = await openStore(legacy);
  assert.equal(reopened.getProject("legacy")!.pendingQueue![0].prompt, "new work");
});

test("Forgejo rename retries verify repository IDs before adopting a target", async () => {
  const forgejo = new ForgejoClient();
  let targetId = 99;
  let patches = 0;
  (forgejo as unknown as { api: (url: string, init?: RequestInit) => Promise<Response> }).api = async (url, init) => {
    if (init?.method === "PATCH") { patches += 1; return new Response("{}"); }
    if (url.endsWith("/old")) return new Response("", { status: 404 });
    return Response.json({ id: targetId, name: "new" });
  };
  await assert.rejects(forgejo.renameRepository("old", "new", "Description", 1), /already in use/);
  assert.equal(patches, 0);
  targetId = 1;
  await forgejo.renameRepository("old", "new", "Description", 1);
  assert.equal(patches, 1);
});

class LocalForgejo extends ForgejoClient {
  repos = new Map<string, { id: number; name: string }>();
  failAfterRename = false;
  async ensureRepository(name: string): Promise<void> {
    if (this.repos.has(name)) return;
    const repo = { id: this.repos.size + 1, name };
    this.repos.set(name, repo);
    await fs.mkdir(path.join(root, "remotes"), { recursive: true });
    await git(root, "init", "--bare", "-b", "main", this.repoGitUrl(name));
  }
  async repositoryInfo(name: string) { return this.repos.get(name); }
  async renameRepository(from: string, to: string, _description?: string, expectedId?: number): Promise<void> {
    const repo = this.repos.get(from) ?? this.repos.get(to);
    assert.ok(repo);
    assert.equal(repo.id, expectedId);
    if (repo.name !== to) {
      await fs.rename(this.repoGitUrl(repo.name), this.repoGitUrl(to));
      repo.name = to;
      this.repos.set(to, repo);
    }
    if (this.failAfterRename) { this.failAfterRename = false; throw new Error("Simulated disconnect after remote rename"); }
  }
  repoGitUrl(name: string) { return path.join(root, "remotes", `${name}.git`); }
  repoWebUrl(name: string) { return `https://git.example.invalid/${name}`; }
  async gitCredentials() { return { username: "test", token: "test" }; }
  async ensurePushWebhook() {}
}

async function projectFixture(id: string, forgejo = new LocalForgejo()) {
  const dir = await workspace(`project-${id}`);
  const project = record(id, dir);
  await forgejo.ensureRepository(project.repoName);
  await fs.writeFile(path.join(dir, ".gitignore"), "site/js/\nbuild-manifest.json\nnode_modules/\n.opencode/\n");
  await ensureGitRepository(dir, project.repoName, forgejo);
  await ensureLocalBaseline(dir);
  const base = await currentHead(dir);
  await fs.writeFile(path.join(dir, "site/src/main.ts"), 'console.log("accepted turn");');
  await commitAndPush(dir, "Accepted agent turn", forgejo);
  const head = await currentHead(dir);
  Object.assign(project, { lastCommit: head.slice(0, 10), lastSeenCommit: head, lastTurnBaseCommit: base });
  const store = await openStore(path.join(root, `state-${id}.json`));
  await store.putProject(project);
  const opencode = { isBusy: async () => false, lastUserMessageId: async () => "message", revertSession: async () => {} } as unknown as OpenCodeHarness;
  const usage = new UsageLog(path.join(root, `usage-${id}.jsonl`));
  const service = new ProjectService(store, opencode, forgejo, usage);
  await buildSite(dir);
  await validateSite(path.join(dir, "site"));
  await publishSite(path.join(dir, "site"), project.siteSlug);
  return { dir, project, store, service, forgejo, opencode, usage, base };
}

test("renames refresh both URLs, preserve old subpage links, and revert the whole agent turn", async () => {
  const f = await projectFixture("rename1");
  const old = f.project.siteSlug;
  await fs.mkdir(path.join(config.publishRoot, old, "about"));
  await fs.writeFile(path.join(config.publishRoot, old, "about/index.html"), "old subpage");
  const renamed = await f.service.renameProject(f.project.threadId, "Sumo Shove");
  assert.equal(renamed.siteSlug, "sumo-shove");
  assert.equal(renamed.repoName, "site-sumo-shove");
  assert.equal(renamed.lastTurnBaseCommit, f.base);
  assert.equal(renamed.lastCommit, (await currentHead(f.dir)).slice(0, 10));
  assert.equal(renamed.multiplayerGameId, old);
  assert.match(await fs.readFile(path.join(config.publishRoot, old, "index.html"), "utf8"), /sumo-shove\/.*location.search\+location.hash/);
  assert.match(await fs.readFile(path.join(config.publishRoot, old, "about/index.html"), "utf8"), /sumo-shove\/about\//);
  assert.match(await fs.readFile(path.join(config.publishRoot, "index.html"), "utf8"), /sumo-shove/);
  const result = await f.service.revert(f.project.threadId);
  assert.ok(result.undoneCommit);
  assert.match(await fs.readFile(path.join(f.dir, "site/src/main.ts"), "utf8"), /baseline/);
  assert.equal(f.store.getProject(f.project.threadId)!.siteSlug, "sumo-shove");
  assert.match(await fs.readFile(path.join(f.dir, "README.md"), "utf8"), /sumo-shove/);
  assert.match(await fs.readFile(path.join(config.publishRoot, "sumo-shove/js/main.js"), "utf8"), /baseline/);
});

test("concurrent projects choose distinct readable names without overwriting another site", async () => {
  const forgejo = new LocalForgejo();
  const a = await projectFixture("collision1", forgejo);
  const b = await projectFixture("collision2", forgejo);
  await a.store.putProject(b.project);
  const results = await Promise.all([
    a.service.renameProject(a.project.threadId, "Shared Name"),
    a.service.renameProject(b.project.threadId, "Shared Name"),
  ]);
  assert.equal(results[0].siteSlug, "shared-name");
  assert.notEqual(results[0].siteSlug, results[1].siteSlug);
  for (const result of results) assert.ok(await fs.stat(path.join(config.publishRoot, result.siteSlug, "index.html")));
});

test("a rename interrupted after its remote change resumes using persisted intent", async () => {
  const f = await projectFixture("retry1");
  f.forgejo.failAfterRename = true;
  await assert.rejects(f.service.renameProject(f.project.threadId, "Fresh Name"), /Simulated disconnect/);
  const reopened = await openStore(path.join(root, "state-retry1.json"));
  assert.ok(reopened.getProject(f.project.threadId)!.pendingRename);
  assert.equal(reopened.listRecoveryProjects()[0].threadId, f.project.threadId);
  const restarted = new ProjectService(reopened, f.opencode, f.forgejo, f.usage);
  const renamed = await restarted.resumeRename(f.project.threadId);
  assert.equal(renamed.siteSlug, "fresh-name");
  assert.equal(renamed.pendingRename, undefined);
  assert.equal(renamed.lastSeenCommit, await currentHead(f.dir));
  const again = await restarted.renameProject(f.project.threadId, "Even Fresher Name");
  assert.equal(again.siteSlug, "even-fresher-name");
  for (const alias of again.siteAliases!) {
    assert.match(await fs.readFile(path.join(config.publishRoot, alias, "index.html"), "utf8"), /even-fresher-name/);
  }
});

test("older auto-renamed workspaces revert past metadata without a stored turn boundary", async () => {
  const f = await projectFixture("legacy");
  await fs.writeFile(path.join(f.dir, "README.md"), "Renamed metadata");
  await commitAndPush(f.dir, "Rename project to Legacy Title", f.forgejo);
  const result = await turnRevertTarget(f.dir, f.project.lastCommit);
  assert.equal(result.headDrifted, false);
  assert.equal(result.target, f.base);
});

test("mutate claims queued work durably before the agent starts", async () => {
  const f = await projectFixture("claim");
  await f.store.appendQueuedRequest(f.project.threadId, { prompt: "change it", statusMessageId: "original-status" });
  await f.store.appendQueuedRequest(f.project.threadId, { prompt: "next pass", statusMessageId: "overflow-status" });
  let started = false;
  f.opencode.prompt = async (): Promise<PromptResult> => {
    const restarted = await openStore(path.join(root, "state-claim.json"));
    const saved = restarted.getProject(f.project.threadId)!;
    assert.equal(saved.pendingTurn!.prompt, "change it");
    assert.equal(saved.pendingTurn!.statusMessageId, "replacement-status");
    assert.equal(saved.pendingTurn!.beforeCommit, await currentHead(f.dir));
    assert.deepEqual(saved.pendingQueue!.map((entry) => entry.statusMessageId), ["overflow-status"]);
    started = true;
    await fs.writeFile(path.join(f.dir, "site/src/main.ts"), 'console.log("new turn");');
    return { text: "Changed", usage: {} } as PromptResult;
  };
  await f.service.mutate(f.project.threadId, "change it", false, undefined, undefined, "replacement-status", undefined, ["original-status"]);
  assert.ok(started);
  assert.equal(f.store.getProject(f.project.threadId)!.pendingTurn, undefined);
  assert.equal(f.store.getProject(f.project.threadId)!.pendingQueue![0].prompt, "next pass");
});

test("the first successful build adopts the AI name in the returned site and repository links", async () => {
  const store = await openStore(path.join(root, "auto-title.db"));
  const forgejo = new LocalForgejo();
  let workspacePath = "";
  const opencode = {
    createSession: async (dir: string) => { workspacePath = dir; return "session"; },
    generateTitle: async () => ({ title: "Fresh Garden", usage: {} }),
    isBusy: async () => false,
    prompt: async () => {
      await fs.writeFile(path.join(workspacePath, "site/src/main.ts"), 'console.log("fresh garden");');
      return { text: "A fresh garden", usage: {} };
    },
  } as unknown as OpenCodeHarness;
  const service = new ProjectService(store, opencode, forgejo, new UsageLog(path.join(root, "auto-title-usage.jsonl")));
  const titles: string[] = [];
  const result = await service.createProject({
    threadId: "123456789012345678", guildId: "100", parentChannelId: "200", displayName: "site-a-long-original-prompt",
    initialPrompt: "Make a garden", renameable: true,
  }, undefined, async (title) => { titles.push(title); });
  assert.deepEqual(titles, ["Fresh Garden"]);
  assert.equal(result.project.displayName, "Fresh Garden");
  assert.equal(result.project.siteSlug, "fresh-garden");
  assert.equal(result.project.repoName, "site-fresh-garden");
  assert.equal(result.commit, (await currentHead(workspacePath)).slice(0, 10));
  assert.match(service.siteLink(result.project), /\/fresh-garden\/$/);
  assert.match(service.repoLink(result.project), /\/site-fresh-garden$/);
});

test("renaming a game keeps its multiplayer tenant through future builds", async () => {
  const f = await projectFixture("game");
  await f.store.patchProject(f.project.threadId, { projectKind: "game-2d" });
  const renamed = await f.service.renameProject(f.project.threadId, "Neon Arena");
  const netConfig = await fs.readFile(path.join(f.dir, "site/net/net-config.js"), "utf8");
  assert.equal(renamed.multiplayerGameId, f.project.siteSlug);
  assert.ok(netConfig.includes(JSON.stringify(f.project.siteSlug)));
  await f.service.republish(f.project.threadId);
  assert.equal(await fs.readFile(path.join(f.dir, "site/net/net-config.js"), "utf8"), netConfig);
});

test("stopping mid-recovery fails the turn instead of resurrecting it with a fresh prompt", async () => {
  const f = await projectFixture("stop-recovery");
  await f.store.patchProject(f.project.threadId, {
    pendingTurn: { prompt: "Paint the arena", initial: false, startedAt: new Date(Date.now() - 60_000).toISOString(), statusMessageId: "status" },
  });
  let busy = true;
  let prompted = false;
  let aborted = false;
  Object.assign(f.opencode, {
    health: async () => "ok (200)",
    watchExistingTurn: async () => async () => {},
    isBusy: async () => busy,
    listPendingQuestions: async () => [],
    abortTurn: async () => { aborted = true; return true; },
    listMessages: async () => [],
    prompt: async () => { prompted = true; throw new Error("recovery must not prompt after a stop"); },
  });
  // The user presses Stop while the server-side turn is still running.
  const outcome = await f.service.stopTurn(f.project.threadId);
  assert.equal(outcome.stopped, true);
  assert.ok(aborted);
  // The abort makes the session idle; recovery must notice the stop marker at
  // its checkpoint instead of sending a continue prompt for the stopped work.
  busy = false;
  await assert.rejects(f.service.recoverTurn(f.project.threadId), (error: Error) => error instanceof TurnStoppedError);
  assert.equal(prompted, false);
  assert.equal(f.store.getProject(f.project.threadId)!.pendingTurn, undefined);
});

test("the stop button honors a turn that is still preparing", async () => {
  const f = await projectFixture("stop-prep");
  let parked = false;
  let releaseModel!: () => void;
  const modelKnown = new Promise<{ providerID: string; modelID: string }>((resolve) => {
    releaseModel = () => resolve({ providerID: "surplus", modelID: "test-model" });
  });
  let prompted = false;
  Object.assign(f.opencode, {
    isBusy: async () => false, // nothing server-side yet — the turn is preparing
    lastAssistantModel: async () => { parked = true; return modelKnown; },
    modelAcceptsAttachments: async () => true,
    prompt: async () => { prompted = true; throw new Error("a stopped preparing turn must never prompt"); },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const turning = f.service.mutate(
    f.project.threadId, "Add a settings screen", false, undefined, undefined, "status",
    [{ mime: "image/png", dataUrl: "data:image/png;base64,eA==" }],
  ).then(
    () => { throw new Error("mutate must reject when stopped"); },
    (error: unknown) => error,
  );
  while (!parked) await settle();
  // Nothing is busy server-side, but the turn is active: the stop must be
  // accepted and consumed at the turn's pre-prompt checkpoint.
  const outcome = await f.service.stopTurn(f.project.threadId);
  assert.equal(outcome.stopped, true);
  releaseModel();
  const error = await turning;
  assert.ok(error instanceof TurnStoppedError, `expected a user stop, got: ${error}`);
  assert.equal(prompted, false);
  const saved = f.store.getProject(f.project.threadId)!;
  assert.equal(saved.pendingTurn, undefined);
  assert.notEqual(saved.status, "error", "a user stop is not a project failure");
});

test("a recovery wait that outlives the window aborts the orphaned agent turn", async () => {
  const f = await projectFixture("stop-timeout");
  const originalTimeout = config.opencodeReconcileTimeoutMs;
  const originalPoll = config.opencodeReconcilePollMs;
  (config as { opencodeReconcileTimeoutMs: number }).opencodeReconcileTimeoutMs = 250;
  (config as { opencodeReconcilePollMs: number }).opencodeReconcilePollMs = 50;
  let aborted = false;
  Object.assign(f.opencode, {
    health: async () => "ok (200)",
    watchExistingTurn: async () => async () => {},
    isBusy: async () => true, // the orphaned turn never goes idle on its own
    abortTurn: async () => { aborted = true; return true; },
  });
  await f.store.patchProject(f.project.threadId, {
    pendingTurn: { prompt: "Stuck turn", initial: false, startedAt: new Date().toISOString(), statusMessageId: "status" },
  });
  try {
    await assert.rejects(f.service.recoverTurn(f.project.threadId), /kept running past the recovery window/i);
    assert.ok(aborted, "the orphaned server-side turn was aborted, not left burning tokens");
  } finally {
    (config as { opencodeReconcileTimeoutMs: number }).opencodeReconcileTimeoutMs = originalTimeout;
    (config as { opencodeReconcilePollMs: number }).opencodeReconcilePollMs = originalPoll;
  }
});

test("an aborted agent finish is continued by recovery, not committed as complete", async () => {
  const f = await projectFixture("aborted-finish");
  await f.store.patchProject(f.project.threadId, {
    pendingTurn: {
      prompt: "Add fog of war", initial: false, beforeCommit: f.base,
      startedAt: new Date(Date.now() - 30_000).toISOString(), statusMessageId: "status",
    },
  });
  let prompted = false;
  Object.assign(f.opencode, {
    health: async () => "ok (200)",
    watchExistingTurn: async () => async () => {},
    isBusy: async () => false,
    // The session's newest message is the killed turn's partial output: an
    // aborted finish that still carries a completed timestamp.
    listMessages: async () => [{
      info: { id: "msg-1", role: "assistant", agent: "sitebuilder", finish: "aborted", time: { created: Date.now() - 20_000, completed: Date.now() - 10_000 } },
      parts: [{ type: "text", text: "partial work" }],
    }],
    prompt: async () => {
      prompted = true;
      await fs.writeFile(path.join(f.dir, "site/src/main.ts"), 'console.log("continued after abort");');
      return { text: "Continued the aborted turn", usage: {} } as PromptResult;
    },
  });
  const result = await f.service.recoverTurn(f.project.threadId);
  assert.ok(prompted, "recovery continued the aborted work instead of accepting the partials as the result");
  assert.ok(result.commit, "the continued work was committed");
});

test("resetting a thread reports its aborted turn as a user stop, not a failure", async () => {
  const f = await projectFixture("reset-stop");
  let prompted = false;
  let rejectParked!: (error: Error) => void;
  const parked = new Promise<never>((_, reject) => { rejectParked = reject; });
  Object.assign(f.opencode, {
    isBusy: async () => true,
    createSession: async () => "fresh-session",
    stopSessionsInDirectory: async () => ({ sessions: 1, aborted: 1 }),
    prompt: async () => { prompted = true; return parked; },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const turning = f.service.mutate(f.project.threadId, "Add fog of war", false, undefined, undefined, "status").then(
    () => { throw new Error("mutate must reject when reset"); },
    (error: unknown) => error,
  );
  while (!prompted) await settle();
  const reset = await f.service.resetSession(f.project.threadId);
  assert.equal(reset.project.sessionId, "fresh-session");
  assert.equal(reset.stoppedTurn, true);
  // The sweep killed the turn on purpose: it must land as a user stop, not as
  // a project failure with an incident.
  rejectParked(new Error("the session was swept by the reset"));
  const error = await turning;
  assert.ok(error instanceof TurnStoppedError, `expected a user stop, got: ${error}`);
  const saved = f.store.getProject(f.project.threadId)!;
  assert.notEqual(saved.status, "error", "a reset-aborted turn is not a project failure");
});
