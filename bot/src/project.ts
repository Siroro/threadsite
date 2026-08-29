import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { ForgejoClient } from "./forgejo.js";
import { captureWorkingTreeSnapshot, commitAndPush, commitHistory, ensureGitRepository, ensureLocalBaseline, restoreWorkingTree, undoLastCommit, workingTreeStats } from "./git.js";
import { ensureMultiplayerFiles, multiplayerContext } from "./multiplayer.js";
import { OpenCodeHarness, addUsage, type PromptResult, type TurnUsage } from "./opencode.js";
import { publishIndex, publishSite, siteUrl, validateSite } from "./publish.js";
import { Store } from "./store.js";
import { initialProjectInstruction, mutationInstruction, projectAgents, projectKindLabel, recoveryInstruction, repairInstruction } from "./templates.js";
import type { CommitAuthor, MultiplayerContext, ProjectKind, ProjectRecord } from "./types.js";
import { UsageLog } from "./usage.js";
import type { ProgressCallback } from "./progress.js";
import type { WorkingTreeStats } from "./git.js";
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
  /** Wall-clock duration of the turn: agent work through commit and publish. */
  durationMs: number;
  /** Token/context usage of the turn, when the agent service reported it. */
  usage?: TurnUsage;
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
    readonly usageLog: UsageLog,
  ) {}

  enqueue<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const tracked = next.finally(() => {
      if (this.queues.get(threadId) === tracked) this.queues.delete(threadId);
    });
    // The map only tracks ordering. Without a handler here, a failed work item
    // would surface its rejection through this promise as an unhandled
    // rejection, which is process-fatal on Node 22 and kills every in-flight
    // thread turn instead of failing just this one.
    tracked.catch(() => undefined);
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
    /** Live status message for the initial build, resumed by restart recovery. */
    statusMessageId?: string;
  }, onProgress?: ProgressCallback, onTitle?: (title: string) => Promise<void>): Promise<MutationResult> {
    if (this.store.getProject(input.threadId)) throw new Error("This Discord thread already has a site.");
    // Bot-created threads carry a "site-"/"game-" prefix in their name; keep it
    // out of the slug so the initial repo isn't double-prefixed (site-site-…)
    // when the AI title never lands.
    const displaySource = input.renameable ? input.displayName.replace(/^(?:site|game)-/, "") : input.displayName;
    const baseSlug = slugify(displaySource);
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

    let result = await this.mutate(input.threadId, input.initialPrompt, true, onProgress, input.initiator, input.statusMessageId);

    if (titlePromise && onTitle) {
      const generated = await withTimeout(titlePromise, 90_000);
      if (generated) {
        // The titler prompt is real model usage; ledger it separately from the build turn.
        await this.usageLog.record({
          label: "title",
          threadId: input.threadId,
          project: input.displayName,
          kind: projectKind,
          usage: generated.usage,
          fallbackModel: this.store.getModel(),
        });
      }
      const title = generated?.title;
      if (title) {
        // Adopt the AI title end-to-end: Discord thread name, Forgejo repo,
        // published directory, README, and index. The thread-id suffix is kept
        // on the new slug so identities stay unique and stable.
        let project = result.project;
        const suffix = input.threadId.slice(-6);
        const baseSlug = slugify(title);
        let siteSlug = baseSlug ? `${baseSlug}-${suffix}`.slice(0, 63) : project.siteSlug;
        let repoName = siteSlug !== project.siteSlug ? `site-${siteSlug}`.slice(0, 80) : project.repoName;
        if (siteSlug !== project.siteSlug && !await this.adoptTitleIdentity(project, title, siteSlug, repoName, onProgress)) {
          siteSlug = project.siteSlug;
          repoName = project.repoName;
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

  /**
   * Move every external identity of the project — Forgejo repo name and
   * description, git remote, published directory, committed README — onto the
   * AI title's slug. Each step is idempotent, so the retry after a partial
   * failure converges instead of stranding a half-renamed project. Returns
   * false (and says so in the thread) when both attempts fail.
   */
  private async adoptTitleIdentity(
    project: ProjectRecord,
    title: string,
    siteSlug: string,
    repoName: string,
    onProgress?: ProgressCallback,
  ): Promise<boolean> {
    const description = `${projectKindLabel(project.projectKind)} — ${title}`;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        emit(onProgress, "🏷️ Renaming repository and site to match the title");
        await this.forgejo.renameRepository(project.repoName, repoName, description);
        // Repoint the workspace remote at the renamed repository (Forgejo
        // also leaves a redirect, but the remote should carry the new name).
        await ensureGitRepository(project.workspacePath, repoName, this.forgejo);
        // Restamp the multiplayer tenant id so the published net-config
        // matches the new slug.
        const multiplayer = multiplayerContext(project.projectKind ?? "site", siteSlug);
        if (multiplayer) {
          await ensureMultiplayerFiles(project.workspacePath, multiplayer, project.projectKind ?? "site");
        }
        await this.writeReadme({ ...project, displayName: title, siteSlug, repoName });
        await publishSite(safeChild(project.workspacePath, "site"), siteSlug);
        await fs.rm(safeChild(config.publishRoot, project.siteSlug), { recursive: true, force: true }).catch(() => undefined);
        // Commit the restamped README/net-config now so the Forgejo page and
        // git history carry the new name instead of waiting for the next turn.
        await commitAndPush(project.workspacePath, `Rename project to ${title}`, this.forgejo);
        log("info", "project.renamed_slug", { threadId: project.threadId, from: project.siteSlug, to: siteSlug, repoName });
        return true;
      } catch (error) {
        if (attempt > 1) {
          log("warn", "project.title_rename_failed", { threadId: project.threadId, error: serializeError(error) });
          emit(onProgress, `⚠️ Keeping \`${project.repoName}\` — renaming the repository and site to the title failed`);
          return false;
        }
        await sleep(2_000);
      }
    }
    return false;
  }

  async mutate(threadId: string, prompt: string, initial = false, onProgress?: ProgressCallback, author?: CommitAuthor, statusMessageId?: string): Promise<MutationResult> {
    let project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site. Use /site start first.");
    if (!prompt.trim()) throw new Error("Prompt is empty.");
    if (prompt.length > config.maxPromptChars) throw new Error(`Prompt exceeds MAX_PROMPT_CHARS (${config.maxPromptChars}).`);

    try {
      let agentSummary: string;
      let usage: TurnUsage | undefined;
      const turnStartedAt = Date.now();
      const projectKind = project.projectKind ?? "site";
      // The workspace path never changes across patchProject updates below.
      const workspacePath = project.workspacePath;
      // Repair harness-owned multiplayer files (vendored client, net config,
      // multiplayer AGENTS.md section) in case a previous turn removed them.
      const multiplayer = multiplayerContext(projectKind, project.siteSlug);
      if (multiplayer) {
        emit(onProgress, "🕹️ Ensuring multiplayer client files");
        await ensureMultiplayerFiles(workspacePath, multiplayer, projectKind);
      } else {
        // Non-multiplayer projects get the same per-turn guarantee: AGENTS.md
        // rule updates reach existing threads, not just newly created ones.
        const agentsFile = path.join(workspacePath, "AGENTS.md");
        const agents = projectAgents(projectKind);
        if ((await fs.readFile(agentsFile, "utf8").catch(() => undefined)) !== agents) {
          await fs.writeFile(agentsFile, agents, "utf8");
        }
      }
      // Durable project memory: read fresh each turn so notes land in the very
      // turn after they are written. Missing file is fine (nothing noted yet).
      const notes = await readProjectNotes(project.workspacePath);
      const instruction = initial
        ? initialProjectInstruction(projectKind, prompt, notes)
        : mutationInstruction(projectKind, prompt, notes);

      // Session context lifecycle before the prompt: a long-idle thread starts
      // a fresh session, a heavy previous turn compacts first. Initial turns
      // just created their session, so they always skip this.
      if (!initial) {
        const lifecycle = await this.applySessionLifecycle(project, onProgress);
        if (lifecycle) project = lifecycle;
      }

      const turnBaseline = await captureWorkingTreeSnapshot(workspacePath);
      let stopChangesTimer = () => {};
      const updateChanges = () => {
        void workingTreeStats(workspacePath, turnBaseline)
          .then((changes) => onProgress?.({ kind: "changes", text: formatWorkingTreeStats(changes) }))
          .catch(() => undefined);
      };
      updateChanges();
      const changesTimer = onProgress ? setInterval(updateChanges, 3000) : undefined;
      stopChangesTimer = () => { if (changesTimer) clearInterval(changesTimer); };
      emit(onProgress, initial ? "✨ Building the first version" : "🧠 Applying your requested revision");
      // Persist the in-flight request first: if the bot dies mid-turn, boot
      // recovery uses it to continue, commit, and publish this work.
      project = await this.store.patchProject(threadId, {
        pendingTurn: { prompt, initial, startedAt: new Date().toISOString(), author, statusMessageId },
      });
      try {
        try {
          const result = await this.opencode.prompt(project.workspacePath, project.sessionId, instruction, this.store.getModel(), onProgress, "sitebuilder", this.store.getEffort());
          agentSummary = result.text;
          usage = result.usage;
        } catch (error) {
          if (!/404|not found|unknown session/i.test(errorText(error))) throw error;
          emit(onProgress, "♻️ Recreating a missing agent session");
          const sessionId = await this.opencode.createSession(project.workspacePath, `Discord: ${project.displayName}`);
          project = await this.store.patchProject(threadId, { sessionId });
          const result = await this.opencode.prompt(project.workspacePath, sessionId, instruction, this.store.getModel(), onProgress, "sitebuilder", this.store.getEffort());
          agentSummary = result.text;
          usage = result.usage;
        }
        stopChangesTimer();
      } catch (error) {
        stopChangesTimer();
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
      return await this.completeTurn({
        project, prompt, initial, projectKind, multiplayer, agentSummary, author, onProgress, usage, startedAt: turnStartedAt,
      });
    } catch (error) {
      // The failed attempt still landed its prompt (and possibly partial work)
      // in the session, so it counts as activity for the idle-reset rule even
      // though no fresh usage reading could be observed.
      await this.store.patchProject(threadId, {
        status: "error",
        lastError: truncate(errorText(error), 1000),
        pendingTurn: undefined,
        lastTurnAt: new Date().toISOString(),
      });
      logError("project.mutation_failed", error, { threadId, initial, model: this.store.getModel() || "default" });
      throw error;
    }
  }

  /**
   * Everything after a successful agent prompt: restore harness-owned files,
   * validate (with one repair attempt), commit, publish, and clear the
   * pending-turn marker. Shared by normal turns and restart recovery.
   */
  private async completeTurn(input: {
    project: ProjectRecord;
    prompt: string;
    initial: boolean;
    projectKind: ProjectKind;
    multiplayer: MultiplayerContext | undefined;
    agentSummary: string;
    author?: CommitAuthor;
    onProgress?: ProgressCallback;
    usage?: TurnUsage;
    startedAt: number;
  }): Promise<MutationResult> {
    const threadId = input.project.threadId;
    let project = input.project;
    const workspacePath = project.workspacePath;
    const siteDir = safeChild(workspacePath, "site");
    const restoreHarnessFiles = async (): Promise<void> => {
      if (!input.multiplayer) return;
      if (await ensureMultiplayerFiles(workspacePath, input.multiplayer, input.projectKind)) {
        emit(input.onProgress, "🕹️ Restored harness-owned multiplayer files");
      }
    };
    let agentSummary = input.agentSummary;
    let usage = input.usage;

    await restoreHarnessFiles();
    emit(input.onProgress, "🧪 Validating static output");
    let stats;
    try {
      stats = await validateSite(siteDir);
    } catch (error) {
      // One repair attempt: feed the validation error back to the same agent
      // session, which can see the files it just wrote, then re-validate.
      if (!/JavaScript (?:syntax|type-check) error|Broken local reference/i.test(errorText(error))) throw error;
      log("warn", "project.validation_javascript_retry", { threadId, error: errorText(error) });
      emit(input.onProgress, "🔧 JavaScript validation errors found — asking the agent to repair them");
      const repaired = await this.opencode.prompt(
        workspacePath,
        project.sessionId,
        repairInstruction(errorText(error)),
        this.store.getModel(),
        input.onProgress,
        "sitebuilder",
        this.store.getEffort(),
      );
      agentSummary = repaired.text;
      usage = addUsage(usage, repaired.usage);
      emit(input.onProgress, "🧪 Re-validating after the repair");
      await restoreHarnessFiles();
      stats = await validateSite(siteDir);
    }
    emit(input.onProgress, "📝 Updating project metadata");
    await this.writeReadme(project);
    emit(input.onProgress, "⬆️ Committing and pushing to Forgejo");
    const commitStats = await commitAndPush(
      workspacePath,
      commitSubjectFor(input.prompt, input.initial, input.projectKind),
      this.forgejo,
      input.author,
    );
    emit(input.onProgress, "🚀 Publishing to Apache");
    await publishSite(siteDir, project.siteSlug);
    project = await this.store.patchProject(threadId, {
      status: "ready",
      lastError: undefined,
      lastCommit: commitStats.commit,
      pendingTurn: undefined,
      // Record when the session was last used and how full its context window
      // ended; the next turn's lifecycle check reads both.
      lastTurnAt: new Date().toISOString(),
      ...(usage?.contextTokens ? { lastTurnUsage: { contextTokens: usage.contextTokens, contextLimit: usage.contextLimit } } : {}),
    });
    emit(input.onProgress, "🗂️ Refreshing the public gallery");
    await publishIndex(this.store.listProjects(), (repo) => this.forgejo.repoWebUrl(repo));
    log("info", "project.published", {
      threadId,
      commit: commitStats.commit,
      files: stats.files,
      bytes: stats.bytes,
      commitFiles: commitStats.files,
      additions: commitStats.additions,
      deletions: commitStats.deletions,
      projectKind: input.projectKind,
    });
    // Tokenomics ledger for /site-admin usage. Covers every completed turn —
    // initial builds, mutations, validation-repair passes, and restart
    // recovery. Failed turns are not recorded: their partial usage is not
    // observable once the prompt throws.
    await this.usageLog.record({
      threadId,
      project: project.displayName,
      kind: input.projectKind,
      durationMs: Date.now() - input.startedAt,
      usage,
      fallbackModel: this.store.getModel(),
    });
    return {
      project,
      agentSummary,
      usage,
      durationMs: Date.now() - input.startedAt,
      commit: commitStats.commit,
      commitFiles: commitStats.files,
      additions: commitStats.additions,
      deletions: commitStats.deletions,
      ...stats,
    };
  }

  /**
   * Resume a turn that was in flight when the bot restarted. Waits for the
   * agent service (it may be restarting too) and for a still-running turn to
   * finish, then either commits already-completed work or asks the session to
   * continue the interrupted change, and runs the normal publish tail. The
   * continue-prompt is bounded by the reconcile window so a wedged agent turn
   * cannot hold the thread's queue — and every message queued behind it —
   * forever.
   */
  async recoverTurn(threadId: string, onProgress?: ProgressCallback): Promise<MutationResult> {
    let project = this.store.getProject(threadId);
    const pending = project?.pendingTurn;
    if (!project || !pending) throw new Error("This thread has no interrupted turn to recover.");
    const projectKind = project.projectKind ?? "site";
    const turnStartedAt = Date.now();
    log("info", "project.recovery_started", { threadId, initial: pending.initial, startedAt: pending.startedAt });

    try {
      emit(onProgress, "🔌 Waiting for the agent service to be reachable");
      await this.waitForAgentService();
      emit(onProgress, "⏳ Waiting for the interrupted agent turn to finish");
      await this.waitForIdleTurn(project.workspacePath, project.sessionId);

      let agentSummary: string;
      let usage: TurnUsage | undefined;
      if (await this.turnCompletedSince(project.workspacePath, project.sessionId, pending.startedAt)) {
        // The turn finished on the agent side while the bot was down; only the
        // commit/publish tail was lost. Token usage was not observable then.
        log("info", "project.recovery_already_completed", { threadId });
        emit(onProgress, "✅ The interrupted turn had already finished on the agent side");
        agentSummary = "This turn had already finished on the agent side before the restart; it was committed and published by recovery.";
      } else {
        const notes = await readProjectNotes(project.workspacePath);
        try {
          const result = await this.recoveryPrompt(project.workspacePath, project.sessionId, recoveryInstruction(pending.prompt, notes), onProgress, threadId);
          agentSummary = result.text;
          usage = result.usage;
        } catch (error) {
          if (!/404|not found|unknown session/i.test(errorText(error))) throw error;
          log("warn", "project.recovery_session_lost", { threadId, sessionId: project.sessionId });
          const sessionId = await this.opencode.createSession(project.workspacePath, `Discord: ${project.displayName}`);
          project = await this.store.patchProject(threadId, { sessionId });
          const instruction = pending.initial
            ? initialProjectInstruction(projectKind, pending.prompt, notes)
            : mutationInstruction(projectKind, pending.prompt, notes);
          const result = await this.recoveryPrompt(project.workspacePath, sessionId, instruction, onProgress, threadId);
          agentSummary = result.text;
          usage = result.usage;
        }
      }
      const result = await this.completeTurn({
        project,
        prompt: pending.prompt,
        initial: pending.initial,
        projectKind,
        multiplayer: multiplayerContext(projectKind, project.siteSlug),
        agentSummary,
        author: pending.author,
        onProgress,
        usage,
        startedAt: turnStartedAt,
      });
      log("info", "project.recovery_completed", { threadId, commit: result.commit });
      return result;
    } catch (error) {
      await this.store.patchProject(threadId, {
        status: "error",
        lastError: truncate(errorText(error), 1000),
        pendingTurn: undefined,
        lastTurnAt: new Date().toISOString(),
      });
      logError("project.recovery_failed", error, { threadId });
      throw error;
    }
  }

  /**
   * One agent prompt during restart recovery, bounded by the reconcile window.
   * On timeout the orphaned turn is aborted best-effort so the thread's queue
   * frees up cleanly for the next message.
   */
  private async recoveryPrompt(
    workspacePath: string,
    sessionId: string,
    instruction: string,
    onProgress: ProgressCallback | undefined,
    threadId: string,
  ): Promise<PromptResult> {
    const pending = this.opencode.prompt(workspacePath, sessionId, instruction, this.store.getModel(), onProgress, "sitebuilder", this.store.getEffort());
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(
              `Restart recovery timed out after ${Math.round(config.opencodeReconcileTimeoutMs / 60000)} minutes of agent work; the orphaned turn was abandoned.`,
            ));
          }, config.opencodeReconcileTimeoutMs);
        }),
      ]);
    } catch (error) {
      if (timedOut) {
        emit(onProgress, "🛑 Recovery window exhausted — stopping the orphaned agent turn");
        await this.opencode.abortTurn(workspacePath, sessionId).catch((abortError) => {
          log("warn", "project.recovery_abort_failed", { threadId, error: serializeError(abortError) });
        });
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Block until the agent service answers health checks, or give up. */
  private async waitForAgentService(timeoutMs = config.opencodeReconcileTimeoutMs): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.opencode.health().catch(() => "unavailable");
      if (status.startsWith("ok")) return;
      await sleep(config.opencodeReconcilePollMs);
    }
    throw new Error(`The agent service did not come back within ${Math.round(timeoutMs / 60000)} minutes; restart recovery gave up.`);
  }

  /** Block while the session still reports a running turn (bot restart only). */
  private async waitForIdleTurn(workspacePath: string, sessionId: string, timeoutMs = config.opencodeReconcileTimeoutMs): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let sawBusy = false;
    while (Date.now() < deadline) {
      const busy = await this.opencode.isBusy(workspacePath, sessionId).catch(() => false);
      if (!busy) return;
      sawBusy = true;
      await sleep(config.opencodeReconcilePollMs);
    }
    if (sawBusy) throw new Error("The interrupted agent turn kept running past the recovery window; recovery gave up waiting for it.");
  }

  /** Whether an assistant message completed after the given timestamp. */
  private async turnCompletedSince(workspacePath: string, sessionId: string, sinceIso: string): Promise<boolean> {
    const since = Date.parse(sinceIso);
    if (!Number.isFinite(since)) return false;
    try {
      const messages = await this.opencode.listMessages(workspacePath, sessionId, 100);
      return messages.some((message) => {
        const info = message.info;
        return Boolean(info?.id && info.role === "assistant" && !info.error && (info.time?.completed ?? 0) > since - 2_000);
      });
    } catch {
      return false;
    }
  }

  /**
   * Session context lifecycle, applied before every non-initial turn:
   *
   * - A thread idle longer than SESSION_IDLE_RESET_MS starts a fresh session.
   *   By then the provider's prompt cache is cold anyway and the old
   *   conversation is mostly stale turn-by-turn detail; the workspace, git
   *   history, and PROJECT_NOTES.md carry everything durable, and the
   *   mutation instruction already tells the agent to inspect before editing.
   * - A session whose previous turn ended above SESSION_CONTEXT_COMPACT_THRESHOLD
   *   of its context window is compacted now, at the turn boundary, so the
   *   next turn starts on a summarized window instead of paying for a near-full
   *   one (or triggering a mid-turn auto-compaction).
   *
   * Returns the patched project when the session changed, else undefined.
   */
  private async applySessionLifecycle(project: ProjectRecord, onProgress?: ProgressCallback): Promise<ProjectRecord | undefined> {
    const threadId = project.threadId;

    if (config.sessionIdleResetMs > 0 && project.lastTurnAt) {
      const idleMs = Date.now() - Date.parse(project.lastTurnAt);
      if (Number.isFinite(idleMs) && idleMs > config.sessionIdleResetMs) {
        emit(onProgress, "🧹 Previous context expired — starting a fresh agent session");
        const sessionId = await this.opencode.createSession(project.workspacePath, `Discord: ${project.displayName}`);
        const patched = await this.store.patchProject(threadId, { sessionId, lastTurnUsage: undefined });
        log("info", "project.session_auto_reset", {
          threadId,
          oldSessionId: project.sessionId,
          sessionId,
          idleMs,
          idleResetMs: config.sessionIdleResetMs,
        });
        return patched;
      }
    }

    const usage = project.lastTurnUsage;
    const threshold = config.sessionCompactThreshold;
    if (threshold <= 0 || !usage?.contextLimit || usage.contextTokens <= 0) return undefined;
    if (usage.contextTokens <= threshold * usage.contextLimit) return undefined;

    const percent = Math.round((usage.contextTokens / usage.contextLimit) * 100);
    emit(onProgress, `🧹 Context was ${percent}% full after the last turn — compacting before this one`);
    try {
      const model = (await this.opencode.lastAssistantModel(project.workspacePath, project.sessionId))
        ?? parseModel(this.store.getModel());
      if (!model) {
        log("warn", "project.session_auto_compact_skipped", { threadId, reason: "no model known for the session" });
        return undefined;
      }
      await this.opencode.compactSession(project.workspacePath, project.sessionId, model.providerID, model.modelID);
      // Drop the stale reading so a later failed turn cannot re-compact an
      // already-compacted session.
      const patched = await this.store.patchProject(threadId, { lastTurnUsage: undefined });
      log("info", "project.session_auto_compacted", { threadId, percent, model: `${model.providerID}/${model.modelID}` });
      return patched;
    } catch (error) {
      // Not fatal: the turn proceeds on the full window and OpenCode's own
      // auto-compaction (relative to SURPLUS_CONTEXT_CAP) remains the safety net.
      log("warn", "project.session_auto_compact_failed", { threadId, error: serializeError(error) });
      return undefined;
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
    // The new session has no turns yet, so it can be neither stale nor due for
    // compaction; clearing both keeps the lifecycle rules from acting on the
    // previous session's history.
    const updated = await this.store.patchProject(threadId, { sessionId, lastTurnUsage: undefined, lastTurnAt: undefined });
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

/** Durable project memory (PROJECT_NOTES.md); empty when no notes exist yet. */
async function readProjectNotes(workspacePath: string): Promise<string | undefined> {
  const notes = await fs.readFile(path.join(workspacePath, "PROJECT_NOTES.md"), "utf8").catch(() => undefined);
  return notes?.trim() ? notes : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatWorkingTreeStats(stats: WorkingTreeStats): string {
  const kinds = [
    stats.added ? `${stats.added} added` : "",
    stats.modified ? `${stats.modified} modified` : "",
    stats.deleted ? `${stats.deleted} deleted` : "",
  ].filter(Boolean);
  const breakdown = kinds.length ? ` (${kinds.join(", ")})` : "";
  return `✏️ this turn · ${stats.files} file${stats.files === 1 ? "" : "s"}${breakdown} · +${stats.additions}/−${stats.deletions} lines`;
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
