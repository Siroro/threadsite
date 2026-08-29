import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { ForgejoClient } from "./forgejo.js";
import type { CommitAuthor } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function ensureGitRepository(
  workspace: string,
  repoName: string,
  forgejo: ForgejoClient,
): Promise<void> {
  await fs.mkdir(workspace, { recursive: true });
  try {
    await fs.access(path.join(workspace, ".git"));
  } catch {
    await git(workspace, ["init", "-b", "main"]);
    await git(workspace, ["config", "user.name", config.commitBotName]);
    await git(workspace, ["config", "user.email", config.commitBotEmail]);
  }

  const remote = forgejo.repoGitUrl(repoName);
  try {
    await git(workspace, ["remote", "get-url", "origin"]);
    await git(workspace, ["remote", "set-url", "origin", remote]);
  } catch {
    await git(workspace, ["remote", "add", "origin", remote]);
  }
}


export async function ensureLocalBaseline(workspace: string): Promise<void> {
  try {
    await git(workspace, ["rev-parse", "--verify", "HEAD"]);
    return;
  } catch {
    await git(workspace, ["add", "-A"]);
    await git(workspace, ["commit", "-m", "Initialize ThreadSite workspace"]);
  }
}

export async function restoreWorkingTree(workspace: string): Promise<void> {
  await git(workspace, ["reset", "--hard", "HEAD"]);
  await git(workspace, ["clean", "-fd"]);
}

export async function commitHistory(workspace: string): Promise<{ current: string; previous?: string }> {
  const current = await git(workspace, ["rev-parse", "--short=10", "HEAD"]);
  const previous = await git(workspace, ["rev-parse", "--short=10", "HEAD~1"]).catch(() => undefined);
  return { current, previous };
}

export async function undoLastCommit(
  workspace: string,
  forgejo: ForgejoClient,
): Promise<{ undone: string; kept: string }> {
  const { current, previous } = await commitHistory(workspace);
  if (!previous) {
    throw new Error("Only the initial workspace commit exists; there is no earlier published version to revert to.");
  }
  await git(workspace, ["reset", "--hard", "HEAD~1"]);
  await git(workspace, ["clean", "-fd"]);
  // History is being rewritten on purpose: the undone turn's commit must leave the
  // public repository as well as the local worktree.
  const credentials = await forgejo.gitCredentials();
  await git(workspace, ["push", "--force", "origin", "main"], {
    GIT_ASKPASS: "/usr/local/bin/threadsite-git-askpass",
    GIT_TERMINAL_PROMPT: "0",
    FORGEJO_GIT_USERNAME: credentials.username,
    FORGEJO_GIT_TOKEN: credentials.token,
  });
  return { undone: current, kept: previous };
}

export interface CommitStats {
  /** Short commit hash. */
  commit: string;
  /** Number of files changed by the commit. */
  files: number;
  /** Lines added and removed by the commit. */
  additions: number;
  deletions: number;
}

export async function commitAndPush(
  workspace: string,
  summary: string,
  forgejo: ForgejoClient,
  author?: CommitAuthor,
): Promise<CommitStats> {
  await git(workspace, ["add", "-A"]);
  const subject = summary.replace(/[\r\n]+/g, " ").trim().slice(0, 72) || "Update from Discord";
  const message = `${subject}\n\nCo-authored-by: ${config.commitBotName} <${config.commitBotEmail}>`;
  // The Discord requester authors the change; the bot commits it and is
  // credited as co-author so Forgejo can link both identities.
  const identity: NodeJS.ProcessEnv = {
    GIT_COMMITTER_NAME: config.commitBotName,
    GIT_COMMITTER_EMAIL: config.commitBotEmail,
    ...(author ? { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email } : {}),
  };
  await git(workspace, ["commit", "--allow-empty", "-m", message], identity);
  const commit = await git(workspace, ["rev-parse", "--short=10", "HEAD"]);
  // numstat gives per-file added/removed lines; binary files show "-".
  const numstat = await git(workspace, ["show", "--numstat", "--format=", "HEAD"]);
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const [added, removed] = line.split("\t");
    files += 1;
    if (added !== "-" && removed !== "-") {
      additions += parseInt(added, 10) || 0;
      deletions += parseInt(removed, 10) || 0;
    }
  }
  const credentials = await forgejo.gitCredentials();
  await git(workspace, ["push", "-u", "origin", "main"], {
    GIT_ASKPASS: "/usr/local/bin/threadsite-git-askpass",
    GIT_TERMINAL_PROMPT: "0",
    FORGEJO_GIT_USERNAME: credentials.username,
    FORGEJO_GIT_TOKEN: credentials.token,
    ...identity,
  });
  return { commit, files, additions, deletions };
}
