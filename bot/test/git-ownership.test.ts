import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

process.env.DISCORD_BOT_TOKEN = "test";
process.env.DISCORD_APPLICATION_ID = "test";
const { ensureGitRepository, ensureLocalBaseline, commitAndPush, currentHead, workingTreeClean } = await import("../src/git.js");
import type { ForgejoClient } from "../src/forgejo.js";
const exec = promisify(execFile);

test("workspace Git operations survive different ownership without changing global trust", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-git-ownership-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const workspace = path.join(root, "workspace with spaces");
  const remote = path.join(root, "remote.git");
  const homeConfig = path.join(root, "gitconfig");
  await exec("git", ["init", "--bare", "-b", "main", remote]);
  await fs.mkdir(workspace);
  await exec("git", ["init", "-b", "main"], { cwd: workspace });
  await exec("git", ["config", "user.name", "Test"], { cwd: workspace });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
  await fs.writeFile(path.join(workspace, "index.html"), "<p>baseline</p>");
  // The local bare remote runs a separate receive-pack process. Give that
  // fixture its own trust entry, leaving the client workspace untrusted.
  const initialConfig = `[safe]\n\tdirectory = "${(await fs.realpath(remote)).replaceAll("\\", "/")}"\n`;
  await fs.writeFile(homeConfig, initialConfig);

  // Git's own ownership-test switch exercises the real rejection on every OS.
  const previous = { ...process.env };
  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
  process.env.GIT_CONFIG_GLOBAL = homeConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  t.after(() => {
    for (const key of ["GIT_TEST_ASSUME_DIFFERENT_OWNER", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  const rawStatus = () => exec("git", ["status", "--porcelain"], { cwd: workspace });
  await assert.rejects(rawStatus(), /dubious ownership/);
  const forgejo = {
    repoGitUrl: () => remote,
    gitCredentials: async () => ({ username: "test", token: "test" }),
  } as unknown as ForgejoClient;
  await ensureGitRepository(workspace, "test", forgejo);
  await ensureLocalBaseline(workspace);
  assert.match(await currentHead(workspace), /^[a-f0-9]{40}$/);
  await fs.writeFile(path.join(workspace, "index.html"), "<p>updated</p>");
  const committed = await commitAndPush(workspace, "Update site", forgejo);
  assert.ok(committed);
  assert.equal(await workingTreeClean(workspace), true);
  const remoteHead = (await exec("git", ["rev-parse", "refs/heads/main"], {
    cwd: remote, env: { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "0" },
  })).stdout.trim();
  assert.equal(await currentHead(workspace), remoteHead);
  await assert.rejects(rawStatus(), /dubious ownership/, "trust must stay local to harness Git commands");
  assert.equal(await fs.readFile(homeConfig, "utf8"), initialConfig);
});

test("a workspace nested in another checkout never reads or commits its parent repository", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-nested-git-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await exec("git", ["init", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.name", "Parent"], { cwd: root });
  await exec("git", ["config", "user.email", "parent@example.invalid"], { cwd: root });
  await fs.writeFile(path.join(root, "server.txt"), "server checkout");
  await exec("git", ["add", "server.txt"], { cwd: root });
  await exec("git", ["commit", "-m", "Parent baseline"], { cwd: root });
  const parentHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const workspace = path.join(root, "data", "workspaces", "guild", "thread");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "index.html"), "<p>project</p>");
  await assert.rejects(currentHead(workspace), /no Git repository.*refusing to use a parent repository/s);
  await assert.rejects(ensureLocalBaseline(workspace), /no Git repository/);
  const forgejo = { repoGitUrl: () => "https://git.example.invalid/project.git" } as ForgejoClient;
  await ensureGitRepository(workspace, "project", forgejo);
  const routing = { GIT_DIR: path.join(root, ".git"), GIT_WORK_TREE: root, GIT_INDEX_FILE: path.join(root, ".git", "index") };
  const previousRouting = Object.fromEntries(Object.keys(routing).map((key) => [key, process.env[key]]));
  Object.assign(process.env, routing);
  t.after(() => {
    for (const [key, value] of Object.entries(previousRouting)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  await ensureLocalBaseline(workspace);
  assert.notEqual(await currentHead(workspace), parentHead);
  assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(), parentHead);
  assert.equal((await exec("git", ["diff", "--cached", "--name-only"], { cwd: root })).stdout.trim(), "");
});

test("workspace Git refuses metadata redirected outside the project", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-git-metadata-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const target = path.join(root, "elsewhere.git");
  await exec("git", ["init", "--bare", target]);
  for (const kind of ["gitfile", "symlink"]) {
    const workspace = path.join(root, kind);
    await fs.mkdir(workspace);
    const metadata = path.join(workspace, ".git");
    if (kind === "gitfile") await fs.writeFile(metadata, `gitdir: ${target.replaceAll("\\", "/")}\n`);
    else await fs.symlink(target, metadata, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(currentHead(workspace), /Git metadata must be a directory inside/);
  }
});
