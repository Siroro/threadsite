import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { testRootSetup, trackStore } from "./fixtures/root.js";
import type { ForgejoClient } from "../src/forgejo.js";
import type { ProjectRecord } from "../src/types.js";

const root = testRootSetup("hardening");
process.env.BROWSER_QA_ENABLED = "false";
process.env.PUBLIC_SITES_BASE_URL = "https://sites.example.invalid";

const { Store } = await import("../src/store.js");
const { publishSite, publishSiteRedirects, recoverPublishRoot } = await import("../src/publish.js");
const { syncToRemote } = await import("../src/git.js");
const { startWebhookServer } = await import("../src/webhook.js");
const { config } = await import("../src/config.js");

const exec = promisify(execFile);

async function openStore(file: string) {
  return trackStore(await Store.open(file));
}

function record(threadId: string, dir: string, extra: Partial<ProjectRecord> = {}): ProjectRecord {
  const now = new Date().toISOString();
  return {
    threadId, guildId: "100", parentChannelId: "200", displayName: "Project",
    siteSlug: `site-${threadId}`, repoName: `repo-${threadId}`, sessionId: "fake",
    workspacePath: dir, projectKind: "site", status: "ready", createdAt: now, updatedAt: now,
    ...extra,
  };
}

test("adopting an external push refuses to discard uncommitted turn edits", async () => {
  const dir = path.join(root, "dirty");
  await fs.mkdir(dir, { recursive: true });
  await exec("git", ["init", "-b", "main"], { cwd: dir });
  await exec("git", ["config", "user.email", "bot@example.invalid"], { cwd: dir });
  await exec("git", ["config", "user.name", "Bot"], { cwd: dir });
  await fs.writeFile(path.join(dir, "tracked.txt"), "committed\n");
  await exec("git", ["add", "-A"], { cwd: dir });
  await exec("git", ["commit", "-m", "baseline"], { cwd: dir });

  // A failed turn leaves the agent's work uncommitted; adopting must not eat it.
  await fs.writeFile(path.join(dir, "agent-work.txt"), "partial edits\n");
  await assert.rejects(syncToRemote(dir, {} as ForgejoClient), /uncommitted changes/i);
  assert.equal(await fs.readFile(path.join(dir, "agent-work.txt"), "utf8"), "partial edits\n");

  // A clean tree still proceeds to the remote work (which fails here: no
  // origin), proving the guard is the only thing that stopped it before.
  await fs.rm(path.join(dir, "agent-work.txt"));
  await assert.rejects(syncToRemote(dir, { gitCredentials: async () => ({ username: "u", token: "t" }) } as unknown as ForgejoClient), (error: Error) => !/uncommitted changes/i.test(error.message));
});

test("queue entries are released when a turn fails before claiming them", async () => {
  const store = await openStore(path.join(root, "release.db"));
  await store.putProject(record("release", root));
  await store.appendQueuedRequest("release", { prompt: "first", statusMessageId: "a" });
  await store.appendQueuedRequest("release", { prompt: "second", statusMessageId: "b" });
  await store.appendQueuedRequest("release", { prompt: "unrelated", statusMessageId: "c" });

  await store.dropQueuedRequests("release", ["a", "b"]);
  assert.deepEqual(store.getProject("release")!.pendingQueue!.map((entry) => entry.statusMessageId), ["c"]);
  // Dropping nothing is a no-op, and dropping the last entry clears the queue.
  await store.dropQueuedRequests("release", ["missing"]);
  assert.equal(store.getProject("release")!.pendingQueue!.length, 1);
  await store.dropQueuedRequests("release", ["c"]);
  assert.equal(store.getProject("release")!.pendingQueue, undefined);
  assert.deepEqual(store.listRecoveryProjects(), []);
});

async function siteTree(name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(root, name);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(dir, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }
  return dir;
}

async function publishRootEntries(): Promise<string[]> {
  return (await fs.readdir(config.publishRoot)).sort();
}

test("a successful publish leaves no staging or backup directories behind", async () => {
  const siteDir = await siteTree("clean-site", {
    "index.html": '<!doctype html><html><body><script type="module" src="js/main.js"></script></body></html>',
    "js/main.js": 'console.log("hi");',
  });
  await publishSite(siteDir, "clean");
  assert.deepEqual(await publishRootEntries(), ["clean"]);
  assert.equal(await fs.readFile(path.join(config.publishRoot, "clean/index.html"), "utf8").then((html) => html.includes("js/main.js?v=")), true);
});

test("boot recovery restores a site whose publish died between the two renames", async () => {
  await fs.mkdir(config.publishRoot, { recursive: true });
  // The crash signature: live dir missing, content stranded in .backup-*.
  await fs.mkdir(path.join(config.publishRoot, ".backup-stranded-abc1234567/index.html"), { recursive: true });
  await fs.writeFile(path.join(config.publishRoot, ".backup-stranded-abc1234567/index.html/keep.txt"), "live content");
  await fs.mkdir(path.join(config.publishRoot, ".staging-stranded-abc1234567"), { recursive: true });
  await fs.writeFile(path.join(config.publishRoot, ".staging-stranded-abc1234567/half.txt"), "half-built");
  // A backup whose live directory still exists is just leftover garbage.
  await fs.mkdir(path.join(config.publishRoot, "intact"), { recursive: true });
  await fs.mkdir(path.join(config.publishRoot, ".backup-intact-abc1234567"), { recursive: true });

  await recoverPublishRoot();

  assert.equal(await fs.readFile(path.join(config.publishRoot, "stranded/index.html/keep.txt"), "utf8"), "live content");
  const entries = await publishRootEntries();
  assert.deepEqual(entries, ["clean", "intact", "stranded"]);
});

test("renaming a site turns the old directory into redirects only", async () => {
  const aliasDir = path.join(config.publishRoot, "old-name");
  await fs.mkdir(path.join(aliasDir, "js"), { recursive: true });
  await fs.mkdir(path.join(aliasDir, "css"), { recursive: true });
  await fs.mkdir(path.join(aliasDir, "gallery"), { recursive: true });
  await fs.writeFile(path.join(aliasDir, "index.html"), "<html>old</html>");
  await fs.writeFile(path.join(aliasDir, "about.html"), "<html>old about</html>");
  await fs.writeFile(path.join(aliasDir, "js/main.js"), 'console.log("old");');
  await fs.writeFile(path.join(aliasDir, "css/main.css"), "body{}");
  await fs.writeFile(path.join(aliasDir, "gallery/photo.png"), "not-really-a-png");

  await publishSiteRedirects(["old-name"], "new-name");

  // Every HTML page becomes a redirect, including subpages.
  const index = await fs.readFile(path.join(aliasDir, "index.html"), "utf8");
  const about = await fs.readFile(path.join(aliasDir, "about.html"), "utf8");
  assert.match(index, /sites\.example\.invalid\/new-name\//);
  assert.match(about, /sites\.example\.invalid\/new-name\/about/);
  // The old assets must not stay reachable under the old URL.
  await assert.rejects(fs.access(path.join(aliasDir, "js/main.js")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(aliasDir, "css/main.css")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(aliasDir, "gallery/photo.png")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(aliasDir, "js")), { code: "ENOENT" });
});

function signed(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

test("webhook answers before dispatching and ignores a replayed delivery", async () => {
  const secret = "test-secret";
  const dispatched: string[] = [];
  let release: () => void = () => undefined;
  const server = startWebhookServer({
    port: 0,
    secret,
    onPush: async (event) => {
      dispatched.push(String(event.after));
      // Deliberately slow: the response must not wait for Discord or the agent.
      await new Promise<void>((resolve) => { release = resolve; });
    },
    health: () => ({ projects: 0 }),
  });
  const port = await server.listening;
  try {
    const body = JSON.stringify({ ref: "refs/heads/main", after: "deadbeef", repository: { name: "repo" } });
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/hooks/forgejo`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forgejo-signature": signed(secret, body), "x-forgejo-delivery": "delivery-1" },
      body,
    });
    assert.equal(response.status, 202);
    assert.equal(await response.text(), "accepted");
    assert.ok(Date.now() - started < 1000, "the webhook must answer without waiting for dispatch");

    // Forgejo retries a delivery it did not see acknowledged.
    const replay = await fetch(`http://127.0.0.1:${port}/hooks/forgejo`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forgejo-signature": signed(secret, body), "x-forgejo-delivery": "delivery-1" },
      body,
    });
    assert.equal(replay.status, 202);
    assert.equal(await replay.text(), "duplicate");
    assert.deepEqual(dispatched, ["deadbeef"]);

    // A forged body is still rejected before dispatch.
    const forged = await fetch(`http://127.0.0.1:${port}/hooks/forgejo`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forgejo-signature": "00" },
      body,
    });
    assert.equal(forged.status, 401);

    // Malformed JSON with a valid signature is a client error, not a 500.
    const broken = "not-json";
    const unparseable = await fetch(`http://127.0.0.1:${port}/hooks/forgejo`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forgejo-signature": signed(secret, broken) },
      body: broken,
    });
    assert.equal(unparseable.status, 400);
  } finally {
    release();
    server.close();
  }
});

test("webhook health check still answers", async () => {
  const server = startWebhookServer({ port: 0, secret: "s", onPush: async () => undefined, health: () => ({ projects: 2 }) });
  const port = await server.listening;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(response.status, 200);
  } finally {
    server.close();
  }
});
