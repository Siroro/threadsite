import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import type { ForgejoClient } from "./forgejo.js";
import type { CommitAuthor } from "./types.js";

const execFileAsync = promisify(execFile);

/** Unambiguous alphabet for generated push credentials: no 0/O/1/l/I. */
const CREDENTIAL_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function randomCredential(length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += CREDENTIAL_ALPHABET[bytes[i] % CREDENTIAL_ALPHABET.length];
  return out;
}

/**
 * Username/password pair for a repo push-key account. Random on every call;
 * persistence is the caller's job (the project record).
 */
export function generatePushCredentials(): { username: string; password: string } {
  return { username: `push-${randomCredential(6)}`, password: randomCredential(20) };
}

/**
 * A git invocation that never returns parks the thread's queue forever: the
 * per-thread chain has no other deadline, so a black-holed fetch/push would
 * wedge the thread until restart. Generous enough for a large initial push.
 */
const GIT_TIMEOUT_MS = 60_000;

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 4 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
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

/** Env vars authenticating git operations against Forgejo via the askpass helper. */
async function pushAuthEnv(forgejo: ForgejoClient): Promise<NodeJS.ProcessEnv> {
  const credentials = await forgejo.gitCredentials();
  return {
    GIT_ASKPASS: "/usr/local/bin/threadsite-git-askpass",
    GIT_TERMINAL_PROMPT: "0",
    FORGEJO_GIT_USERNAME: credentials.username,
    FORGEJO_GIT_TOKEN: credentials.token,
  };
}

/**
 * Fetch origin/main and rebase local commits on top, so a bot push survives an
 * external push (a push-key holder committed to main) without losing either
 * side's work. A conflict aborts the rebase and throws — the caller fails the
 * turn loudly rather than dropping history.
 */
export async function fetchAndRebase(workspace: string, forgejo: ForgejoClient): Promise<void> {
  const auth = await pushAuthEnv(forgejo);
  try {
    await git(workspace, ["fetch", "origin", "main"], auth);
  } catch (error) {
    // A brand-new repository has no main on the remote yet — the push that
    // follows this call creates it, so there is nothing to rebase onto.
    if (/couldn't find remote ref/i.test(String(error))) return;
    throw error;
  }
  // "HEAD is up to date" exits 0 with nothing rebased; a divergence with no
  // conflicts rebases silently. Only actual conflicts throw here.
  await git(workspace, ["rebase", "origin/main"]).catch(async (error) => {
    await git(workspace, ["rebase", "--abort"]).catch(() => undefined);
    throw error;
  });
}

/**
 * Adopt whatever commit currently sits on origin/main: fetch, then hard-reset
 * the workspace to it. Used after an external push so the workspace, the repo,
 * and (on Publish) the live site all converge on the pushed commit.
 *
 * A hard reset discards uncommitted edits, so a dirty tree is refused here
 * rather than at each caller: a turn whose commit failed deliberately leaves
 * the agent's work in the tree, and adopting an external push must not eat it.
 */
export async function syncToRemote(workspace: string, forgejo: ForgejoClient): Promise<{ commit: string }> {
  if (!(await workingTreeClean(workspace))) {
    throw new Error(
      "The workspace has uncommitted changes (a previous turn's edits are still pending), so adopting the external push would discard them. Publish or revert that work first.",
    );
  }
  const auth = await pushAuthEnv(forgejo);
  try {
    await git(workspace, ["fetch", "origin", "main"], auth);
  } catch (error) {
    // No main on the remote means nothing was ever pushed; the local workspace
    // is the only history, so adopting is a no-op on the current HEAD.
    if (/couldn't find remote ref/i.test(String(error))) {
      return { commit: await currentHead(workspace) };
    }
    throw error;
  }
  await git(workspace, ["reset", "--hard", "origin/main"]);
  await git(workspace, ["clean", "-fd"]);
  return { commit: await currentHead(workspace) };
}

/** Reset the working tree to a specific commit (kept as-is otherwise). */
export async function resetToCommit(workspace: string, ref: string): Promise<void> {
  await git(workspace, ["reset", "--hard", ref]);
  await git(workspace, ["clean", "-fd"]);
}

/** Full hash of the commit currently checked out in the workspace. */
export async function currentHead(workspace: string): Promise<string> {
  return git(workspace, ["rev-parse", "HEAD"]);
}

/** Whether the working tree has no uncommitted or untracked changes. */
export async function workingTreeClean(workspace: string): Promise<boolean> {
  const status = await git(workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return !status.trim();
}

export interface RemoteSyncOutcome {
  /** Full hash of HEAD after the sync. */
  commit: string;
  /** Local commits rebased on top of origin/main and pushed back (e.g. a rejected push). */
  ahead: number;
  /** Remote commits the workspace adopted. */
  behind: number;
}

/**
 * Reconcile the workspace with origin/main in one step: adopt remote commits,
 * rebase local unpushed commits on top, and push the reconciled history. A
 * clean tree is the caller's precondition — a rebase cannot survive uncommitted
 * edits, and discarding them silently would destroy a failed turn's work.
 */
export async function syncWithRemote(workspace: string, forgejo: ForgejoClient): Promise<RemoteSyncOutcome> {
  const auth = await pushAuthEnv(forgejo);
  const count = (range: string): Promise<number> =>
    git(workspace, ["rev-list", "--count", range])
      .then((out) => Number.parseInt(out, 10) || 0)
      .catch(() => 0);
  await git(workspace, ["fetch", "origin", "main"], auth);
  const ahead = await count("origin/main..HEAD");
  const behind = await count("HEAD..origin/main");
  if (behind > 0) {
    if (ahead > 0) {
      await git(workspace, ["rebase", "origin/main"], auth).catch(async (error) => {
        await git(workspace, ["rebase", "--abort"], auth).catch(() => undefined);
        throw error;
      });
    } else {
      await git(workspace, ["reset", "--hard", "origin/main"]);
    }
    await git(workspace, ["clean", "-fd"]);
  }
  if (ahead > 0 || behind > 0) {
    await git(workspace, ["push", "-u", "origin", "main"], auth);
  }
  return { commit: await currentHead(workspace), ahead, behind };
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
  target?: string,
): Promise<{ undone: string; kept: string }> {
  const { current, previous } = await commitHistory(workspace);
  const kept = target ?? previous;
  if (!kept) {
    throw new Error("Only the initial workspace commit exists; there is no earlier published version to revert to.");
  }
  if (!/^[0-9a-f]{7,40}$/i.test(kept)) throw new Error("Invalid revert commit.");
  await git(workspace, ["merge-base", "--is-ancestor", kept, "HEAD"]);
  await git(workspace, ["reset", "--hard", kept]);
  await git(workspace, ["clean", "-fd"]);
  // History is being rewritten on purpose: the undone turn's commit must leave
  // the public repository as well as the local worktree.
  await git(workspace, ["push", "--force", "origin", "main"], await pushAuthEnv(forgejo));
  return { undone: current, kept: await git(workspace, ["rev-parse", "--short=10", "HEAD"]) };
}

/** Metadata renames do not constitute an accepted agent turn, including in older workspaces. */
export async function turnRevertTarget(workspace: string, lastCommit?: string, beforeCommit?: string): Promise<{ current: string; target?: string; headDrifted: boolean }> {
  const { current } = await commitHistory(workspace);
  let headDrifted = Boolean(lastCommit && lastCommit !== current);
  if (headDrifted && lastCommit) {
    const ancestor = await git(workspace, ["merge-base", "--is-ancestor", lastCommit, "HEAD"]).then(() => true, () => false);
    const commits = ancestor ? await git(workspace, ["log", "--format=%H", `${lastCommit}..HEAD`]) : "";
    if (commits && (await Promise.all(commits.split("\n").map((commit) => isRenameMetadata(workspace, commit)))).every(Boolean)) headDrifted = false;
  }
  if (headDrifted) return { current, headDrifted };
  if (beforeCommit) return { current, target: beforeCommit, headDrifted };
  let authored = "HEAD";
  while (await isRenameMetadata(workspace, authored)) {
    authored = await git(workspace, ["rev-parse", `${authored}^`]);
  }
  const target = beforeCommit ?? await git(workspace, ["rev-parse", `${authored}^`]).catch(() => undefined);
  return { current, target, headDrifted };
}

async function isRenameMetadata(workspace: string, commit: string): Promise<boolean> {
  if (!(await git(workspace, ["log", "-1", "--format=%s", commit])).startsWith("Rename project to ")) return false;
  const files = (await git(workspace, ["show", "--format=", "--name-only", commit])).split("\n").filter(Boolean);
  // A requester can use the same words as a rename commit subject. Never skip
  // an authored content change merely because its subject looks like metadata.
  return files.every((file) => ["README.md", "AGENTS.md", "NETWORKING.md", ".gitignore"].includes(file) || file.startsWith("site/net/"));
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
  paths?: string[];
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
  const changedPaths = new Set<string>();
  for (const line of status.split("\n")) {
    if (!line) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3);
    if (code === "??") {
      const absolute = path.resolve(workspace, file);
      const content = await fs.readFile(absolute).catch(() => undefined);
      const before = baseline?.files.get(file);
      if (content && (!before || before.hash !== requireHash(content))) {
        changedPaths.add(file);
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
    changedPaths.add(file);
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
    changedPaths.add(file);
    stats.files += 1;
    stats.deleted += 1;
    stats.deletions += before.lines;
  }
  stats.paths = [...changedPaths].sort();
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

/**
 * Migrate generated runtime files out of an existing repository's index while
 * leaving the workspace copies intact for validation and publication.
 */
export async function untrackGeneratedArtifacts(workspace: string): Promise<void> {
  await git(workspace, [
    "rm", "-r", "-f", "--cached", "--ignore-unmatch", "--",
    ".opencode", "site/js", "build-manifest.json",
  ]);
}

export async function commitAndPush(
  workspace: string,
  summary: string,
  forgejo: ForgejoClient,
  author?: CommitAuthor,
): Promise<CommitStats | null> {
  // Generated runtime and the curated .opencode skills used to be committed.
  // Keep the files in the workspace for the agent and validation/publish, but
  // stage their removal from existing repositories so the new ignore boundary
  // migrates cleanly in one normal turn. The vendored net client under
  // site/net/ is the exception: it stays tracked (small, stable, harness-owned
  // input worth showing in the tree).
  await untrackGeneratedArtifacts(workspace);
  await git(workspace, ["add", "-A"]);
  // A turn that only asks a question (or answers without edits) stages nothing;
  // committing then would push an empty commit to Forgejo. Null tells the
  // caller the tree was already clean and no commit was created.
  const staged = await git(workspace, ["status", "--porcelain=v1"]);
  if (!staged.trim()) return null;
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
  // An external push (a push-key holder) may have moved origin/main ahead of
  // the local history this turn was built on; rebasing keeps both sides.
  await fetchAndRebase(workspace, forgejo);
  await git(workspace, ["push", "-u", "origin", "main"], { ...(await pushAuthEnv(forgejo)), ...identity });
  // The rebase may have rewritten the commit; read the hash the push actually published.
  const pushed = await git(workspace, ["rev-parse", "--short=10", "HEAD"]);
  return { commit: pushed, files, additions, deletions };
}
