import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { testRootSetup, trackStore } from "./fixtures/root.js";
import type { OpenCodeHarness, PromptResult } from "../src/opencode.js";
import type { ProjectRecord } from "../src/types.js";

const root = testRootSetup("reliability");
process.env.BROWSER_QA_ENABLED = "false";
process.env.PUBLIC_SITES_BASE_URL = "https://sites.example.invalid";
const { buildSite, GENERATED_GITIGNORE } = await import("../src/build.js");
const { ensureEnginePackages } = await import("../src/engines.js");
const { ProjectService, TurnStoppedError } = await import("../src/project.js");
const { ForgejoClient } = await import("../src/forgejo.js");
const { Store, pendingTurnMatches } = await import("../src/store.js");
const { UsageLog } = await import("../src/usage.js");
const { config } = await import("../src/config.js");
const { publishSite, validateSite } = await import("../src/publish.js");
const { currentHead, ensureGitRepository, ensureLocalBaseline, commitAndPush, syncToRemote } = await import("../src/git.js");
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
async function openStore(file: string) {
  return trackStore(await Store.open(file));
}

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

test("broken scratch experiments stay outside production builds, validation, Git and publication", async () => {
  const f = await projectFixture("scratch-boundary");
  const experiment = path.join(f.dir, "scratch", "car");
  await fs.mkdir(path.join(experiment, "src"), { recursive: true });
  await fs.writeFile(path.join(experiment, "index.html"), '<script type="module" src="js/main.js"></script>');
  await fs.writeFile(path.join(experiment, "src", "main.ts"), 'const broken = ;');
  await buildSite(f.dir);
  await validateSite(path.join(f.dir, "site"));
  await commitAndPush(f.dir, "Keep scratch local", f.forgejo);
  assert.equal(await git(f.dir, "ls-files", "scratch"), "");
  assert.match(await fs.readFile(path.join(f.dir, ".gitignore"), "utf8"), /^scratch\/$/m);
  assert.match(await fs.readFile(path.join(experiment, "src", "main.ts"), "utf8"), /broken/);
  await publishSite(path.join(f.dir, "site"), f.project.siteSlug);
  await assert.rejects(fs.access(path.join(config.publishRoot, f.project.siteSlug, "scratch")), { code: "ENOENT" });
  await fs.writeFile(path.join(f.dir, "site", "src", "main.ts"), 'import "../../scratch/car/src/main.ts";');
  await assert.rejects(buildSite(f.dir), /Build imports must stay inside/);
});

test("browser findings publish without a repair turn and reach the next agent prompt", async () => {
  const f = await projectFixture("701234567890123456");
  const instructions: string[] = [];
  Object.assign(f.opencode, {
    prompt: async (_dir: string, _session: string, instruction: string) => {
      instructions.push(instruction);
      await fs.writeFile(path.join(f.dir, "site/src/main.ts"), `console.log("qa update ${instructions.length}");`);
      return { text: "Updated", usage: {} };
    },
  });
  let report = { findings: ["ReferenceError: player is not defined at main.js:42"] };
  Object.assign(f.service, { runBrowserQa: async () => report });
  const result = await f.service.mutate(f.project.threadId, "Add a scoreboard");
  assert.equal(result.validationError, undefined);
  assert.equal(result.deliveryError, undefined);
  assert.equal(result.project.status, "ready");
  assert.equal(instructions.length, 1, "advisory browser errors must not trigger an extra repair prompt");
  assert.match(result.browserQaFindings!.join("\n"), /ReferenceError.*main.js:42/);
  assert.match(await fs.readFile(path.join(config.publishRoot, result.project.siteSlug, "js/main.js"), "utf8"), /qa update 1/);
  assert.match(f.store.getProject(f.project.threadId)!.browserQaFindings!.findings![0], /player is not defined/);
  report = { findings: [] };
  const next = await f.service.mutate(f.project.threadId, "Improve the scoreboard");
  assert.match(instructions[1], /BROWSER QA FEEDBACK/);
  assert.match(instructions[1], /Runtime finding: ReferenceError.*main.js:42/);
  assert.match(instructions[1], /already excluded/);
  assert.deepEqual(next.project.browserQaFindings!.findings, []);
  assert.equal(next.browserQaFindings, undefined);
});

test("the play card shows the project's own description and newest changelog entry", async () => {
  const f = await projectFixture("705234567890123456");
  Object.assign(f.opencode, {
    prompt: async () => {
      await fs.writeFile(path.join(f.dir, "site/src/main.ts"), 'console.log("documents turn");');
      await fs.writeFile(path.join(f.dir, "DESCRIPTION.md"),
        "# Koi Pond Arcade\n\nA calm pond where you feed koi.\n\n## How to play\n\nClick the water to drop food.\n", "utf8");
      await fs.writeFile(path.join(f.dir, "CHANGELOG.md"),
        "# Changelog\n\n## Lily pads\n\nAdded lily pads across the pond.\n", "utf8");
      return { text: "Updated", usage: {} };
    },
  });
  const result = await f.service.mutate(f.project.threadId, "Add lily pads");
  assert.match(result.description?.pitch ?? "", /calm pond/);
  assert.match(result.description?.play ?? "", /drop food/);
  assert.match(result.changelog?.body ?? "", /lily pads/);
});

test("fail-open browser QA does not bypass compiler failures or replace the previous live site", async () => {
  const f = await projectFixture("711234567890123456");
  const liveFile = path.join(config.publishRoot, f.project.siteSlug, "js/main.js");
  const previousLive = await fs.readFile(liveFile, "utf8");
  Object.assign(f.opencode, { prompt: async () => {
    await fs.writeFile(path.join(f.dir, "site/src/main.ts"), "export const broken = ;");
    return { text: "Finished", usage: {} };
  } });
  let browserCalls = 0;
  Object.assign(f.service, { runBrowserQa: async () => { browserCalls += 1; return { findings: [] }; } });
  const result = await f.service.mutate(f.project.threadId, "Make an update");
  assert.match(result.validationError ?? "", /TypeScript compile error/);
  assert.equal(browserCalls, 0);
  assert.equal(await fs.readFile(liveFile, "utf8"), previousLive);
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
    repoName: `old-${threadId}`, sessionId: "fake", workspacePath: dir, projectKind: "site", status: "ready", createdAt: now, updatedAt: now };
}

test("queue-only projects recover after reopening; atomic claims preserve overflow and new arrivals", async () => {
  const file = path.join(root, "queue-state.db");
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
  await fs.writeFile(path.join(dir, ".gitignore"), `${GENERATED_GITIGNORE.join("\n")}\n`);
  await ensureGitRepository(dir, project.repoName, forgejo);
  await ensureLocalBaseline(dir);
  const base = await currentHead(dir);
  await fs.writeFile(path.join(dir, "site/src/main.ts"), 'console.log("accepted turn");');
  await commitAndPush(dir, "Accepted agent turn", forgejo);
  const head = await currentHead(dir);
  Object.assign(project, { lastCommit: head.slice(0, 10), lastSeenCommit: head, lastTurnBaseCommit: base });
  const store = await openStore(path.join(root, `state-${id}.db`));
  await store.putProject(project);
  const opencode = { isBusy: async () => false, lastUserMessageId: async () => "message", revertSession: async () => {} } as unknown as OpenCodeHarness;
  const usage = new UsageLog(path.join(root, `usage-${id}.jsonl`));
  const service = new ProjectService(store, opencode, forgejo, usage);
  await buildSite(dir);
  await validateSite(path.join(dir, "site"));
  await publishSite(path.join(dir, "site"), project.siteSlug);
  return { dir, project, store, service, forgejo, opencode, usage, base };
}

test("sync rejects broken remote changes and restores the pre-sync workspace and live site", async () => {
  const f = await projectFixture("sync-rollback");
  const acceptedHead = await currentHead(f.dir);
  const liveFile = path.join(config.publishRoot, f.project.siteSlug, "js/main.js");
  const previousLive = await fs.readFile(liveFile, "utf8");
  const external = await workspace("sync-external");
  await ensureGitRepository(external, f.project.repoName, f.forgejo);
  // The empty external checkout starts clean before adopting the remote tree.
  await fs.rm(path.join(external, "site"), { recursive: true });
  await syncToRemote(external, f.forgejo);
  await fs.writeFile(path.join(external, "site/src/main.ts"), "export const broken = ;");
  const pushed = await commitAndPush(external, "Broken external change", f.forgejo);
  assert.ok(pushed);

  const result = await f.service.sync(f.project.threadId);
  assert.match(result.validationError ?? "", /TypeScript compile error/);
  assert.equal(await currentHead(f.dir), acceptedHead);
  assert.equal(await fs.readFile(path.join(f.dir, "site/src/main.ts"), "utf8"), 'console.log("accepted turn");');
  assert.equal(await fs.readFile(liveFile, "utf8"), previousLive);
  assert.equal(f.store.getProject(f.project.threadId)!.lastSeenCommit?.slice(0, 10), pushed.commit);

  await fs.writeFile(path.join(external, "site/src/main.ts"), 'console.log("repaired external change");');
  const repaired = await commitAndPush(external, "Repair external change", f.forgejo);
  assert.ok(repaired);
  const retry = await f.service.sync(f.project.threadId);
  assert.equal(retry.validationError, undefined);
  assert.equal(retry.project.status, "ready");
  assert.equal((await currentHead(f.dir)).slice(0, 10), repaired.commit);
  assert.match(await fs.readFile(liveFile, "utf8"), /repaired external change/);
});


test("a preparation failure without a turn marker preserves its error and releases active bookkeeping", async () => {
  const f = await projectFixture("early-preparation-failure");
  const failure = new Error("Preparing the progress card failed");
  await assert.rejects(f.service.mutate(f.project.threadId, "Add a button", false, () => { throw failure; }),
    (error) => error === failure);
  assert.equal(f.store.getProject(f.project.threadId)!.pendingTurn, undefined);
  assert.equal((await f.service.stopTurn(f.project.threadId)).stopped, false);
});

test("a stop during failed preparation is settled without requiring a turn marker", async () => {
  const f = await projectFixture("early-preparation-stop");
  await assert.rejects(f.service.mutate(f.project.threadId, "Add a button", false, async () => {
    assert.equal((await f.service.stopTurn(f.project.threadId)).stopped, true);
    throw new Error("Preparation interrupted");
  }), (error) => error instanceof TurnStoppedError);
  const project = f.store.getProject(f.project.threadId)!;
  assert.equal(project.pendingTurn, undefined);
  assert.equal(project.status, "ready");
  assert.equal((await f.service.stopTurn(f.project.threadId)).stopped, false);
});

test("renames refresh both URLs, preserve old subpage links, and revert the whole agent turn", async () => {
  const f = await projectFixture("rename1");
  const old = f.project.siteSlug;
  await fs.mkdir(path.join(config.publishRoot, old, "about"));
  await fs.writeFile(path.join(config.publishRoot, old, "about/index.html"), "old subpage");
  const renamed = await f.service.renameProject(f.project.threadId, "Sumo Shove");
  assert.equal(renamed.siteSlug, "sumo-shove");
  assert.equal(renamed.repoName, "sumo-shove");
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

test("README.md carries the original request, submitter and agent README through turns, rename and revert", async () => {
  const f = await projectFixture("readme");
  await f.store.patchProject(f.project.threadId, {
    initialPrompt: "Build a **koi pond** arcade with a literal ``` fence.",
    starterName: "Ada Lovelace",
  });
  f.opencode.prompt = async () => {
    await fs.writeFile(path.join(f.dir, "site/src/main.ts"), 'console.log("readme v1");');
    await fs.writeFile(path.join(f.dir, "README.agent.md"), "## About\n\nFeed the koi.\n", "utf8");
    return { text: "Built the pond", usage: {} };
  };
  const first = await f.service.mutate(f.project.threadId, "Build the koi pond");
  assert.equal(first.deliveryError, undefined);
  const readme = await fs.readFile(path.join(f.dir, "README.md"), "utf8");
  assert.match(readme, /maintained by the ThreadSite harness\./);
  assert.match(readme, /## Original request/);
  assert.match(readme, /Requested by Ada Lovelace\./);
  assert.ok(readme.includes("````\nBuild a **koi pond** arcade with a literal ``` fence.\n````"), "the prompt is safe inside a fence longer than its own backticks");
  assert.match(readme, /## About\n\nFeed the koi\./);
  assert.match(await git(f.dir, "show", "HEAD:README.agent.md"), /Feed the koi/);

  f.opencode.prompt = async () => {
    await fs.writeFile(path.join(f.dir, "README.md"), "direct edit must lose");
    await fs.writeFile(path.join(f.dir, "README.agent.md"), "## About\n\nRide the koi.\n", "utf8");
    await fs.writeFile(path.join(f.dir, "site/src/main.ts"), 'console.log("readme v2");');
    return { text: "Updated the pond", usage: {} };
  };
  const second = await f.service.mutate(f.project.threadId, "Update the readme");
  assert.equal(second.deliveryError, undefined);
  const updated = await fs.readFile(path.join(f.dir, "README.md"), "utf8");
  assert.doesNotMatch(updated, /direct edit must lose/);
  assert.match(updated, /Ride the koi\./);
  assert.doesNotMatch(updated, /Feed the koi\./);

  const renamed = await f.service.renameProject(f.project.threadId, "Koi Pond Deluxe");
  assert.equal(renamed.siteSlug, "koi-pond-deluxe");
  const renamedReadme = await fs.readFile(path.join(f.dir, "README.md"), "utf8");
  assert.match(renamedReadme, /Requested by Ada Lovelace\./);
  assert.match(renamedReadme, /Ride the koi\./);
  assert.match(renamedReadme, /koi-pond-deluxe/);

  const reverted = await f.service.revert(f.project.threadId);
  assert.ok(reverted.undoneCommit);
  const revertedReadme = await fs.readFile(path.join(f.dir, "README.md"), "utf8");
  assert.match(revertedReadme, /Requested by Ada Lovelace\./);
  assert.match(revertedReadme, /Feed the koi\./);
  assert.doesNotMatch(revertedReadme, /Ride the koi\./);
  assert.match(revertedReadme, /koi-pond-deluxe/);
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
  const reopened = await openStore(path.join(root, "state-retry1.db"));
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


test("mutate claims queued work durably before the agent starts", async () => {
  const f = await projectFixture("claim");
  await f.store.appendQueuedRequest(f.project.threadId, { prompt: "change it", statusMessageId: "original-status" });
  await f.store.appendQueuedRequest(f.project.threadId, { prompt: "next pass", statusMessageId: "overflow-status" });
  let started = false;
  f.opencode.prompt = async (): Promise<PromptResult> => {
    const restarted = await openStore(path.join(root, "state-claim.db"));
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
    initialPrompt: "Make a garden", renameable: true, infoMessageId: "card-message",
    initiator: { name: "Ada Lovelace", email: "ada@users.noreply.example" },
  }, undefined, async (title) => { titles.push(title); });
  assert.deepEqual(titles, ["Fresh Garden"]);
  assert.equal(result.project.displayName, "Fresh Garden");
  assert.equal(result.project.siteSlug, "fresh-garden");
  assert.equal(result.project.repoName, "fresh-garden");
  assert.equal(result.commit, (await currentHead(workspacePath)).slice(0, 10));
  assert.match(service.siteLink(result.project), /\/fresh-garden\/$/);
  assert.match(service.repoLink(result.project), /\/fresh-garden$/);
  // The pinned project card stays linked to the original request.
  const saved = store.getProject("123456789012345678")!;
  assert.equal(saved.infoMessageId, "card-message");
  assert.equal(saved.initialPrompt, "Make a garden");
  assert.equal(saved.starterName, "Ada Lovelace");
  const readme = await fs.readFile(path.join(workspacePath, "README.md"), "utf8");
  assert.match(readme, /Requested by Ada Lovelace\./);
  assert.match(readme, /Make a garden/);
});

test("a resumed initial build falls back to a different title model and updates all identities", async () => {
  const f = await projectFixture("resumed-title");
  await f.store.setModel("test/primary");
  const startedAt = new Date(Date.now() - 5_000).toISOString();
  await f.store.patchProject(f.project.threadId, {
    displayName: "game-temporary-request", initialPrompt: "Build a neon drifting game",
    pendingNaming: { request: "Build a neon drifting game" },
    pendingTurn: { id: "resumed-initial", prompt: "Build a neon drifting game", initial: true, startedAt },
  });
  await fs.writeFile(path.join(f.dir, "site/src/main.ts"), 'console.log("finished while bot was down");');
  const attempts: Array<string | undefined> = [];
  Object.assign(f.opencode, {
    health: async () => "ok (200)", watchExistingTurn: async () => async () => {}, listPendingQuestions: async () => [],
    listMessages: async () => [{ info: { id: "finished", role: "assistant", finish: "stop", time: { created: Date.now(), completed: Date.now() } } }],
    listSelectableModels: async () => ["test/primary", "test/backup"],
    generateTitle: async (_directory: string, _request: string, model?: string) => {
      attempts.push(model);
      if (model === "test/primary") throw new Error("primary model unavailable");
      return { title: "Neon Drift", usage: {} };
    },
  });
  const reopened = await openStore(path.join(root, "state-resumed-title.db"));
  const titles: string[] = [];
  const restarted = new ProjectService(reopened, f.opencode, f.forgejo, f.usage, async (project, title) => {
    assert.equal(project.repoName, "neon-drift");
    assert.equal(project.siteSlug, "neon-drift");
    titles.push(title);
  });
  const result = await restarted.recoverTurn(f.project.threadId);
  assert.equal(result.deliveryError, undefined);
  assert.deepEqual(attempts, ["test/primary", "test/backup"]);
  assert.deepEqual(titles, ["Neon Drift"]);
  assert.equal(result.project.displayName, "Neon Drift");
  assert.equal(result.project.repoName, "neon-drift");
  assert.equal(result.project.pendingNaming, undefined);
  assert.equal(result.project.pendingThreadName, undefined);
  assert.match(await git(f.dir, "remote", "get-url", "origin"), /neon-drift\.git$/);
  assert.match(await fs.readFile(path.join(config.publishRoot, "neon-drift/index.html"), "utf8"), /script/);
  assert.match(await fs.readFile(path.join(config.publishRoot, f.project.siteSlug, "index.html"), "utf8"), /neon-drift/);
});

test("a failed Discord rename blocks the next prompt and retries after restart without losing partial edits", async () => {
  const f = await projectFixture("rename-barrier");
  const partial = 'console.log("keep my partial changes");';
  await fs.writeFile(path.join(f.dir, "site/src/main.ts"), partial);
  await git(f.dir, "add", "site/src/main.ts");
  await fs.writeFile(path.join(f.dir, "site/src/unfinished.ts"), "export const incomplete = ;");
  await f.store.patchProject(f.project.threadId, { status: "error", displayName: "site-placeholder",
    pendingNaming: { request: "Build a garden", name: "Persistent Garden" } });
  let prompts = 0;
  f.opencode.prompt = async () => { prompts++; throw new Error("must not prompt yet"); };
  const unavailable = new ProjectService(f.store, f.opencode, f.forgejo, f.usage, async () => { throw new Error("Discord unavailable"); });
  await assert.rejects(unavailable.mutate(f.project.threadId, "finish it"), /Discord unavailable/);
  assert.equal(prompts, 0);
  assert.equal(await fs.readFile(path.join(f.dir, "site/src/main.ts"), "utf8"), partial);
  assert.equal(await git(f.dir, "show", ":site/src/main.ts"), partial);
  assert.equal(await git(f.dir, "show", "HEAD:site/src/main.ts"), 'console.log("accepted turn");');
  assert.match(await fs.readFile(path.join(config.publishRoot, "persistent-garden/js/main.js"), "utf8"), /accepted turn/);
  const reopened = await openStore(path.join(root, "state-rename-barrier.db"));
  assert.equal(reopened.listRecoveryProjects()[0].pendingThreadName, "Persistent Garden");
  let discordUpdated = false;
  const restarted = new ProjectService(reopened, f.opencode, f.forgejo, f.usage, async () => { discordUpdated = true; });
  f.opencode.prompt = async () => {
    prompts++;
    assert.ok(discordUpdated);
    assert.equal(reopened.getProject(f.project.threadId)!.pendingNaming, undefined);
    assert.equal(reopened.getProject(f.project.threadId)!.pendingThreadName, undefined);
    assert.equal(await fs.readFile(path.join(f.dir, "site/src/main.ts"), "utf8"), partial);
    await fs.writeFile(path.join(f.dir, "site/src/unfinished.ts"), "export const complete = true;");
    return { text: "Finished", usage: {} } as PromptResult;
  };
  const result = await restarted.mutate(f.project.threadId, "finish it");
  assert.equal(prompts, 1);
  assert.equal(result.project.repoName, "persistent-garden");
  assert.equal(result.deliveryError, undefined);
});


test("all title models failing still produces a durable readable name", async () => {
  const f = await projectFixture("fallback-title");
  await f.store.setModel("test/primary");
  await f.store.patchProject(f.project.threadId, { displayName: "game-placeholder",
    initialPrompt: "Build a midnight drift racing game", pendingNaming: { request: "Build a midnight drift racing game" } });
  assert.equal(f.store.listRecoveryProjects()[0].threadId, f.project.threadId, "pending naming must survive recovery");
  const models: Array<string | undefined> = [];
  Object.assign(f.opencode, {
    listSelectableModels: async () => ["test/primary", "test/backup"],
    generateTitle: async (_dir: string, _request: string, model?: string) => { models.push(model); throw new Error("model unavailable"); },
  });
  const named = await f.service.ensureProjectName(f.project.threadId);
  assert.deepEqual(models, ["test/primary", "test/backup"]);
  assert.equal(named.displayName, "Midnight Drift Racing Game");
  assert.equal(named.repoName, "midnight-drift-racing-game");
  await f.service.ensureProjectName(f.project.threadId);
  assert.equal(models.length, 2, "a retry must retain the chosen name");
});

test("webhook outages do not block project creation or leave renames pending", async () => {
  const store = await openStore(path.join(root, "webhook-outage.db"));
  await store.ensureWebhookSecret();
  const forgejo = new LocalForgejo();
  let hookAttempts = 0;
  forgejo.ensurePushWebhook = async () => {
    hookAttempts += 1;
    throw new Error("Forgejo webhook creation failed (404)");
  };
  let projectWorkspace = "";
  const opencode = {
    createSession: async (dir: string) => { projectWorkspace = dir; return "session"; },
    isBusy: async () => false,
    prompt: async () => {
      await fs.writeFile(path.join(projectWorkspace, "site/src/main.ts"), 'console.log("published despite missing hook");');
      return { text: "Finished", usage: {} };
    },
  } as unknown as OpenCodeHarness;
  const service = new ProjectService(store, opencode, forgejo, new UsageLog(path.join(root, "webhook-outage-usage.jsonl")));
  const result = await service.createProject({
    threadId: "123456789012345679", guildId: "100", parentChannelId: "200", displayName: "Hook Outage Project",
    initialPrompt: "Make a small site",
  });
  assert.equal(result.project.status, "ready");
  assert.ok(result.commit);
  const renamed = await service.renameProject(result.project.threadId, "Renamed During Hook Outage");
  assert.equal(renamed.pendingRename, undefined);
  assert.equal(renamed.repoName, "renamed-during-hook-outage");
  assert.ok(hookAttempts >= 2);
  await fs.access(path.join(config.publishRoot, renamed.siteSlug, "index.html"));
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
    pendingTurn: { id: "paint-turn", prompt: "Paint the arena", initial: false, startedAt: new Date(Date.now() - 60_000).toISOString(), statusMessageId: "status" },
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
    pendingTurn: { id: "stuck-turn", prompt: "Stuck turn", initial: false, startedAt: new Date().toISOString(), statusMessageId: "status" },
  });
  try {
    await assert.rejects(f.service.recoverTurn(f.project.threadId), /stopped making progress/i);
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
      id: "fog-turn", prompt: "Add fog of war", initial: false, beforeCommit: f.base,
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

test("restart recovery restores saved tokens and flushes the ledger before clearing the pending marker", async () => {
  const f = await projectFixture("usage-recovery");
  const startedAt = new Date(Date.now() - 30_000).toISOString();
  const pending = { id: "durable-turn", prompt: "Add fog", initial: false, startedAt };
  await f.store.patchProject(f.project.threadId, { pendingTurn: pending });
  await f.usage.record({ id: pending.id, pending: true, sessionId: f.project.sessionId, startedAt,
    threadId: f.project.threadId, project: f.project.displayName, kind: "site" });
  const messages = [{ info: { id: "completed", role: "assistant", agent: "sitebuilder", finish: "stop",
    providerID: "test", modelID: "model", tokens: { input: 1234, output: 456 }, cost: 0,
    time: { created: Date.now() - 20_000, completed: Date.now() - 10_000 } }, parts: [] }];
  Object.assign(f.opencode, {
    health: async () => "ok (200)", watchExistingTurn: async () => async () => {},
    isBusy: async () => false, listMessages: async () => messages, usageMessages: async () => messages,
    prompt: async () => { throw new Error("Completed work must not be prompted again"); },
  });
  const patch = f.store.patchProject.bind(f.store);
  let checked = false;
  f.store.patchProject = async (threadId, changes) => {
    if (Object.hasOwn(changes, "pendingTurn") && changes.pendingTurn === undefined) {
      const total = await f.usage.threadTotal(threadId);
      assert.equal(total.turns, 1);
      assert.equal(total.inputTokens, 1234);
      checked = true;
    }
    return patch(threadId, changes);
  };
  const result = await f.service.recoverTurn(f.project.threadId);
  assert.ok(checked);
  assert.equal(result.usage!.outputTokens, 456);
  assert.equal(f.store.getProject(f.project.threadId)!.pendingTurn, undefined);
  assert.equal(await f.service.reconcileProjectUsage(f.project.threadId), false);
  assert.equal((await f.usage.threadTotal(f.project.threadId)).turns, 1);
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

test("switching multiplayer rewrites the wiring and runs a question-first agent turn", async () => {
  const f = await projectFixture("mp-switch");
  await f.store.patchProject(f.project.threadId, { projectKind: "game-2d", multiplayerMode: "arena" });
  let instruction = "";
  Object.assign(f.opencode, {
    isBusy: async () => false,
    prompt: async (_dir: string, _session: string, text: string) => {
      instruction = text;
      await fs.writeFile(path.join(f.dir, "site/src/main.ts"), 'console.log("rewired netcode");');
      return { text: "Rewired", usage: {} } as PromptResult;
    },
  });
  const result = await f.service.switchMultiplayer(f.project.threadId, "rooms", "status-1");
  assert.ok(result.commit, "the rewrite landed and was committed");
  assert.equal(f.store.getProject(f.project.threadId)!.multiplayerMode, "rooms");
  // The turn's instruction is the swap directive: investigate, ask, rewrite.
  assert.match(instruction, /switched from shared-arena multiplayer to invite-code rooms/);
  assert.match(instruction, /MUST call the question tool/);
  // Harness wiring followed the new mode before the agent ran.
  assert.match(await fs.readFile(path.join(f.dir, "AGENTS.md"), "utf8"), /Session mode — rooms/);
  assert.ok(await fs.access(path.join(f.dir, "site/net/net-config.js")).then(() => true, () => false), "net config is in place for rooms");

  // Going singleplayer removes the wiring outright — net dir and guide gone.
  instruction = "";
  await f.service.switchMultiplayer(f.project.threadId, "singleplayer", "status-2");
  assert.equal(f.store.getProject(f.project.threadId)!.multiplayerMode, "singleplayer");
  assert.match(instruction, /no networking at all/);
  await assert.rejects(fs.access(path.join(f.dir, "site/net")));
  await assert.rejects(fs.access(path.join(f.dir, "NETWORKING.md")));
  assert.match(await fs.readFile(path.join(f.dir, "AGENTS.md"), "utf8"), /## Singleplayer only/);

  // Switching to the mode a game already runs is rejected without a turn.
  await assert.rejects(f.service.switchMultiplayer(f.project.threadId, "singleplayer", "status-3"), /already runs singleplayer only/);
});

test("only a reply to the running turn's status message steers the live session", async () => {
  const f = await projectFixture("steer");
  let releasePrompt!: (value: PromptResult) => void;
  let busy = false;
  const instructions: string[] = [];
  const harness = Object.assign(f.opencode, {
    isBusy: async () => busy,
    prompt: () => { busy = true; return new Promise<PromptResult>((resolve) => { releasePrompt = resolve; }); },
    steer: async (_directory: string, _session: string, instruction: string) => { instructions.push(instruction); return busy; },
  });
  const service = new ProjectService(f.store, harness, f.forgejo, f.usage);

  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // Idle thread: nothing to steer.
  assert.equal(await service.steerActiveTurn(f.project.threadId, "nope", "status"), false);

  const turning = service.mutate(f.project.threadId, "Add snow tiles", false, undefined, undefined, "status").then(
    (result) => result,
    (error: unknown) => error,
  );
  while (!releasePrompt) await settle();
  // Ordinary messages and replies to other messages queue instead of steering.
  assert.equal(await service.steerActiveTurn(f.project.threadId, "make the snow ice-blue"), false);
  assert.equal(await service.steerActiveTurn(f.project.threadId, "make the snow ice-blue", "another-message"), false);
  // A reply to the running turn's status message goes straight into the busy session.
  assert.equal(await service.steerActiveTurn(f.project.threadId, "make the snow ice-blue", "status"), true);
  assert.equal(instructions.length, 1);
  assert.match(instructions[0], /make the snow ice-blue/);

  // The steered turn itself completes normally through the whole pipeline.
  busy = false;
  releasePrompt({ text: "Snow added with the steering folded in.", usage: {} as PromptResult["usage"] });
  const result = await turning;
  if (result instanceof Error) throw result;
  assert.ok(result.commit || result.noChanges);

  // Once the turn settles there is nothing running to steer.
  assert.equal(await service.steerActiveTurn(f.project.threadId, "late", "status"), false);
});

test("modelBreakdown rolls up per-model usage globally and per thread", async () => {
  const usage = new UsageLog(path.join(root, "models-breakdown-usage.jsonl"));
  await usage.record({ threadId: "t1", project: "Koi Pond", kind: "game-2d", usage: { models: [{ model: "surplus/glm-5.3-flash", inputTokens: 100, outputTokens: 10, cacheTokens: 0, cost: 0 }] } as never });
  await usage.record({ threadId: "t1", project: "Koi Pond", kind: "game-2d", usage: { models: [{ model: "opencode/muse-spark-1.3-contributor-free", inputTokens: 50, outputTokens: 5, cacheTokens: 0, cost: 0 }] } as never });
  await usage.record({ threadId: "t2", project: "Sumo Shove", kind: "game-2d", failed: true, usage: { models: [{ model: "surplus/glm-5.3-flash", inputTokens: 20, outputTokens: 2, cacheTokens: 0, cost: 0 }] } as never });
  const breakdown = await usage.modelBreakdown();
  assert.deepEqual(breakdown.models.map((model) => model.model), ["surplus/glm-5.3-flash", "opencode/muse-spark-1.3-contributor-free"]);
  assert.equal(breakdown.models[0].turns, 2);
  assert.deepEqual(breakdown.threads.map((thread) => thread.project), ["Koi Pond", "Sumo Shove"]);
  assert.deepEqual(breakdown.threads[0].models.map((model) => model.model), ["surplus/glm-5.3-flash", "opencode/muse-spark-1.3-contributor-free"]);
});
