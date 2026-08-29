import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { ForgejoClient } from "./forgejo.js";
import { commitAndPush, commitHistory, ensureGitRepository, ensureLocalBaseline, restoreWorkingTree, undoLastCommit } from "./git.js";
import { ensureMultiplayerFiles, multiplayerContext } from "./multiplayer.js";
import { OpenCodeHarness } from "./opencode.js";
import { publishIndex, publishSite, siteUrl, validateSite } from "./publish.js";
import { Store } from "./store.js";
import { initialProjectInstruction, mutationInstruction, projectAgents, projectKindLabel, repairInstruction } from "./templates.js";
import type { CommitAuthor, ProjectKind, ProjectRecord } from "./types.js";
import type { ProgressCallback } from "./progress.js";
import { log, logError, serializeError } from "./logger.js";
import { errorText, parseModel, safeChild, slugify, truncate, withTimeout } from "./util.js";

export interface MutationResult {
  project: ProjectRecord;
  agentSummary: string;
  commit: string;
  /** Files changed by the commit itself (vs. total files in site/). */
  commitFiles: number;
  /** Lines added and removed by the commit. */
  additions: number;
  deletions: number;
  files: number;
  bytes: number;
}

export interface RevertResult {
  /** Commit removed from git/publication, when the last turn had been accepted. */
  undoneCommit?: string;
  /** Commit the workspace was reset to and republished. */
  keptCommit?: string;
  /** Whether OpenCode's conversation for the turn was also reverted. */
  conversationReverted: boolean;
}

export class ProjectService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    readonly store: Store,
    readonly opencode: OpenCodeHarness,
    readonly forgejo: ForgejoClient,
  ) {}

  enqueue<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const tracked = next.finally(() => {
      if (this.queues.get(threadId) === tracked) this.queues.delete(threadId);
    });
    this.queues.set(threadId, tracked);
    return next;
  }

  async createProject(input: {
    threadId: string;
    guildId: string;
    parentChannelId: string;
    displayName: string;
    initialPrompt: string;
    projectKind?: ProjectKind;
    /** True when ThreadSite created the thread from a slug and may rename it with an AI title. */
    renameable?: boolean;
    /** Discord user who requested the project; becomes the initial commit's author. */
    initiator?: CommitAuthor;
  }, onProgress?: ProgressCallback, onTitle?: (title: string) => Promise<void>): Promise<MutationResult> {
    if (this.store.getProject(input.threadId)) throw new Error("This Discord thread already has a site.");

    const baseSlug = slugify(input.displayName);
    const suffix = input.threadId.slice(-6);
    const siteSlug = `${baseSlug}-${suffix}`.slice(0, 63);
    const repoName = `site-${siteSlug}`.slice(0, 80);
    const workspacePath = safeChild(config.workspaceRoot, input.guildId, input.threadId);
    const siteDir = safeChild(workspacePath, "site");
    const projectKind = input.projectKind ?? "site";

    emit(onProgress, "📁 Preparing persistent workspace");
    await fs.mkdir(siteDir, { recursive: true });
    await fs.writeFile(path.join(siteDir, "index.html"), starterHtml(input.displayName), "utf8");
    await fs.writeFile(path.join(workspacePath, ".gitignore"), "\n", "utf8");
    const multiplayer = multiplayerContext(projectKind, siteSlug);
    if (multiplayer) {
      // Games are multi-tenant clients of the shared relay: vendored protocol
      // client + this game's net config + the multiplayer AGENTS.md section.
      emit(onProgress, "🕹️ Provisioning multiplayer client and AGENTS.md");
      await ensureMultiplayerFiles(workspacePath, multiplayer, projectKind);
    } else {
      emit(onProgress, "🧭 Writing project-specific AGENTS.md");
      await fs.writeFile(path.join(workspacePath, "AGENTS.md"), projectAgents(projectKind), "utf8");
    }

    emit(onProgress, "🌱 Creating/checking Forgejo repository");
    await this.forgejo.ensureRepository(repoName, `${projectKindLabel(projectKind)} generated from Discord thread ${input.displayName}`);
    emit(onProgress, "🧱 Initialising git workspace");
    await ensureGitRepository(workspacePath, repoName, this.forgejo);
    await ensureLocalBaseline(workspacePath);
    emit(onProgress, "🧠 Starting the persistent agent session");
    const sessionId = await this.opencode.createSession(workspacePath, `Discord: ${input.displayName}`);

    const now = new Date().toISOString();
    const project: ProjectRecord = {
      threadId: input.threadId,
      guildId: input.guildId,
      parentChannelId: input.parentChannelId,
      displayName: input.displayName,
      workspacePath,
      siteSlug,
      repoName,
      sessionId,
      projectKind,
      status: "creating",
      createdAt: now,
      updatedAt: now,
    };
    await this.store.putProject(project);
    log("info", "project.created", { threadId: input.threadId, projectKind, repoName, siteSlug });

    // Generate the AI thread title in parallel with the first build; it is applied
    // only after the build succeeds so failed projects keep their slug name.
    const titlePromise = input.renameable && onTitle
      ? this.opencode.generateTitle(workspacePath, input.initialPrompt, this.store.getModel())
          .catch((error) => {
            log("warn", "project.title_generation_failed", { threadId: input.threadId, error: serializeError(error) });
            return undefined;
          })
      : undefined;

    let result = await this.mutate(input.threadId, input.initialPrompt, true, onProgress, input.initiator);

    if (titlePromise && onTitle) {
      const title = await withTimeout(titlePromise, 90_000);
      if (title) {
        // Adopt the AI title end-to-end: Discord thread name, Forgejo repo,
        // published directory, README, and index. The thread-id suffix is kept
        // on the new slug so identities stay unique and stable.
        let project = result.project;
        const suffix = input.threadId.slice(-6);
        const baseSlug = slugify(title);
        let siteSlug = baseSlug ? `${baseSlug}-${suffix}`.slice(0, 63) : project.siteSlug;
        let repoName = siteSlug !== project.siteSlug ? `site-${siteSlug}`.slice(0, 80) : project.repoName;
        if (siteSlug !== project.siteSlug) {
          try {
            emit(onProgress, "🏷️ Renaming repository and site to match the title");
            await this.forgejo.renameRepository(project.repoName, repoName);
            // Repoint the workspace remote at the renamed repository (Forgejo
            // also leaves a redirect, but the remote should carry the new name).
            await ensureGitRepository(project.workspacePath, repoName, this.forgejo);
            // Restamp the multiplayer tenant id so the published net-config
            // matches the new slug (rides along into the next commit).
            const renamedMultiplayer = multiplayerContext(project.projectKind ?? "site", siteSlug);
            if (renamedMultiplayer) {
              await ensureMultiplayerFiles(project.workspacePath, renamedMultiplayer, project.projectKind ?? "site");
            }
            const siteDir = safeChild(project.workspacePath, "site");
            await publishSite(siteDir, siteSlug);
            await fs.rm(safeChild(config.publishRoot, project.siteSlug), { recursive: true, force: true }).catch(() => undefined);
            log("info", "project.renamed_slug", { threadId: input.threadId, from: project.siteSlug, to: siteSlug, repoName });
          } catch (error) {
            log("warn", "project.title_rename_failed", { threadId: input.threadId, error: serializeError(error) });
            siteSlug = project.siteSlug;
            repoName = project.repoName;
          }
        }
        project = await this.store.patchProject(input.threadId, { displayName: title, siteSlug, repoName });
        await this.writeReadme(project);
        await onTitle(title).catch((error) => {
          log("warn", "project.thread_rename_failed", { threadId: input.threadId, error: serializeError(error) });
        });
        await publishIndex(this.store.listProjects(), (repo) => this.forgejo.repoWebUrl(repo)).catch(() => undefined);
        log("info", "project.renamed_by_ai", { threadId: input.threadId, title, siteSlug, repoName });
        result = { ...result, project };
      }
    }
    return result;
  }

  async mutate(threadId: string, prompt: string, initial = false, onProgress?: ProgressCallback, author?: CommitAuthor): Promise<MutationResult> {
    let project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site. Use /site start first.");
    if (!prompt.trim()) throw new Error("Prompt is empty.");
    if (prompt.length > config.maxPromptChars) throw new Error(`Prompt exceeds MAX_PROMPT_CHARS (${config.maxPromptChars}).`);

    try {
      let agentSummary: string;
      const projectKind = project.projectKind ?? "site";
      // Repair harness-owned multiplayer files (vendored client, net config,
      // multiplayer AGENTS.md section) in case a previous turn removed them.
      const multiplayer = multiplayerContext(projectKind, project.siteSlug);
      if (multiplayer) {
        emit(onProgress, "🕹️ Ensuring multiplayer client files");
        await ensureMultiplayerFiles(project.workspacePath, multiplayer, projectKind);
      }
      // Durable project memory: read fresh each turn so notes land in the very
      // turn after they are written. Missing file is fine (nothing noted yet).
      const notes = await fs.readFile(path.join(project.workspacePath, "PROJECT_NOTES.md"), "utf8")
        .catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : undefined);
      const instruction = initial
        ? initialProjectInstruction(projectKind, prompt, notes)
        : mutationInstruction(projectKind, prompt, notes);

      const siteDir = safeChild(project.workspacePath, "site");
      let stats;
      emit(onProgress, initial ? "✨ Building the first version" : "🧠 Applying your requested revision");
      try {
        try {
          agentSummary = await this.opencode.prompt(project.workspacePath, project.sessionId, instruction, this.store.getModel(), onProgress);
        } catch (error) {
          if (!/404|not found|unknown session/i.test(errorText(error))) throw error;
          emit(onProgress, "♻️ Recreating a missing agent session");
          const sessionId = await this.opencode.createSession(project.workspacePath, `Discord: ${project.displayName}`);
          project = await this.store.patchProject(threadId, { sessionId });
          agentSummary = await this.opencode.prompt(project.workspacePath, sessionId, instruction, this.store.getModel(), onProgress);
        }
        emit(onProgress, "🧪 Validating static output");
        try {
          stats = await validateSite(siteDir);
        } catch (error) {
          // One repair attempt: feed the validation error back to the same agent
          // session, which can see the files it just wrote, then re-validate.
          if (!/JavaScript syntax error/i.test(errorText(error))) throw error;
          log("warn", "project.validation_syntax_retry", { threadId, error: errorText(error) });
          emit(onProgress, "🔧 Syntax errors found — asking the agent to repair them");
          agentSummary = await this.opencode.prompt(
            project.workspacePath,
            project.sessionId,
            repairInstruction(errorText(error)),
            this.store.getModel(),
            onProgress,
          );
          emit(onProgress, "🧪 Re-validating after the repair");
          stats = await validateSite(siteDir);
        }
      } catch (error) {
        // Keep whatever the agent wrote — the failed turn's edits stay in the
        // working tree so the next turn can build on or fix them.
        if ((error as any)?.mayStillBeRunning) {
          emit(onProgress, "⚠️ The agent may still be running — preserving the workspace");
          log("error", "project.rollback_skipped_active_opencode", {
            threadId,
            sessionId: project.sessionId,
            error: errorText(error),
          });
        } else {
          emit(onProgress, "🗂️ Preserving the agent's partial edits for the next turn");
          log("warn", "project.rollback_skipped_preserve_edits", {
            threadId,
            sessionId: project.sessionId,
            error: errorText(error),
          });
        }
        throw error;
      }
      emit(onProgress, "📝 Updating project metadata");
      await this.writeReadme(project);
      emit(onProgress, "⬆️ Committing and pushing to Forgejo");
      const commitStats = await commitAndPush(
        project.workspacePath,
        commitSubjectFor(prompt, initial, projectKind),
        this.forgejo,
        author,
      );
      emit(onProgress, "🚀 Publishing to Apache");
      await publishSite(siteDir, project.siteSlug);
      project = await this.store.patchProject(threadId, { status: "ready", lastError: undefined, lastCommit: commitStats.commit });
      emit(onProgress, "🗂️ Refreshing the public gallery");
      await publishIndex(this.store.listProjects(), (repo) => this.forgejo.repoWebUrl(repo));
      log("info", "project.published", {
        threadId,
        commit: commitStats.commit,
        files: stats.files,
        bytes: stats.bytes,
        commitFiles: commitStats.files,
        additions: commitStats.additions,
        deletions: commitStats.deletions,
        projectKind,
      });
      return { project, agentSummary, commit: commitStats.commit, commitFiles: commitStats.files, additions: commitStats.additions, deletions: commitStats.deletions, ...stats };
    } catch (error) {
      await this.store.patchProject(threadId, { status: "error", lastError: truncate(errorText(error), 1000) });
      logError("project.mutation_failed", error, { threadId, initial, model: this.store.getModel() || "default" });
      throw error;
    }
  }

  /** Drop the current agent session and start a fresh one on the next message. */
  async resetSession(threadId: string): Promise<ProjectRecord> {
    const project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site.");
    if (await this.opencode.isBusy(project.workspacePath, project.sessionId)) {
      throw new Error("A model turn is still running in this thread. Wait for it to finish before resetting.");
    }
    const sessionId = await this.opencode.createSession(project.workspacePath, `Discord: ${project.displayName}`);
    const updated = await this.store.patchProject(threadId, { sessionId });
    log("info", "project.session_reset", { threadId, oldSessionId: project.sessionId, sessionId });
    return updated;
  }

  /** Tear down a project entirely: workspace, Forgejo repo, published page, and record. */
  async deleteProject(threadId: string): Promise<void> {
    const project = this.store.getProject(threadId);
    if (!project) return;

    // A live agent turn is still writing into the workspace; deleting underneath
    // it would corrupt the store record vs. reality.
    if (await this.opencode.isBusy(project.workspacePath, project.sessionId).catch(() => false)) {
      throw new Error("A model turn is still running in this thread. Wait for it to finish before deleting.");
    }

    await fs.rm(project.workspacePath, { recursive: true, force: true }).catch((error) => {
      log("warn", "project.delete_workspace_failed", { threadId, error: serializeError(error) });
    });
    await this.forgejo.deleteRepository(project.repoName).catch((error) => {
      log("warn", "project.delete_repo_failed", { threadId, repoName: project.repoName, error: serializeError(error) });
    });
    await fs.rm(safeChild(config.publishRoot, project.siteSlug), { recursive: true, force: true }).catch(() => undefined);

    await this.store.deleteProject(threadId);
    await publishIndex(this.store.listProjects(), (repo) => this.forgejo.repoWebUrl(repo)).catch(() => undefined);
    log("info", "project.deleted", { threadId, repoName: project.repoName, siteSlug: project.siteSlug });
  }

  /** Whether an agent turn is currently running for the project's session. */
  async agentBusy(threadId: string): Promise<boolean> {
    const project = this.store.getProject(threadId);
    if (!project) return false;
    return this.opencode.isBusy(project.workspacePath, project.sessionId);
  }

  /** Discard uncommitted working-tree edits from a failed turn (button-initiated rollback). */
  async rollbackEdits(threadId: string): Promise<void> {
    const project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site.");
    await restoreWorkingTree(project.workspacePath);
    log("warn", "project.rollback_requested", { threadId, sessionId: project.sessionId });
  }

  async republish(threadId: string, onProgress?: ProgressCallback): Promise<ProjectRecord> {    let project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site.");
    const siteDir = safeChild(project.workspacePath, "site");
    emit(onProgress, "🧪 Validating checked-in static files");
    await validateSite(siteDir);
    emit(onProgress, "🚀 Republishing to Apache");
    await publishSite(siteDir, project.siteSlug);
    project = await this.store.patchProject(threadId, { status: "ready", lastError: undefined });
    await publishIndex(this.store.listProjects(), (repo) => this.forgejo.repoWebUrl(repo));
    return project;
  }

  async compact(threadId: string): Promise<{ model: string }> {
    const project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site.");
    if (await this.opencode.isBusy(project.workspacePath, project.sessionId)) {
      throw new Error("A model turn is still running in this thread. Wait for it to finish before compacting.");
    }
    const model = (await this.opencode.lastAssistantModel(project.workspacePath, project.sessionId))
      ?? parseModel(this.store.getModel());
    if (!model) {
      throw new Error("No model is known for this session yet. Send at least one message first, or set /site-admin model.");
    }
    log("info", "project.compact_requested", { threadId, model: `${model.providerID}/${model.modelID}` });
    await this.opencode.compactSession(project.workspacePath, project.sessionId, model.providerID, model.modelID);
    return { model: `${model.providerID}/${model.modelID}` };
  }

  async revert(threadId: string): Promise<RevertResult> {
    const project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site.");
    if (await this.opencode.isBusy(project.workspacePath, project.sessionId)) {
      throw new Error("A model turn is still running in this thread. Wait for it to finish before reverting.");
    }

    const messageID = await this.opencode.lastUserMessageId(project.workspacePath, project.sessionId);
    if (!messageID) throw new Error("This session has no turns to revert yet.");

    // Fail fast on a git history that cannot be undone before touching OpenCode state.
    const history = await commitHistory(project.workspacePath);
    if (!history.previous) {
      throw new Error("Only the initial workspace commit exists; there is no earlier published version to revert to.");
    }
    // HEAD no longer matching the last accepted turn means the previous turn failed
    // after its commit/publish; in that case there is no published commit to undo.
    const headDrifted = Boolean(project.lastCommit && project.lastCommit !== history.current);

    let conversationReverted = true;
    try {
      await this.opencode.revertSession(project.workspacePath, project.sessionId, messageID);
    } catch (error) {
      conversationReverted = false;
      if (/busy/i.test(errorText(error))) throw error;
      log("warn", "project.revert_opencode_failed", { threadId, error: serializeError(error) });
    }

    let undoneCommit: string | undefined;
    let keptCommit: string | undefined;
    if (!headDrifted) {
      ({ undone: undoneCommit, kept: keptCommit } = await undoLastCommit(project.workspacePath, this.forgejo));
    }

    if (keptCommit) {
      const siteDir = safeChild(project.workspacePath, "site");
      await validateSite(siteDir);
      await publishSite(siteDir, project.siteSlug);
    }
    await this.store.patchProject(threadId, {
      status: "ready",
      lastError: undefined,
      lastCommit: keptCommit ?? history.current,
    });
    await publishIndex(this.store.listProjects(), (repo) => this.forgejo.repoWebUrl(repo));
    log("info", "project.reverted", { threadId, undoneCommit, keptCommit, conversationReverted, headDrifted });
    return { undoneCommit, keptCommit, conversationReverted };
  }

  siteLink(project: ProjectRecord): string {
    return siteUrl(project);
  }

  repoLink(project: ProjectRecord): string {
    return this.forgejo.repoWebUrl(project.repoName);
  }

  private async writeReadme(project: ProjectRecord): Promise<void> {
    const readme = `# ${project.displayName}\n\nThis is a ${projectKindLabel(project.projectKind)} maintained by the ThreadSite Discord harness.\n\n- Live site: ${this.siteLink(project)}\n\nEvery accepted Discord mutation is committed automatically before publication.\n`;
    await fs.writeFile(safeChild(project.workspacePath, "README.md"), readme, "utf8");
  }
}

function emit(callback: ProgressCallback | undefined, text: string, detail?: string): void {
  if (!callback) return;
  Promise.resolve(callback({ text, detail })).catch(() => undefined);
}

/**
 * Commit subjects are the Discord request itself, so history reads like real
 * work ("add a leaderboard for the top 10 capybaras") instead of a stream of
 * identical "Update game from Discord" commits.
 */
function commitSubjectFor(prompt: string, initial: boolean, kind: ProjectKind): string {
  const line = prompt.replace(/\s+/g, " ").trim().slice(0, 72);
  if (line) return line;
  const noun = kind === "site" ? "site" : "game";
  return initial ? `Create ${noun} from Discord` : `Update ${noun} from Discord`;
}

function starterHtml(name: string): string {
  const safe = name.replace(/[&<>"']/g, "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safe}</title></head><body><main><h1>${safe}</h1><p>Site generation is starting…</p></main></body></html>\n`;
}
