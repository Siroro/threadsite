import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
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
  // trimEnd, not trim: porcelain status lines legitimately begin with a space
  // (unstaged column), and a leading trim would shift every parsed path.
  return stdout.trimEnd();
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

export interface WorkingTreeSnapshot {
  files: Map<string, { hash: string; lines: number }>;
  numstat: Map<string, { additions: number; deletions: number }>;
}

export interface WorkingTreeStats {
  files: number;
  added: number;
  modified: number;
  deleted: number;
  additions: number;
  deletions: number;
}

/**
 * Capture the workspace baseline immediately before an agent turn. Includes
 * untracked files: failed turns deliberately preserve the agent's partial
 * edits, and without a baseline entry those files would be recounted as fresh
 * additions on every later turn.
 */
export async function captureWorkingTreeSnapshot(workspace: string): Promise<WorkingTreeSnapshot> {
  const files = new Map<string, { hash: string; lines: number }>();
  const lsFiles = (extra: string[]) => git(workspace, ["ls-files", "-z", ...extra]).then((raw) => raw.split("\0").filter(Boolean));
  for (const file of [...await lsFiles([]), ...await lsFiles(["--others", "--exclude-standard"])]) {
    const content = await fs.readFile(path.join(workspace, file)).catch(() => undefined);
    if (content) files.set(file, { hash: requireHash(content), lines: isBinary(content) ? 0 : countLines(content.toString("utf8")) });
  }
  const numstat = new Map<string, { additions: number; deletions: number }>();
  for (const line of (await git(workspace, ["diff", "HEAD", "--numstat"])).split("\n")) {
    if (!line.trim()) continue;
    const [added, removed, file] = line.split("\t");
    if (file && added !== "-" && removed !== "-") numstat.set(file, { additions: Number.parseInt(added, 10) || 0, deletions: Number.parseInt(removed, 10) || 0 });
  }
  return { files, numstat };
}

/** Summarize edits relative to a turn-start snapshot, including new files. */
export async function workingTreeStats(workspace: string, baseline?: WorkingTreeSnapshot): Promise<WorkingTreeStats> {
  const status = await git(workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const stats: WorkingTreeStats = { files: 0, added: 0, modified: 0, deleted: 0, additions: 0, deletions: 0 };
  const currentPaths = new Set<string>();
  for (const line of status.split("\n")) {
    if (!line) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3);
    if (code === "??") {
      const absolute = path.resolve(workspace, file);
      const content = await fs.readFile(absolute).catch(() => undefined);
      const before = baseline?.files.get(file);
      if (content && (!before || before.hash !== requireHash(content))) {
        stats.files += 1;
        stats.added += 1;
        // Binary assets have no meaningful line count — counting 0x0A bytes in
        // them is how a few MB of media turns into tens of thousands of "lines".
        if (!isBinary(content)) stats.additions += countLines(content.toString("utf8"));
      }
      currentPaths.add(file);
      continue;
    }
    const before = baseline?.files.get(file);
    const absolute = path.resolve(workspace, file);
    const current = await fs.readFile(absolute).catch(() => undefined);
    const changed = !before || !current || before.hash !== requireHash(current);
    if (!changed) continue;
    stats.files += 1;
    currentPaths.add(file);
    if (code.includes("A")) stats.added += 1;
    else if (code.includes("D")) stats.deleted += 1;
    else stats.modified += 1;
  }

  const numstat = await git(workspace, ["diff", "HEAD", "--numstat"]);
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const [added, removed, file] = line.split("\t");
    if (!file || !currentPaths.has(file)) continue;
    // Renames and binary files use non-numeric markers; don't invent line counts.
    if (added !== "-" && removed !== "-") {
      const current = { additions: Number.parseInt(added, 10) || 0, deletions: Number.parseInt(removed, 10) || 0 };
      const before = baseline?.numstat.get(file);
      stats.additions += Math.max(0, current.additions - (before?.additions ?? 0));
      stats.deletions += Math.max(0, current.deletions - (before?.deletions ?? 0));
    }
  }
  for (const [file, before] of baseline?.files ?? []) {
    if (currentPaths.has(file)) continue;
    // git status only lists files that changed, so absence from it also describes
    // untouched files — confirm the file is really gone before counting a deletion.
    const exists = await fs.access(path.join(workspace, file)).then(() => true, () => false);
    if (exists) continue;
    stats.files += 1;
    stats.deleted += 1;
    stats.deletions += before.lines;
  }
  return stats;
}

function requireHash(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** Git-style binary sniff: a NUL byte in the first 8 KiB means "not line data". */
function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8192).includes(0);
}

function countLines(content: string): number {
  return content ? content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0) : 0;
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
