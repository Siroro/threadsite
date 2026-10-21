import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { ForgejoClient } from "./forgejo.js";
import { captureWorkingTreeSnapshot, commitAndPush, commitHistory, currentHead, ensureGitRepository, ensureLocalBaseline, generatePushCredentials, resetToCommit, restoreWorkingTree, syncToRemote, syncWithRemote, turnRevertTarget, undoLastCommit, workingTreeClean, workingTreeStats } from "./git.js";
import { ensureMultiplayerFiles, multiplayerContext, removeMultiplayerFiles } from "./multiplayer.js";
import { OpenCodeHarness, addUsage, errorUsage, isTerminalAssistant, reconcileUsage, usageFromMessages, type PromptImage, type PromptResult, type TurnUsage } from "./opencode.js";
import { PROJECT_CARD_VERSION } from "./project-card.js";
import { publishIndex, publishSite, publishSiteRedirects, siteUrl, validateSite } from "./publish.js";
import { buildSite, GENERATED_GITIGNORE } from "./build.js";
import { enginePackages, ensureEnginePackages } from "./engines.js";
import { ensureSkillFiles, skillNames } from "./skills.js";
import { Store, pendingTurnMatches } from "./store.js";
import { initialProjectInstruction, multiplayerModeLabel, multiplayerSwapInstruction, mutationInstruction, projectAgents, projectKindLabel, recoveryInstruction, repairInstruction } from "./templates.js";
import { starterHtml, starterSource } from "./starter.js";
import type { CommitAuthor, MultiplayerContext, MultiplayerMode, ProjectKind, ProjectRecord } from "./types.js";
import { UsageLog } from "./usage.js";
import type { ProgressCallback, ProgressPhase } from "./progress.js";
import type { WorkingTreeStats } from "./git.js";
import { log, logError, serializeError } from "./logger.js";
import { errorText, formatShortDuration, formatTokens, parseModel, safeChild, slugify, truncate, withTimeout, sleep } from "./util.js";
import { browserQaFeedback, runBrowserQa as driveBrowserQa, type BrowserQaResult } from "./browser-qa.js";
import { assertExclusiveResources, projectAccounts, projectRepos, removalPaths } from "./project-removal.js";
import { deleteRelayGame } from "./relay-cleanup.js";
import { pushRenameMetadata } from "./git.js";
import { fallbackProjectName, needsProjectNaming, projectName } from "./naming.js";

/**
 * The model-written preview of a project: one line on what it is, one line on
 * what the last change added, one line on how to play it. Shown on the play
 * card beside the screenshot.
 */
export interface ProjectPreview {
  /** What the project is and what a visitor gets to do. */
  pitch: string;
  /** What the latest turn added, when it added something a visitor can see. */
  added?: string;
  /** How to play it, or what to try first. */
  play?: string;
}

export interface MutationResult {
  project: ProjectRecord;
  agentSummary: string;
  /** Commit created by this turn; undefined when committing itself failed or when the turn changed nothing. */
  commit?: string;
  /** Files changed by the commit itself (vs. total files in site/). */
  commitFiles: number;
  /** Lines added and removed by the commit. */
  additions: number;
  deletions: number;
  /** True when the turn changed nothing — no commit was created and none was needed. */
  noChanges?: boolean;
  files: number;
  bytes: number;
  /** Wall-clock duration of the turn: agent work through commit and publish. */
  durationMs: number;
  /** Token/context usage of the turn, when the agent service reported it. */
  usage?: TurnUsage;
  /** PNG screenshot of the finished result from browser QA, when captured. */
  screenshot?: Uint8Array;
  /** Model-written preview of the project as it stands, for the play card. */
  preview?: ProjectPreview;
  /** Confirmed browser-QA findings; browser QA never blocks an otherwise valid build. */
  browserQaFindings?: string[];
  /** Validation errors that kept the turn unpublished; the work is committed. */
  validationError?: string;
  /** Commit/publish pipeline failure after the agent finished; see commit for how far it got. */
  deliveryError?: string;
}

export interface RevertResult {
  /** Commit removed from git/publication, when the last turn had been accepted. */
  undoneCommit?: string;
  /** Commit the workspace was reset to and republished. */
  keptCommit?: string;
  /** Whether OpenCode's conversation for the turn was also reverted. */
  conversationReverted: boolean;
}

/** What a Stop request actually managed to do (see ProjectService.stopTurn). */
export interface StopTurnOutcome {
  /** An agent turn was running and the abort landed. */
  stopped: boolean;
  /** The turn is past the agent phase (build/commit/publish) and finishes on its own. */
  delivering: boolean;
  /** The agent service did not answer, so the wedged queue was freed instead. */
  queueFreed: boolean;
}

/**
 * A turn stopped mid-flight at the user's request (the Stop button): the agent
 * turn was aborted but the session, workspace, and history are all kept, and
 * whatever partial edits the agent had made are preserved. Carries the
 * original rejection as its cause.
 */
export class TurnStoppedError extends Error {}

/**
 * Per-thread queue state. `tail` orders newly enqueued work; `waiters` holds
 * the not-yet-started items' gates, oldest first, so a hard reset can sever
 * the chain when the item holding the queue can never settle on its own
 * (agent HTTP timeouts are disabled by design, so a turn wedged on a dead
 * agent connection would otherwise block the thread forever).
 */
interface QueueState {
  tail: Promise<unknown>;
  waiters: Array<{ resolve: () => void }>;
}

function unreleased(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

export class ProjectService {
  private readonly queues = new Map<string, QueueState>();
  /** Threads whose running turn the user asked to stop via the Stop button. */
  private readonly stopRequested = new Set<string>();
  /**
   * Threads whose turn has left the agent and is now in the delivery tail
   * (restore/validate/commit/publish). Such a turn is not "busy" but still
   * holds the queue and releases it on its own, so the hard resets must not
   * sever it — that would start a second pipeline on the same worktree.
   */
  private readonly delivering = new Set<string>();
  /** Turns currently between mutate()/recoverTurn() entry and settlement. */
  private activeTurns = 0;
  /**
   * Threads with a turn between entry and settlement — including the whole
   * pre-prompt phase, where OpenCode reports nothing busy yet. stopTurn()
   * reads it to honor a stop for a turn that has not reached the agent (or is
   * prompting an unreachable service): the turn bails at its next checkpoint.
   */
  private readonly activeTurnThreads = new Set<string>();
  private identityTail: Promise<unknown> = Promise.resolve();
  private readonly deletions = new Map<string, Promise<void>>();
  private readonly runningOperations = new Map<string, number>();
  private readonly titleCallbacks = new Map<string, (title: string) => Promise<void>>();

  constructor(
    readonly store: Store,
    readonly opencode: OpenCodeHarness,
    readonly forgejo: ForgejoClient,
    readonly usageLog: UsageLog,
    private readonly renameThread?: (project: ProjectRecord, title: string) => Promise<void>,
  ) {}

  /** Required queue barrier: the project identity and Discord acknowledgement must finish before another prompt. */
  async ensureProjectName(threadId: string, onProgress?: ProgressCallback): Promise<ProjectRecord> {
    let project = this.store.getProject(threadId);
    if (!project || project.pendingDeletion) throw new TurnStoppedError("Project deletion is pending.");
    if (!needsProjectNaming(project) && !project.pendingRename && !project.pendingThreadName) return project;
    if (project.pendingTurn || await this.agentBusy(threadId)) throw new Error("Recover or finish the current turn before completing the project name.");
    if (project.pendingRename) project = await this.resumeRename(threadId, onProgress);
    if (needsProjectNaming(project)) {
      const automatic = /^(?:site|game)-/i.test(project.displayName);
      let naming = project.pendingNaming ?? {
        request: project.initialPrompt || project.displayName,
        ...(automatic ? {} : { name: project.displayName }),
      };
      project = await this.store.patchProject(threadId, { pendingNaming: naming });
      let name = naming.name && projectName(naming.name);
      if (!name) {
        emit(onProgress, "🏷️ Choosing a permanent project name");
        const primary = this.store.getModel() || (typeof this.opencode.listSelectableModels === "function"
          ? (await this.opencode.listSelectableModels().catch(() => []))[0] : undefined);
        const models: Array<string | undefined> = [primary];
        for (let attempt = 0; attempt < models.length && attempt < 3; attempt++) {
          if (this.store.getProject(threadId)?.pendingDeletion) throw new TurnStoppedError("Project deleted while choosing its name.");
          const model = models[attempt];
          try {
            const generated = await this.opencode.generateTitle(project.workspacePath, naming.request, model);
            name = generated.title && projectName(generated.title);
            await this.usageLog.record({ label: "title", threadId, project: project.displayName,
              kind: project.projectKind ?? "site", usage: generated.usage, fallbackModel: model, failed: !name });
            if (name) break;
            throw new Error("The title model did not return a usable name.");
          } catch (error) {
            const usage = errorUsage(error);
            if (usage) await this.usageLog.record({ label: "title", threadId, project: project.displayName,
              kind: project.projectKind ?? "site", usage, fallbackModel: model, failed: true });
            log("warn", "project.title_generation_failed", { threadId, model, error: serializeError(error) });
            if (attempt === 0) {
              const available = typeof this.opencode.listSelectableModels === "function"
                ? await this.opencode.listSelectableModels().catch(() => []) : [];
              const provider = parseModel(primary)?.providerID;
              available.sort((a, b) => Number(parseModel(a)?.providerID === provider) - Number(parseModel(b)?.providerID === provider));
              for (const alternative of [...config.opencodeFailoverModels, ...available]) {
                if (alternative && !models.includes(alternative)) models.push(alternative);
              }
            }
          }
        }
        name ||= fallbackProjectName(naming.request, project.projectKind);
        // Save the chosen name before any remote operation, so restarts never regenerate it.
        naming = { ...naming, name };
        project = await this.store.patchProject(threadId, { pendingNaming: naming });
      }
      if (project.displayName !== name || project.repoName !== project.siteSlug || /^(?:site|game)-/.test(project.siteSlug)) {
        project = await this.renameProject(threadId, name, onProgress, true);
      }
    }
    if (project.pendingNaming || project.pendingThreadName) await publishIndex(this.store.listProjects(), (repo) => this.forgejo.repoWebUrl(repo));
    if (project.pendingThreadName) {
      const callback = this.titleCallbacks.get(threadId);
      if (this.renameThread) await this.renameThread(project, project.pendingThreadName);
      else if (callback) await callback(project.pendingThreadName);
      if (callback || this.renameThread) project = await this.store.patchProject(threadId, { pendingThreadName: undefined });
    }
    if (project.pendingNaming) project = await this.store.patchProject(threadId, { pendingNaming: undefined });
    return project;
  }

  /** Backfill missed historical events; safe to retry after every startup. */
  async reconcileProjectUsage(threadId: string): Promise<boolean> {
    const project = this.store.getProject(threadId);
    if (!project?.sessionId || !project.workspacePath) return false;
    try {
      return await this.usageLog.reconcileThread(threadId, project.sessionId,
        await this.opencode.usageMessages(project.workspacePath, project.sessionId));
    } catch (error) {
      log("warn", "usage.reconcile_failed", { threadId, error: errorText(error) });
      return false;
    }
  }

  private async recordTurnUsage(project: ProjectRecord, pending: ProjectRecord["pendingTurn"],
    usage: TurnUsage | undefined, failed: boolean, durationMs: number): Promise<TurnUsage | undefined> {
    if (pending && typeof this.opencode.usageMessages === "function") {
      try {
        usage = reconcileUsage(usage, usageFromMessages(
          await this.opencode.usageMessages(project.workspacePath, project.sessionId), Date.parse(pending.startedAt)));
      } catch (error) {
        log("warn", "usage.turn_history_failed", { threadId: project.threadId, error: errorText(error) });
      }
    }
    await this.usageLog.record({
      id: pending ? pending.id ?? `${project.threadId}:${pending.startedAt}` : undefined,
      sessionId: project.sessionId, startedAt: pending?.startedAt,
      threadId: project.threadId, project: project.displayName, kind: project.projectKind ?? "site",
      durationMs, usage, fallbackModel: this.store.getModel(), failed,
    });
    return usage;
  }

  /** Recreate ignored harness build inputs after a checkout/clean or on a fresh host. */
  private async ensureHarnessBuildInputs(project: ProjectRecord): Promise<void> {
    await ensureEnginePackages(project.workspacePath, project.projectKind ?? "site");
    const multiplayer = multiplayerContext(project.projectKind ?? "site", project.multiplayerGameId ?? project.siteSlug, project.multiplayerMode);
    if (multiplayer) await ensureMultiplayerFiles(project.workspacePath, multiplayer, project.projectKind ?? "site");
  }

  /** Webhooks accelerate push detection; their failure must not block a build or rename. */
  private async ensureProjectWebhook(repoName: string): Promise<void> {
    const secret = this.store.getWebhookSecret();
    if (!config.webhookEnabled || !secret) return;
    try {
      await this.forgejo.ensurePushWebhook(repoName, `${config.webhookPublicUrl}/hooks/forgejo`, secret);
    } catch (error) {
      log("warn", "webhook.ensure_failed", { repoName, pollingEnabled: config.externalPushPollMs > 0, error: serializeError(error) });
    }
  }

  enqueue<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    if (this.store.getProject(threadId)?.pendingDeletion) return Promise.reject(new TurnStoppedError("Project deletion is pending."));
    let state = this.queues.get(threadId);
    if (!state) {
      state = { tail: Promise.resolve(), waiters: [] };
      this.queues.set(threadId, state);
    }
    const previous = state.tail;
    const gate = unreleased();
    state.waiters.push(gate);
    const next = (async () => {
      // Wait for the previous item — unless a hard reset severs the chain,
      // which means the item holding the queue was abandoned and may never
      // settle; waiting on it would wedge the thread forever.
      await Promise.race([previous.catch(() => undefined), gate.promise]);
      const index = state.waiters.indexOf(gate);
      if (index >= 0) state.waiters.splice(index, 1);
      if (this.store.getProject(threadId)?.pendingDeletion) throw new TurnStoppedError("Project deletion is pending.");
      this.runningOperations.set(threadId, (this.runningOperations.get(threadId) ?? 0) + 1);
      try { return await work(); }
      finally { this.runningOperations.set(threadId, (this.runningOperations.get(threadId) ?? 1) - 1); }
    })();
    const tracked = next.finally(() => {
      if (this.queues.get(threadId) === state && state.tail === tracked) this.queues.delete(threadId);
    });
    // The map only tracks ordering. Without a handler here, a failed work item
    // would surface its rejection through this promise as an unhandled
    // rejection, which is process-fatal on Node 22 and kills every in-flight
    // thread turn instead of failing just this one.
    tracked.catch(() => undefined);
    state.tail = tracked;
    return next;
  }

  /**
   * Detach the thread's queue from an item that may never settle, used by the
   * hard resets. Only the FIRST waiter is released: the item directly behind
   * the abandoned queue holder proceeds (concurrently with the abandoned
   * item, which reports its own failure in the thread), and every waiter
   * behind it stays serialized through its predecessor — releasing them all
   * at once would run N concurrent mutate pipelines on one worktree. When
   * nothing is waiting, the tail itself is the abandoned item, so the chain
   * is rebased: work enqueued after the sever must not wait on a promise
   * that may never settle.
   */
  private severQueue(threadId: string): void {
    const state = this.queues.get(threadId);
    if (!state) return;
    const head = state.waiters.shift();
    if (head) {
      head.resolve();
    } else {
      state.tail = Promise.resolve();
    }
    log("warn", "project.queue_severed", { threadId, releasedWaiter: Boolean(head) });
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
    /** The pinned project card posted at thread creation; linked into the record. */
    infoMessageId?: string;
    /** Multiplayer architecture for games; omitted means arena (the default). */
    multiplayerMode?: MultiplayerMode;
    /** Discord user who requested the project, pinged when the agent asks a question. */
    initiatorUserId?: string;
  }, onProgress?: ProgressCallback, onTitle?: (title: string) => Promise<void>): Promise<MutationResult> {
    this.runningOperations.set(input.threadId, (this.runningOperations.get(input.threadId) ?? 0) + 1);
    if (onTitle) this.titleCallbacks.set(input.threadId, onTitle);
    try {
    if (this.store.getProject(input.threadId)) throw new Error("This Discord thread already has a site.");
    // Bot-created threads carry a "site-"/"game-" prefix in their name; keep it
    // out of the temporary slug so the initial repo isn't double-prefixed.
    // The durable naming request replaces this identity after delivery.
    const displaySource = input.renameable ? input.displayName.replace(/^(?:site|game)-/, "") : input.displayName;
    const baseSlug = slugify(displaySource);
    // Temporary identity uses the complete snowflake; short suffixes can collide.
    const siteSlug = `${baseSlug.slice(0, 62 - input.threadId.length)}-${input.threadId}`;
    const repoName = `site-${siteSlug}`.slice(0, 80);
    const workspacePath = safeChild(config.workspaceRoot, input.guildId, input.threadId);
    const siteDir = safeChild(workspacePath, "site");
    const projectKind = input.projectKind ?? "site";
    const multiplayerMode = input.multiplayerMode ?? "arena";
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      threadId: input.threadId,
      guildId: input.guildId,
      parentChannelId: input.parentChannelId,
      displayName: input.displayName,
      workspacePath,
      siteSlug,
      repoName,
      sessionId: "",
      projectKind,
      status: "creating",
      createdAt: now,
      updatedAt: now,
      // The card's front page: the original request outlives pendingTurn. The
      // card id arrives from the already-posted message, so it is stamped with
      // the design version it was rendered at.
      initialPrompt: truncate(input.initialPrompt, 2_000),
      pendingNaming: { request: input.initialPrompt, ...(input.renameable ? {} : { name: input.displayName }) },
      ...(projectKind !== "site" ? { multiplayerMode } : {}),
      infoMessageId: input.infoMessageId,
      infoCardVersion: input.infoMessageId ? PROJECT_CARD_VERSION : undefined,
    };
    await this.store.putProject(project);


    emit(onProgress, "📁 Preparing persistent workspace");
    const srcDir = safeChild(workspacePath, "site", "src");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(siteDir, "index.html"), starterHtml(input.displayName), "utf8");
    await fs.writeFile(path.join(srcDir, "main.ts"), starterSource(projectKind), "utf8");
    // Authored source plus the vendored net client (site/net/) is the Git
    // record. Harness build inputs and generated bundles are recreated locally
    // and never enter Forgejo.
    await fs.writeFile(path.join(workspacePath, ".gitignore"), `${GENERATED_GITIGNORE.join("\n")}\n`, "utf8");
    const multiplayer = multiplayerContext(projectKind, siteSlug, multiplayerMode);
    if (multiplayer) {
      // Games are multi-tenant clients of the shared relay: vendored protocol
      // client + this game's net config + the multiplayer AGENTS.md section.
      emit(onProgress, multiplayerMode === "rooms" ? "🕹️ Provisioning the multiplayer client (invite-code rooms)" : "🕹️ Provisioning the multiplayer client (shared arena)");
      await ensureMultiplayerFiles(workspacePath, multiplayer, projectKind);
    } else if (projectKind !== "site") {
      emit(onProgress, "🕹️ Singleplayer game — no multiplayer client");
      await fs.writeFile(path.join(workspacePath, "AGENTS.md"), await projectAgents(projectKind, undefined, true), "utf8");
    } else {
      emit(onProgress, "🧭 Writing project-specific AGENTS.md");
      await fs.writeFile(path.join(workspacePath, "AGENTS.md"), await projectAgents(projectKind), "utf8");
    }
    if (enginePackages(projectKind).length) {
      // The engine package is installed before the agent session starts, like
      // a dependency manager would, and re-seeded every turn if it ever goes
      // missing — authored code just imports "three"/"phaser".
      emit(onProgress, "📦 Installing the engine package (node_modules)");
      await ensureEnginePackages(workspacePath, projectKind);
    }
    if (skillNames(projectKind).length) {
      // The matching curated engine/game playbooks ride along as repo content;
      // OpenCode discovers them from the workspace root and loads them on demand.
      emit(onProgress, "🎓 Installing the curated game skills (.opencode/skills)");
      await ensureSkillFiles(workspacePath, projectKind);
    }
    // Compile the ignored starter bundle so validation/publish have runnable
    // output; the baseline commit intentionally records only authored source.
    await buildSite(workspacePath);

    emit(onProgress, "🌱 Creating/checking Forgejo repository");
    await this.forgejo.ensureRepository(repoName, `${projectKindLabel(projectKind)} generated from Discord thread ${input.displayName}`);
    if (config.webhookEnabled) emit(onProgress, "🔗 Registering the Forgejo push webhook");
    await this.ensureProjectWebhook(repoName);
    emit(onProgress, "🧱 Initialising git workspace");
    await ensureGitRepository(workspacePath, repoName, this.forgejo);
    await ensureLocalBaseline(workspacePath);
    emit(onProgress, "🧠 Starting the persistent agent session");
    const sessionId = await this.opencode.createSession(workspacePath, `Discord: ${input.displayName}`);

    await this.store.patchProject(input.threadId, { sessionId });
    project.sessionId = sessionId;
    log("info", "project.created", { threadId: input.threadId, projectKind, repoName, siteSlug });

    const result = await this.mutate(input.threadId, input.initialPrompt, true, onProgress, input.initiator, input.statusMessageId, undefined, [], undefined, input.initiatorUserId);

    return result;
    } catch (error) {
      if (this.store.getProject(input.threadId)?.pendingDeletion) throw new TurnStoppedError("Project deleted during setup.", { cause: error });
      throw error;
    } finally {
      this.titleCallbacks.delete(input.threadId);
      this.runningOperations.set(input.threadId, (this.runningOperations.get(input.threadId) ?? 1) - 1);
    }
  }

  /** Reserve names before remote changes so concurrent projects cannot choose the same URL. */
  async renameProject(threadId: string, name: string, onProgress?: ProgressCallback, allowUnfinished = false): Promise<ProjectRecord> {
    this.runningOperations.set(threadId, (this.runningOperations.get(threadId) ?? 0) + 1);
    try {
    const displayName = projectName(name);
    if (!displayName) throw new Error("Choose a non-empty project name.");
    if (this.store.getProject(threadId)?.pendingRename) await this.resumeRename(threadId, onProgress);
    const reserve = this.identityTail.catch(() => undefined).then(async () => {
      const project = this.store.getProject(threadId);
      if (!project) throw new Error("This thread is not attached to a site.");
      if ((!allowUnfinished && project.status !== "ready") || project.pendingTurn || await this.agentBusy(threadId)) {
        throw new Error("Finish or recover the current update before renaming this project.");
      }
      const clean = await workingTreeClean(project.workspacePath);
      if (!clean && !allowUnfinished) throw new Error("Finish or roll back the workspace edits before renaming.");
      const source = await this.forgejo.repositoryInfo(project.repoName);
      if (!source) throw new Error("The source repository could not be found.");
      const base = slugify(displayName, "untitled-project").replace(/^(?:(?:site|game)-)+/, "") || "untitled-project";
      const candidates = [base, `${base}-${threadId.slice(-6)}`, `${base.slice(0, 62 - threadId.length)}-${threadId}`];
      for (const siteSlug of candidates) {
        const repoName = siteSlug;
        const occupied = this.store.listProjects().some((other) => other.threadId !== threadId &&
          [other.siteSlug, ...(other.siteAliases ?? []), other.pendingRename?.siteSlug].includes(siteSlug));
        if (occupied) continue;
        const owned = siteSlug === project.siteSlug || project.siteAliases?.includes(siteSlug);
        if (!owned && await fs.lstat(safeChild(config.publishRoot, siteSlug)).then(() => true, () => false)) continue;
        const target = await this.forgejo.repositoryInfo(repoName);
        if (target && target.id !== source.id) continue;
        await this.store.patchProject(threadId, {
          multiplayerGameId: project.multiplayerMode === "singleplayer"
            ? project.multiplayerGameId
            : project.multiplayerGameId ?? project.siteSlug,
          ...(project.pendingNaming ? { pendingNaming: { ...project.pendingNaming, name: displayName } } : {}),
          pendingRename: { displayName, siteSlug, repoName, fromSiteSlug: project.siteSlug, fromRepoName: project.repoName, repoId: source.id,
            ...(!clean || project.status !== "ready" ? { preserveWorktree: true } : {}) },
        });
        return;
      }
      throw new Error("That project name is already in use. Choose another name.");
    });
    this.identityTail = reserve;
    await reserve;
    return await this.resumeRename(threadId, onProgress);
    } finally { this.runningOperations.set(threadId, (this.runningOperations.get(threadId) ?? 1) - 1); }
  }

  /** Every step can be repeated after failure or restart, using the persisted repo ID. */
  async resumeRename(threadId: string, onProgress?: ProgressCallback): Promise<ProjectRecord> {
    this.runningOperations.set(threadId, (this.runningOperations.get(threadId) ?? 0) + 1);
    try {
    let project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site.");
    const intent = project.pendingRename;
    if (!intent) return project;
    emit(onProgress, "🏷️ Updating the project name, repository and live links");
    await this.forgejo.renameRepository(intent.fromRepoName, intent.repoName,
      `${projectKindLabel(project.projectKind)} — ${intent.displayName}`, intent.repoId);
    // Persist a successful remote rename immediately, even if later delivery fails.
    project = await this.store.patchProject(threadId, { repoName: intent.repoName });
    await ensureGitRepository(project.workspacePath, intent.repoName, this.forgejo);
    await this.ensureProjectWebhook(intent.repoName);
    const renamed = { ...project, displayName: intent.displayName, siteSlug: intent.siteSlug };
    await this.writeReadme(renamed);
    if (intent.preserveWorktree) {
      await pushRenameMetadata(project.workspacePath, intent.displayName, this.forgejo);
      const previousLive = safeChild(config.publishRoot, intent.fromSiteSlug);
      const nextLive = safeChild(config.publishRoot, intent.siteSlug);
      const hasNext = await fs.stat(nextLive).then((stat) => stat.isDirectory(), () => false);
      const hasPrevious = await fs.stat(previousLive).then((stat) => stat.isDirectory(), () => false);
      if (!hasNext && hasPrevious) await publishSite(previousLive, intent.siteSlug);
      const aliases = [...new Set([...(project.siteAliases ?? []), intent.fromSiteSlug])].filter((slug) => slug !== intent.siteSlug);
      if (hasPrevious || hasNext) await publishSiteRedirects(aliases, intent.siteSlug);
      const head = await currentHead(project.workspacePath);
      project = await this.store.patchProject(threadId, {
        displayName: intent.displayName, siteSlug: intent.siteSlug, repoName: intent.repoName,
        siteAliases: aliases, lastSeenCommit: head, pendingRename: undefined, pendingThreadName: intent.displayName,
      });
      await publishIndex(this.store.listProjects(), (repo) => this.forgejo.repoWebUrl(repo));
      return project;
    }
    await this.ensureHarnessBuildInputs(renamed);
    const siteDir = safeChild(project.workspacePath, "site");
    await buildSite(project.workspacePath);
    await validateSite(siteDir);
    const committed = await commitAndPush(project.workspacePath, `Rename project to ${intent.displayName}`, this.forgejo);
    // A previous attempt may have committed locally before its push failed.
    if (!committed) await syncWithRemote(project.workspacePath, this.forgejo);
    await this.ensureHarnessBuildInputs(renamed);
    await buildSite(project.workspacePath);
    await validateSite(siteDir);
    const head = await currentHead(project.workspacePath);
    await publishSite(siteDir, intent.siteSlug);
    const aliases = [...new Set([...(project.siteAliases ?? []), intent.fromSiteSlug])].filter((slug) => slug !== intent.siteSlug);
    await publishSiteRedirects(aliases, intent.siteSlug);
    project = await this.store.patchProject(threadId, {
      displayName: intent.displayName, siteSlug: intent.siteSlug, repoName: intent.repoName,
      siteAliases: aliases, lastCommit: head.slice(0, 10), lastSeenCommit: head, pendingRename: undefined,
      pendingThreadName: intent.displayName,
    });
    await publishIndex(this.store.listProjects(), (repo) => this.forgejo.repoWebUrl(repo))
      .catch((error) => log("warn", "project.index_refresh_failed", { threadId, error: errorText(error) }));
    log("info", "project.renamed", { threadId, siteSlug: project.siteSlug, repoName: project.repoName });
    return project;
    } finally { this.runningOperations.set(threadId, (this.runningOperations.get(threadId) ?? 1) - 1); }
  }

  async mutate(threadId: string, prompt: string, initial = false, onProgress?: ProgressCallback, author?: CommitAuthor, statusMessageId?: string, images?: readonly PromptImage[], queuedStatusIds: readonly string[] = [], displayRequest?: string, requesterId?: string, instructionOverride?: string): Promise<MutationResult> {
    let project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site. Use /site start first.");
    if (project.pendingDeletion) throw new TurnStoppedError("Project deletion is pending.");
    if (!initial) project = await this.ensureProjectName(threadId, onProgress);
    if (!prompt.trim() && !images?.length) throw new Error("Prompt is empty.");
    if (prompt.length > config.maxPromptChars) throw new Error(`Prompt exceeds MAX_PROMPT_CHARS (${config.maxPromptChars}).`);

    // Hoisted so the failure ledger in the catch can see what the turn spent
    // even when a later stage (repair, validation tail, store) throws.
    let usage: TurnUsage | undefined;
    // The durable marker ID lets the catch and delivery tail check ownership
    // across database reads — a hard
    // reset (or a successor released by one) may swap in another meanwhile.
    let pendingMarker: ProjectRecord["pendingTurn"];
    // Whether this turn claimed the persisted queue. Anything that throws
    // before startQueuedTurn() must release the batch instead: the caller
    // already told the user "Request saved", and an unclaimed entry would sit
    // in SQLite until a restart replayed it (or, for an image-only entry,
    // forever — boot recovery skips text-less prompts).
    let queueClaimed = false;
    const turnStartedAt = Date.now();
    this.activeTurns += 1;
    this.activeTurnThreads.add(threadId);
    try {
      await onProgress?.({ text: "📁 Preparing your update", phase: "preparing", context: {
        // Only a merged batch passes displayRequest. The single-message and
        // initial prompts are already visible in the thread, so repeating them
        // on the card only crowded out the plan.
        request: displayRequest, repoUrl: this.repoLink(project),
        siteUrl: project.status !== "creating" ? this.siteLink(project) : undefined,
      } });
      let agentSummary: string;
      const projectKind = project.projectKind ?? "site";
      // The workspace path never changes across patchProject updates below.
      const workspacePath = project.workspacePath;
      // Repair harness-owned multiplayer files (vendored client, net config,
      // multiplayer AGENTS.md section) in case a previous turn removed them.
      const multiplayerMode = project.multiplayerMode ?? "arena";
      const multiplayer = multiplayerContext(projectKind, project.multiplayerGameId ?? project.siteSlug, multiplayerMode);
      if (multiplayer) {
        emit(onProgress, "🕹️ Ensuring multiplayer client files");
        await ensureMultiplayerFiles(workspacePath, multiplayer, projectKind);
      } else {
        // Non-multiplayer projects get the same per-turn guarantee: AGENTS.md
        // rule updates reach existing threads, not just newly created ones.
        const agentsFile = path.join(workspacePath, "AGENTS.md");
        const agents = await projectAgents(projectKind, undefined, multiplayerMode === "singleplayer");
        if ((await fs.readFile(agentsFile, "utf8").catch(() => undefined)) !== agents) {
          await fs.writeFile(agentsFile, agents, "utf8");
        }
        // A singleplayer game must also stay free of leftover relay wiring:
        // stale net files would keep imports and the bundler resolving.
        if (multiplayerMode === "singleplayer") await removeMultiplayerFiles(workspacePath);
      }
      // The engine package gets the same per-turn guarantee: if node_modules
      // ever goes missing or drifts, it is reseeded before the agent runs, so
      // the imports AGENTS.md promises always resolve at build time.
      if (await ensureEnginePackages(workspacePath, projectKind)) {
        emit(onProgress, "📦 Restored the engine package (node_modules)");
      }
      // The engine playbook skill gets the same per-turn guarantee: seeded
      // before the prompt (and after the turn, below), so it is always
      // present, current, and committed in game repos.
      if (await ensureSkillFiles(workspacePath, projectKind)) {
        emit(onProgress, "🎓 Restored the curated game skills (.opencode/skills)");
      }
      // Authoritative image gate, re-checked inside the queue: the model the
      // pre-check in index.ts verified may have changed (admin override, fresh
      // session) by the time this turn actually runs. Anything not positively
      // vision-capable is dropped rather than sent.
      let turnImages = images;
      if (images?.length) {
        const parsed = parseModel(this.store.getModel())
          ?? await this.opencode.lastAssistantModel(workspacePath, project.sessionId);
        const accepts = parsed ? await this.opencode.modelAcceptsAttachments(parsed.providerID, parsed.modelID) : undefined;
        if (accepts !== true) {
          turnImages = undefined;
          emit(onProgress, "⚠️ The current model can't see images — the attachment(s) were dropped");
          log("info", "project.images_dropped", { threadId, count: images.length, model: parsed ? `${parsed.providerID}/${parsed.modelID}` : "unknown" });
          if (!prompt.trim()) throw new Error("The model this thread runs on cannot see images and the message had no text.");
        }
      }
      // Durable project memory: read fresh each turn so notes land in the very
      // turn after they are written. Missing file is fine (nothing noted yet).
      const notes = await readProjectNotes(project.workspacePath);
      // A harness-driven turn (e.g. the multiplayer switch) brings its own
      // instruction; the prompt then stays the user-facing display text.
      let instruction = instructionOverride ?? (initial
        ? initialProjectInstruction(projectKind, prompt, notes, multiplayerMode)
        : mutationInstruction(projectKind, prompt, notes, multiplayerMode));
      if (project.browserQaFindings) instruction += browserQaFeedback(project.browserQaFindings);
      if (turnImages?.length) {
        instruction += `\n\nThe user's Discord message included ${turnImages.length} attached image${turnImages.length === 1 ? "" : "s"}, delivered with this prompt.`;
      }

      // Session context lifecycle before the prompt: a long-idle thread starts
      // a fresh session, a heavy previous turn compacts first. Initial turns
      // just created their session, so they always skip this.
      if (!initial) {
        const lifecycle = await this.applySessionLifecycle(project, onProgress);
        if (lifecycle) project = lifecycle;
      }

      // Autopilot economy: short follow-up mutations without images run on the
      // configured light model; initial builds, image turns, long briefs, and
      // any explicit /site-admin override keep the default routing.
      const requestedModel = this.store.getModel()
        ?? (config.opencodeLightModel && !initial && prompt.length <= config.opencodeLightPromptChars && !turnImages?.length
          ? config.opencodeLightModel
          : undefined);
      if (requestedModel && requestedModel === config.opencodeLightModel) {
        emit(onProgress, `🪶 Short change — using the light model \`${requestedModel}\``);
      }

      const turnBaseline = await captureWorkingTreeSnapshot(workspacePath);
      let stopChangesTimer = () => {};
      const updateChanges = () => {
        void workingTreeStats(workspacePath, turnBaseline)
          .then((changes) => onProgress?.({ kind: "changes", text: formatWorkingTreeStats(changes), files: changes }))
          .catch(() => undefined);
      };
      updateChanges();
      const changesTimer = onProgress ? setInterval(updateChanges, 3000) : undefined;
      stopChangesTimer = () => { if (changesTimer) clearInterval(changesTimer); };
      emit(onProgress, initial ? "✨ Building the first version" : "🧠 Applying your requested revision", undefined, "working");
      // Persist the in-flight request first: if the bot dies mid-turn, boot
      // recovery uses it to continue, commit, and publish this work.
      pendingMarker = { id: randomUUID(), prompt, initial, startedAt: new Date().toISOString(), author, requesterId, statusMessageId,
        beforeCommit: await currentHead(workspacePath), images: turnImages ? [...turnImages] : undefined };
      project = await this.store.startQueuedTurn(threadId, pendingMarker, queuedStatusIds);
      queueClaimed = true;
      await this.usageLog.record({ id: pendingMarker.id, sessionId: project.sessionId, startedAt: pendingMarker.startedAt,
        pending: true, threadId, project: project.displayName, kind: projectKind });
      await onProgress?.({ kind: "queue", text: "Saved requests", queuedRequests: project.pendingQueue?.length ?? 0 });
      // A stop that arrived during preparation (before any server-side turn
      // existed to abort) lands here: fail as a user stop instead of starting
      // the agent work the user just asked to interrupt. The catch consumes
      // the mark and rethrows TurnStoppedError.
      if (this.stopRequested.has(threadId)) {
        stopChangesTimer(); // the changes interval is otherwise cleared inside the prompt guard below
        throw new Error("Stopped before the agent turn started.");
      }
      try {
        try {
          const result = await this.promptWithFailover(project.workspacePath, project.sessionId, instruction, onProgress, turnImages, requestedModel);
          agentSummary = result.text;
          usage = result.usage;
        } catch (error) {
          // The session was replaced out from under this turn (e.g. /site-admin
          // reset deleted it) — recreating here would resurrect a turn the
          // reset just stopped.
          emit(onProgress, "♻️ Recreating a missing agent session");
          const retry = await this.repromptOnVanishedSession(threadId, project!, error, instruction,
            (sessionId) => this.promptWithFailover(project!.workspacePath, sessionId, instruction, onProgress, turnImages, requestedModel));
          project = retry.project;
          agentSummary = retry.text;
          usage = retry.usage;
        }
        stopChangesTimer();
        // Capture the last edits even when the turn finished between 3s polls.
        await workingTreeStats(workspacePath, turnBaseline)
          .then((changes) => onProgress?.({ kind: "changes", text: formatWorkingTreeStats(changes), files: changes }))
          .catch(() => undefined);
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
      // The agent is done; from here the turn is in its delivery tail. Tracked
      // explicitly so a reset can tell "finishing" from "wedged" without
      // trusting pendingTurn, which can also be a stale crash marker.
      this.delivering.add(threadId);
      const result = await this.completeTurn({
        project, prompt, initial, projectKind, multiplayer, agentSummary, author, onProgress, usage, startedAt: turnStartedAt,
        pendingTurn: pendingMarker,
      });
      return result;
    } catch (error) {
      const stoppedByUser = await this.settleFailedTurn(threadId, project, pendingMarker, usage, error, turnStartedAt, queueClaimed, queuedStatusIds, "project.mutation_superseded");
      logError("project.mutation_failed", error, { threadId, initial, model: this.store.getModel() || "default", stoppedByUser });
      throw stoppedByUser
        ? new TurnStoppedError("The update was stopped at the user's request.", { cause: error })
        : error;
    } finally {
      this.activeTurns -= 1;
      this.activeTurnThreads.delete(threadId);
      this.delivering.delete(threadId);
      // A stop that raced an already-completing turn must not poison the next one.
      this.stopRequested.delete(threadId);
    }
  }

  /**
   * Everything after a successful agent prompt: restore harness-owned files,
   * validate (with one repair attempt), commit, publish, and clear the
   * pending-turn marker. Shared by normal turns and restart recovery.
   *
   * The agent's finished work is never thrown away. A validation failure
   * commits the work without publishing it (the live site keeps the last
   * validated version), and a metadata/commit/publish failure is captured in
   * the result instead of failing the turn — the result carries the outcome
   * (`validationError` / `deliveryError` / optional `commit`) so the thread
   * sees the agent's summary plus a follow-up message with the errors. Only a
   * store failure rethrows; the caller's catch marks the project errored.
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
    /** The in-flight marker this turn wrote, if any — see the clear below. */
    pendingTurn?: ProjectRecord["pendingTurn"];
  }): Promise<MutationResult> {
    const threadId = input.project.threadId;
    let project = input.project;
    const workspacePath = project.workspacePath;
    const siteDir = safeChild(workspacePath, "site");
    const restoreHarnessFiles = async (): Promise<void> => {
      let restored = false;
      if (await ensureEnginePackages(workspacePath, input.projectKind)) restored = true;
      if (await ensureSkillFiles(workspacePath, input.projectKind)) restored = true;
      if (input.multiplayer && await ensureMultiplayerFiles(workspacePath, input.multiplayer, input.projectKind)) restored = true;
      if (restored) emit(input.onProgress, "🗂️ Restored harness-owned files (engine package, game skills, multiplayer client)");
    };
    let agentSummary = input.agentSummary;
    let usage = input.usage;

    await restoreHarnessFiles();
    let stats: { files: number; bytes: number } | undefined;
    let validationError: string | undefined;
    // The QA screenshot from the last successful browser pass rides the
    // result so the thread sees what shipped (also after a repair round-trip).
    let qaScreenshot: Uint8Array | undefined;
    let qaFindings: ProjectRecord["browserQaFindings"];
    let qaFindingsList: string[] = [];
    // The static build step of deployment: bundle site/src/ TypeScript into
    // site/js/ (with code-framed bundler errors an agent can act on), then
    // validate the resulting tree, then collect advisory browser diagnostics.
    // Only build/static validation failures trigger a repair round-trip.
    const buildAndValidate = async (): Promise<{ files: number; bytes: number }> => {
      emit(input.onProgress, "⚙️ Compiling the current source", undefined, "checking");
      const built = await buildSite(workspacePath);
      if (!built.skipped) {
        emit(input.onProgress, `⚙️ Bundled TypeScript · ${built.emitted} output file${built.emitted === 1 ? "" : "s"}${built.pruned ? ` · ${built.pruned} stale pruned` : ""}`);
      }
      emit(input.onProgress, "🧪 Validating static output", undefined, "checking");
      const validated = await validateSite(siteDir);
      const qa = await this.runBrowserQa(project, input.onProgress);
      qaScreenshot = qa?.screenshotPng;
      qaFindingsList = qa ? [...qa.findings] : [];
      if (qa) qaFindings = { checkedAt: new Date().toISOString(), findings: qaFindingsList };
      if (qaFindingsList.length) {
        log("warn", "browserqa.advisory_findings", { threadId, ...qaFindings });
        emit(input.onProgress, `⚠️ Browser QA: ${truncate(qaFindingsList[0], 240)} — continuing publication; details saved for the next update`);
      }
      return validated;
    };
    try {
      stats = await buildAndValidate();
    } catch (error) {
      const firstError = errorText(error);
      if (!/JavaScript (?:syntax|type-check) error|TypeScript compile error|Broken local reference/i.test(firstError)) {
        // Structural problems (missing index.html, dotfiles, blocked file
        // types, size caps) get no repair round-trip; they commit unpublished,
        // exactly like a failed repair.
        validationError = firstError;
      } else {
        // One repair attempt: feed the validation error back to the same agent
        // session, which can see the files it just wrote, then re-validate.
        log("warn", "project.validation_javascript_retry", { threadId, error: firstError });
        emit(input.onProgress, "🔧 Validation errors found — asking the agent to repair them", undefined, "working");
        try {
          const repaired = await this.opencode.prompt(
            workspacePath,
            project.sessionId,
            repairInstruction(firstError),
            this.store.getModel(),
            input.onProgress,
            "sitebuilder",
            this.store.getEffort(),
          );
          agentSummary = repaired.text;
          usage = addUsage(usage, repaired.usage);
          emit(input.onProgress, "🧪 Re-validating after the repair");
          await restoreHarnessFiles();
          try {
            stats = await buildAndValidate();
          } catch (reValidationError) {
            validationError = errorText(reValidationError);
          }
        } catch (repairError) {
          // The repair round-trip itself failed (agent/provider trouble); the
          // original validation errors still stand and the original summary is
          // kept — commit the work unpublished like any failed validation.
          logError("project.repair_prompt_failed", repairError, { threadId });
          validationError = `${firstError}\n\nThe automatic repair pass could not run: ${errorText(repairError)}`;
        }
      }
    }

    let deliveryError: string | undefined;
    let commitStats: Awaited<ReturnType<typeof commitAndPush>> | undefined;

    if (validationError) {
      emit(input.onProgress, "⚠️ Validation failed — committing the work without publishing it");
    } else {
      emit(input.onProgress, "📝 Updating project metadata");
    }
    try {
      await this.writeReadme(project);
    } catch (error) {
      deliveryError = `Updating project metadata failed: ${errorText(error)}`;
    }
    if (!deliveryError) {
      emit(input.onProgress, "⬆️ Committing and pushing to Forgejo", undefined, "publishing");
      // A validated turn that only fails later keeps a clean subject; a turn
      // that never validated says so in git history.
      const subject = validationError
        ? `${commitSubjectFor(input.prompt, input.initial, input.projectKind)} — failed validation, not published`
        : commitSubjectFor(input.prompt, input.initial, input.projectKind);
      try {
        commitStats = await commitAndPush(workspacePath, subject, this.forgejo, input.author);
      } catch (error) {
        deliveryError = `Committing and pushing to Forgejo failed: ${errorText(error)}`;
        logError("project.commit_failed", error, { threadId });
      }
    }
    // A clean tree means nothing changed (question-only turn); there is no
    // commit to publish and no failure to report.
    if (commitStats && !validationError && !deliveryError) {
      emit(input.onProgress, "🚀 Publishing to Apache");
      try {
        await publishSite(siteDir, project.siteSlug);
      } catch (error) {
        deliveryError = `Publishing to the web server failed: ${errorText(error)}`;
        logError("project.publish_failed", error, { threadId });
      }
    }

    const published = Boolean(commitStats) && !validationError && !deliveryError;
    // An empty commit was skipped: the turn answered without changing the
    // workspace. That is a normal outcome, not a delivery failure — leave the
    // project's status and lastError exactly as they were.
    const noChanges = !commitStats && !deliveryError;
    // The play card shows what the project is now: a short, model-written
    // preview of the project and what this turn added. It is advisory — a
    // preview that cannot be written costs the card its blurb, nothing else.
    let preview: ProjectPreview | undefined;
    if (published) {
      emit(input.onProgress, "📝 Writing the preview for the finished project");
      preview = await this.describeProject(project, agentSummary, input.projectKind);
    }
    // Flush billing before clearing the durable recovery marker. A crash in
    // the delivery tail can revise this same turn, never add a second one.
    usage = await this.recordTurnUsage(project, input.pendingTurn, usage,
      Boolean(validationError || deliveryError || (!commitStats && !noChanges)), Date.now() - input.startedAt);
    // Clear the in-flight marker only while this turn still owns it: a hard
    // reset can swap in a fresh session and a successor's marker while this
    // (stopped) turn finishes its delivery tail, and wiping the successor's
    // marker would silently lose its crash recovery. The same applies to every
    // other field derived from the worktree: once superseded, this turn's HEAD
    // observations describe the successor's commits, and persisting them would
    // make /site revert undo the wrong turn.
    const ownsTurn = !this.store.getProject(threadId)?.pendingDeletion && pendingTurnMatches(this.store.getProject(threadId)?.pendingTurn, input.pendingTurn);
    if (ownsTurn) {
      project = await this.store.patchProject(threadId, {
        ...(noChanges ? {} : {
          status: published ? "ready" : "error",
          lastError: published ? undefined : truncate(validationError || deliveryError || "the turn did not publish", 1000),
        }),
        ...(commitStats ? { lastCommit: commitStats.commit } : {}),
        ...(commitStats ? { lastTurnBaseCommit: (await commitHistory(workspacePath)).previous } : {}),
        // Keep the external-push poller in sync: after the bot's own push,
        // origin/main's tip is exactly this turn's commit.
        ...(commitStats ? { lastSeenCommit: await currentHead(workspacePath) } : {}),
        ...(qaFindings ? { browserQaFindings: qaFindings } : {}),
        ...(preview ? { preview } : {}),
        pendingTurn: undefined,
        // Record when the session was last used and how full its context window
        // ended; the next turn's lifecycle check reads both.
        lastTurnAt: new Date().toISOString(),
        ...(usage?.contextTokens ? { lastTurnUsage: { contextTokens: usage.contextTokens, contextLimit: usage.contextLimit } } : {}),
      });
    } else {
      // A successor owns the record now; report its state, not a stale snapshot.
      log("warn", "project.complete_superseded", { threadId, commit: commitStats?.commit });
      project = this.store.getProject(threadId) ?? project;
    }

    if (published) {
      emit(input.onProgress, "🗂️ Refreshing the public gallery");
      // The site is live at this point; a stale gallery index must not fail
      // the turn — the next successful publish refreshes it again.
      await publishIndex(this.store.listProjects(), (repo) => this.forgejo.repoWebUrl(repo))
        .catch((error) => log("warn", "project.index_refresh_failed", { threadId, error: errorText(error) }));
      log("info", "project.published", {
        threadId,
        commit: commitStats!.commit,
        files: stats?.files ?? 0,
        bytes: stats?.bytes ?? 0,
        commitFiles: commitStats!.files,
        additions: commitStats!.additions,
        deletions: commitStats!.deletions,
        projectKind: input.projectKind,
      });
    } else if (validationError) {
      log("warn", "project.validation_failed_committed", { threadId, commit: commitStats?.commit, error: truncate(validationError, 400) });
    } else if (noChanges) {
      log("info", "project.no_changes", { threadId });
    } else {
      log("warn", "project.delivery_failed", { threadId, commit: commitStats?.commit, error: truncate(deliveryError || "unknown", 400) });
    }

    if (ownsTurn && !validationError && !deliveryError && (needsProjectNaming(project) || project.pendingThreadName)) {
      try {
        project = await this.ensureProjectName(threadId, input.onProgress);
        if (commitStats && project.lastCommit) commitStats = { ...commitStats, commit: project.lastCommit };
      } catch (error) {
        project = this.store.getProject(threadId) ?? project;
        deliveryError = `Project name synchronization is pending: ${errorText(error)}. The next turn waits until the rename succeeds.`;
        log("warn", "project.naming_pending", { threadId, error: serializeError(error) });
      }
    }

    return {
      project,
      agentSummary,
      usage,
      durationMs: Date.now() - input.startedAt,
      ...(qaScreenshot ? { screenshot: qaScreenshot } : {}),
      ...(qaFindingsList.length ? { browserQaFindings: qaFindingsList } : {}),
      // A turn that changed nothing keeps the preview the last change wrote.
      ...(preview ?? project.preview ? { preview: preview ?? project.preview } : {}),
      ...(commitStats
        ? { commit: commitStats.commit, commitFiles: commitStats.files, additions: commitStats.additions, deletions: commitStats.deletions }
        : { commitFiles: 0, additions: 0, deletions: 0 }),
      ...(commitStats ? {} : { noChanges: true as const }),
      ...(stats ?? { files: 0, bytes: 0 }),
      ...(validationError ? { validationError } : {}),
      ...(deliveryError ? { deliveryError } : {}),
    };
  }

  /**
   * Resume a turn that was in flight when the bot restarted. Waits for the
   * agent service (it may be restarting too) and for a still-running turn to
   * finish, then either commits already-completed work or asks the session to
   * continue the interrupted change, and runs the normal publish tail. The
   * continue-prompt has an inactivity deadline so a wedged agent turn
   * cannot hold the thread's queue — and every message queued behind it —
   * forever.
   */
  async recoverTurn(threadId: string, onProgress?: ProgressCallback): Promise<MutationResult> {
    let project = this.store.getProject(threadId);
    const pending = project?.pendingTurn;
    if (!project || !pending) throw new Error("This thread has no interrupted turn to recover.");
    if (project.pendingDeletion) throw new TurnStoppedError("Project deletion is pending.");
    const projectKind = project.projectKind ?? "site";
    const turnStartedAt = Date.now();
    // Hoisted for the failure ledger in the catch, mirroring mutate().
    let usage: TurnUsage | undefined;
    log("info", "project.recovery_started", { threadId, initial: pending.initial, startedAt: pending.startedAt });
    this.activeTurns += 1;
    this.activeTurnThreads.add(threadId);

    try {
      emit(onProgress, "🔌 Waiting for the agent service to be reachable");
      await this.waitForAgentService();
      emit(onProgress, "⏳ Waiting for the interrupted agent turn to finish");
      const stopWatching = await this.opencode.watchExistingTurn(project.workspacePath, project.sessionId, onProgress, Date.parse(pending.startedAt));
      try {
        await this.waitForIdleTurn(project.workspacePath, project.sessionId, onProgress);
      } finally {
        await stopWatching();
      }
      // A stop pressed while recovery waited lands on the server-side turn via
      // an abort; nothing in this process was prompting, so without this
      // checkpoint recovery would sail past the wait and send a fresh prompt
      // (or commit the partials) for exactly the work the user stopped. The
      // catch consumes the mark and rethrows TurnStoppedError.
      if (this.stopRequested.has(threadId)) throw new Error("Stopped while waiting for the interrupted agent turn.");

      let agentSummary: string;
      if (await this.turnCompletedSince(project.workspacePath, project.sessionId, pending.startedAt)) {
        // The turn finished on the agent side while the bot was down; only the
        // commit/publish tail was lost. Saved billing is reconciled below.
        log("info", "project.recovery_already_completed", { threadId });
        emit(onProgress, "✅ The interrupted turn had already finished on the agent side");
        agentSummary = "This turn had already finished on the agent side before the restart; it was committed and published by recovery.";
      } else {
        const savedNotes = await readProjectNotes(project.workspacePath);
        const notes = [savedNotes, project.browserQaFindings ? browserQaFeedback(project.browserQaFindings) : ""].filter(Boolean).join("\n\n") || undefined;
        try {
          const result = await this.recoveryPrompt(project.workspacePath, project.sessionId, recoveryInstruction(pending.prompt, notes), onProgress, threadId, pending.images);
          agentSummary = result.text;
          usage = result.usage;
        } catch (error) {
          log("warn", "project.recovery_session_lost", { threadId, sessionId: project.sessionId });
          emit(onProgress, "♻️ Recreating a missing agent session");
          const instruction = pending.initial
            ? initialProjectInstruction(projectKind, pending.prompt, notes, project.multiplayerMode)
            : mutationInstruction(projectKind, pending.prompt, notes, project.multiplayerMode);
          const retry = await this.repromptOnVanishedSession(threadId, project!, error, instruction,
            (sessionId) => this.recoveryPrompt(project!.workspacePath, sessionId, instruction, onProgress, threadId, pending.images));
          project = retry.project;
          agentSummary = retry.text;
          usage = retry.usage;
        }
      }
      // Agent phase over: recovery's delivery tail holds the queue the same
      // way a normal turn's does (see ProjectService.delivering).
      this.delivering.add(threadId);
      const result = await this.completeTurn({
        project,
        prompt: pending.prompt,
        initial: pending.initial,
        projectKind,
        multiplayer: multiplayerContext(projectKind, project.multiplayerGameId ?? project.siteSlug, project.multiplayerMode),
        agentSummary,
        author: pending.author,
        onProgress,
        usage,
        startedAt: turnStartedAt,
        pendingTurn: pending,
      });
      log("info", "project.recovery_completed", { threadId, commit: result.commit, published: !result.validationError && !result.deliveryError });
      return result;
    } catch (error) {
      const stoppedByUser = await this.settleFailedTurn(threadId, project, pending, usage, error, turnStartedAt, true, [], "project.recovery_superseded");
      logError("project.recovery_failed", error, { threadId, stoppedByUser });
      throw stoppedByUser
        ? new TurnStoppedError("The recovered update was stopped at the user's request.", { cause: error })
        : error;
    } finally {
      this.activeTurns -= 1;
      this.activeTurnThreads.delete(threadId);
      this.delivering.delete(threadId);
      this.stopRequested.delete(threadId);
    }
  }

  /**
   * One agent prompt with mid-flight quota failover: when the send fails on a
   * provider quota block and a healthy failover model is configured, the same
   * prompt is retried once on it. (The pre-send check inside prompt() already
   * switched before sending when it could; this covers blocks discovered by
   * sending.)
   */
  private async promptWithFailover(
    workspacePath: string,
    sessionId: string,
    instruction: string,
    onProgress: ProgressCallback | undefined,
    images: readonly PromptImage[] | undefined,
    requestedModel: string | undefined,
  ): Promise<PromptResult> {
    try {
      return await this.opencode.prompt(workspacePath, sessionId, instruction, requestedModel, onProgress, "sitebuilder", this.store.getEffort(), images);
    } catch (error) {
      const retryModel = this.opencode.failoverModelForError(error, requestedModel);
      if (!retryModel) throw error;
      log("warn", "project.quota_failover_retry", { sessionId, from: requestedModel || "default", to: retryModel, error: serializeError(error) });
      emit(onProgress, `⚠️ The provider quota ran out mid-turn — retrying with \`${retryModel}\``);
      return this.opencode.prompt(workspacePath, sessionId, instruction, retryModel, onProgress, "sitebuilder", this.store.getEffort(), images);
    }
  }

  /**
   * Allow long recoveries while the agent makes progress. The reconcile window
   * bounds inactivity, excluding time spent waiting for a user's answer.
   * Status heartbeats alone must not keep a wedged turn alive forever.
   */
  private async recoveryPrompt(
    workspacePath: string,
    sessionId: string,
    instruction: string,
    onProgress: ProgressCallback | undefined,
    threadId: string,
    images?: readonly PromptImage[],
  ): Promise<PromptResult> {
    let timedOut = false;
    let closed = false;
    let timer: NodeJS.Timeout | undefined;
    let rejectTimeout!: (error: Error) => void;
    const questions = new Set<string>();
    const toolStates = new Map<string, string>();
    let lastMetrics = "";
    const inactivity = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const armTimeout = (): void => {
      if (timer) clearTimeout(timer);
      if (closed || timedOut || questions.size) return;
      timer = setTimeout(() => {
        timedOut = true;
        rejectTimeout(new Error(
          `Restart recovery timed out after ${Math.round(config.opencodeReconcileTimeoutMs / 60000)} minutes without agent progress; partial edits were preserved.`,
        ));
      }, config.opencodeReconcileTimeoutMs);
    };
    const progress: ProgressCallback = (update) => {
      if (closed || timedOut) return;
      if (update.question) {
        if (update.question.resolved) questions.delete(update.question.requestID);
        else questions.add(update.question.requestID);
        armTimeout();
      } else if (update.kind !== "heartbeat") {
        const toolChanged = update.tool && toolStates.get(update.tool.id) !== update.tool.status;
        if (update.tool) toolStates.set(update.tool.id, update.tool.status);
        const metrics = update.metrics;
        const metricKey = metrics && JSON.stringify([metrics.inputTokens, metrics.outputTokens, metrics.steps, metrics.compactions]);
        const metricsChanged = metricKey !== undefined && metricKey !== lastMetrics;
        if (metricKey !== undefined) lastMetrics = metricKey;
        if (toolChanged || metricsChanged || (metrics?.liveTokensPerSecond ?? 0) > 0
          || update.kind === "thought" || update.kind === "plan" || update.kind === "changes") armTimeout();
      }
      return onProgress?.(update);
    };
    armTimeout();
    const pending = this.promptWithFailover(workspacePath, sessionId, instruction, progress, images, this.store.getModel());
    try {
      return await Promise.race([pending, inactivity]);
    } catch (error) {
      if (timedOut) {
        emit(onProgress, "🛑 Recovery window exhausted — stopping the orphaned agent turn");
        await this.opencode.abortTurn(workspacePath, sessionId).catch((abortError) => {
          log("warn", "project.recovery_abort_failed", { threadId, error: serializeError(abortError) });
        });
      }
      throw error;
    } finally {
      closed = true;
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
  private async waitForIdleTurn(workspacePath: string, sessionId: string, onProgress?: ProgressCallback, timeoutMs = config.opencodeReconcileTimeoutMs): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let sawBusy = false;
    let lastHeartbeatAt = 0;
    let lastPollError: unknown;
    while (Date.now() < deadline) {
      let busy: boolean;
      try {
        busy = await this.opencode.isBusy(workspacePath, sessionId);
        lastPollError = undefined;
      } catch (error) {
        // A slow status endpoint is not evidence that the agent turn is idle.
        // Keep waiting while the event stream remains attached.
        lastPollError = error;
        if (Date.now() - lastHeartbeatAt >= 30_000) {
          onProgress?.({ kind: "heartbeat", text: "🔌 OpenCode status is taking longer than usual", detail: `Still attached to the saved session · ${formatShortDuration(Date.now() - (deadline - timeoutMs))} elapsed`, phase: "working" });
          lastHeartbeatAt = Date.now();
        }
        await sleep(config.opencodeReconcilePollMs);
        continue;
      }
      if (!busy) {
        onProgress?.({ kind: "heartbeat", text: "✅ The interrupted agent turn has finished", active: false, phase: "working" });
        return;
      }
      sawBusy = true;
      if (Date.now() - lastHeartbeatAt >= 30_000) {
        onProgress?.({ kind: "heartbeat", text: "⏳ OpenCode still reports the interrupted turn running", detail: `Reattached to live session · ${formatShortDuration(Date.now() - (deadline - timeoutMs))} elapsed`, active: true, phase: "working" });
        lastHeartbeatAt = Date.now();
      }
      await sleep(config.opencodeReconcilePollMs);
    }
    if (sawBusy) {
      // Mirror recoveryPrompt's timeout: leaving the turn running would keep
      // burning provider tokens unsupervised and wedge the next prompt on a
      // session that is still busy server-side.
      emit(onProgress, "🛑 Recovery window exhausted — stopping the orphaned agent turn");
      await this.opencode.abortTurn(workspacePath, sessionId).catch((error) => {
        log("warn", "project.recovery_wait_abort_failed", { sessionId, error: serializeError(error) });
      });
      throw new Error("The interrupted agent turn kept running past the recovery window; recovery stopped it and gave up.");
    }
    if (lastPollError) throw new Error(`OpenCode status stayed unavailable throughout the recovery window: ${errorText(lastPollError)}`);
  }

  /**
   * Whether the turn that was in flight ran to completion on the agent side
   * while the bot was down. True only when the session's newest message is
   * that turn's terminal assistant response — an interrupted turn's
   * intermediate tool-call steps also complete with timestamps seconds into
   * the turn, so "some assistant message completed" is not evidence the turn
   * finished. Mirrors findTerminalAssistant's terminal-message predicate.
   */
  private async turnCompletedSince(workspacePath: string, sessionId: string, sinceIso: string): Promise<boolean> {
    const since = Date.parse(sinceIso);
    if (!Number.isFinite(since)) return false;
    try {
      const messages = await this.opencode.listMessages(workspacePath, sessionId, 100);
      const newest = [...messages].sort((a, b) => (b.info?.time?.created ?? 0) - (a.info?.time?.created ?? 0))[0];
      return isTerminalAssistant(newest?.info, { since, agent: "sitebuilder" })
        // An errored message is terminal for reconcile, but not evidence of a
        // completed turn for recovery: continue the work instead.
        && !newest?.info?.error
        && (newest!.info!.time?.completed ?? 0) > since - 2_000;
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

  /**
   * Steer the thread's running agent turn with a mid-flight user message: the
   * harness submits it to the busy session, where the agent reads it as part
   * of the running turn — no abort, no waiting for the next pass. False when
   * nothing is steerable right now (idle, delivering, or recovering), so the
   * caller can queue the message instead.
   */
  async steerActiveTurn(threadId: string, text: string, replyToMessageId?: string): Promise<boolean> {
    if (!this.activeTurnThreads.has(threadId) || this.delivering.has(threadId)) return false;
    const project = this.store.getProject(threadId);
    if (!project || !replyToMessageId || project.pendingTurn?.statusMessageId !== replyToMessageId) return false;
    const steered = await this.opencode.steer(project.workspacePath, project.sessionId, text);
    if (steered) log("info", "project.turn_steered", { threadId, sessionId: project.sessionId });
    return steered;
  }

  /**
   * Swap a game's multiplayer architecture (/site multiplayer): persist the new
   * mode, swap the harness-owned wiring (net files + AGENTS.md guidance, or
   * their removal for singleplayer), then run a normal agent turn whose
   * instruction orders investigate → question the user → rewrite. The turn
   * rides the thread's queue like any update, so it cannot race a running one.
   */
  async switchMultiplayer(
    threadId: string,
    mode: MultiplayerMode,
    statusMessageId: string,
    onProgress?: ProgressCallback,
    requesterId?: string,
    userNote?: string,
  ): Promise<MutationResult> {
    const project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site.");
    const kind = project.projectKind ?? "site";
    if (kind === "site") throw new Error("This project is a website — multiplayer architectures apply to games only.");
    const from = project.multiplayerMode ?? "arena";
    if (from === mode) throw new Error(`This game already runs ${multiplayerModeLabel(mode)}.`);

    // Mode first: the turn's own per-turn repair and the agent's AGENTS.md
    // must both describe the target architecture from here on.
    await this.store.patchProject(threadId, { multiplayerMode: mode });
    const multiplayer = multiplayerContext(kind, project.multiplayerGameId ?? project.siteSlug, mode);
    if (multiplayer) {
      emit(onProgress, `🕹️ Rewiring the harness client for ${multiplayerModeLabel(mode)}`);
      await ensureMultiplayerFiles(project.workspacePath, multiplayer, kind);
    } else {
      emit(onProgress, "🕹️ Removing the multiplayer client — this game is going singleplayer");
      await removeMultiplayerFiles(project.workspacePath);
    }
    log("info", "project.multiplayer_switch", { threadId, from, to: mode });

    return this.mutate(
      threadId,
      `Switch the multiplayer architecture to ${multiplayerModeLabel(mode)}`,
      false,
      onProgress,
      undefined,
      statusMessageId,
      undefined,
      [],
      undefined,
      requesterId,
      multiplayerSwapInstruction(from, mode, userNote),
    );
  }

  /**
   * Hard per-thread reset for /site reset: free the thread's queue, stop its
   * agent session — abort a running turn, discard pending questions, delete
   * the session — and swap in a fresh one. Nothing here waits behind the
   * thread's queue; a reset must work exactly when a turn is stuck holding
   * it. The fresh session is created and committed to the store BEFORE the
   * old one is stopped, so the interrupted turn's "session vanished" recovery
   * path sees the store's session id change and fails instead of recreating
   * its session. The stopped turn reports failure in the thread through its
   * normal path; messages queued behind it run on the fresh session at once.
   * Sites, git history, and project notes are untouched.
   */
  async resetSession(threadId: string): Promise<{ project: ProjectRecord; stoppedTurn: boolean }> {
    const project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site.");
    if (project.pendingDeletion) throw new TurnStoppedError("Project deletion is pending.");

    // A turn in its delivery tail (build/validate/commit/publish) has already
    // left the agent, so it is not "busy" — but it still holds the queue and
    // will release it on its own. Severing then would release the next waiter
    // into a second pipeline on the same worktree (index.lock failures, a site
    // flipping between two versions). Only a genuinely stuck holder is freed.
    // Re-read at each decision point: a turn can enter its tail during the
    // session call below.
    const deliveryTail = (): boolean => this.delivering.has(threadId);
    const freeQueue = (): boolean => {
      if (deliveryTail()) return false;
      this.severQueue(threadId);
      return true;
    };

    let sessionId: string | undefined;
    try {
      sessionId = await withTimeout(this.opencode.createSession(project.workspacePath, `Discord: ${project.displayName}`), 60_000);
    } catch (error) {
      // No replacement session exists, so released queue items would prompt
      // the wedged one — but leaving the thread wedged is worse; free it and
      // report the service trouble.
      const freed = freeQueue();
      throw new Error(
        freed
          ? `The thread's queue was freed, but starting a fresh agent session failed: ${errorText(error)}`
          : `Starting a fresh agent session failed: ${errorText(error)}. The current turn is still finishing its delivery and will release the queue when it completes.`,
      );
    }
    if (!sessionId) {
      const freed = freeQueue();
      throw new Error(
        freed
          ? "The thread's queue was freed, but the agent service did not answer the fresh-session request within 60s. " +
            "Try /site reset again once the service is reachable."
          : "The agent service did not answer the fresh-session request within 60s. The current turn is still finishing its delivery and will release the queue when it completes.",
      );
    }
    // Clear pendingTurn so boot recovery cannot resurrect the stopped turn,
    // and the fresh-session lifecycle fields (nothing has run on it yet, so
    // it can be neither idle-stale nor due for compaction). A delivery tail is
    // the exception: it is finishing, not stopped, and it must keep ownership
    // so it can record its own commit and clear the marker when it completes.
    const updated = await this.store.patchProject(threadId, {
      sessionId,
      ...(deliveryTail() ? {} : { pendingTurn: undefined }),
      lastTurnUsage: undefined,
      lastTurnAt: undefined,
    });
    // Classify the swept turn's failure as a user stop, like forceDeleteProject
    // does: a reset is intentional, so its aborted turns must not raise
    // spurious failure incidents. Only when a turn is actually in flight — an
    // unconsumed mark would mislabel the next turn's unrelated failure.
    if (this.activeTurnThreads.has(threadId)) this.stopRequested.add(threadId);
    const sweep = await this.opencode
      .stopSessionsInDirectory(project.workspacePath, project.sessionId, new Set([sessionId]))
      .catch((error) => {
        log("warn", "project.reset_sweep_failed", { threadId, error: serializeError(error) });
        return undefined;
      });
    // Sever only now that the store points at the fresh session: released
    // queue items read the project fresh inside mutate() and must land on
    // the new session, not the one the sweep is about to delete. A delivery
    // tail is left alone — it releases the queue itself when it finishes.
    freeQueue();
    log("info", "project.session_reset", {
      threadId,
      oldSessionId: project.sessionId,
      sessionId,
      stoppedSessions: sweep?.sessions ?? 0,
      abortedTurns: sweep?.aborted ?? 0,
    });
    return { project: updated, stoppedTurn: (sweep?.aborted ?? 0) > 0 };
  }

  /**
   * Admin-wide hard reset: free every thread's queue, start a fresh session
   * for every project the store tracks, then stop EVERY other session on the
   * agent service — abort running turns, discard pending questions, and
   * delete each session. The sweep also covers sessions the store no longer
   * knows about (orphans, subagent children, abandoned titler runs), so
   * nothing survives to keep working or be resumed. Fresh sessions are
   * created and committed to the store BEFORE the old ones are stopped, so
   * interrupted turns' "session vanished" recovery path sees the session id
   * change and fails instead of recreating its session. The stopped Discord
   * turns fail through their normal failure path. Sites, git history, and
   * project notes are untouched.
   */
  async resetAllSessions(): Promise<{ total: number; stopped: number; failed: number; aborted: number }> {
    const projects = this.store.listProjects().filter((project) => !project.pendingDeletion);
    // Free every thread's queue first — instantly, before any service call —
    // so messages wedged behind a stuck turn proceed even while the agent
    // service is slow to abort it (or unreachable entirely). A turn already in
    // its delivery tail is skipped: it releases the queue itself, and severing
    // would start a second pipeline on the same worktree.
    const deliveryTails = new Set<string>();
    for (const project of projects) {
      if (this.delivering.has(project.threadId)) deliveryTails.add(project.threadId);
      else this.severQueue(project.threadId);
    }

    const fresh = new Set<string>();
    const outcomes = await Promise.all(projects.map(async (project) => {
      try {
        const sessionId = await this.opencode.createSession(project.workspacePath, `Discord: ${project.displayName}`);
        fresh.add(sessionId);
        // Clear pendingTurn so boot recovery does not resurrect the aborted
        // turn after the next restart, and mirror resetSession for the rest.
        // A delivery tail keeps its marker: it is finishing and must record
        // its own commit rather than have that write skipped as superseded.
        await this.store.patchProject(project.threadId, {
          sessionId,
          ...(deliveryTails.has(project.threadId) ? {} : { pendingTurn: undefined }),
          lastTurnUsage: undefined,
          lastTurnAt: undefined,
        });
        log("info", "project.session_admin_reset", { threadId: project.threadId, oldSessionId: project.sessionId, sessionId });
        return true;
      } catch (error) {
        logError("project.admin_reset_failed", error, { threadId: project.threadId });
        return false;
      }
    }));
    // The sweep below aborts every still-running turn on purpose; classify
    // those failures as user stops (no spurious incidents), mirroring
    // resetSession. Guarded on an active turn so an idle thread keeps no mark.
    const stoppedThreads = projects.filter((project) => this.activeTurnThreads.has(project.threadId));
    for (const project of stoppedThreads) this.stopRequested.add(project.threadId);
    // With the replacements alive, sweep everything else on the service;
    // the fresh sessions are the only thing left running afterwards.
    const sweep = await this.opencode.stopAllSessions(fresh).catch((error) => {
      logError("project.admin_reset_sweep_failed", error, {});
      return { sessions: 0, aborted: 0 };
    });
    const summary = {
      total: projects.length,
      stopped: outcomes.filter(Boolean).length,
      failed: outcomes.filter((ok) => !ok).length,
      aborted: sweep.aborted,
    };
    log("info", "project.admin_reset_completed", { ...summary, sweptSessions: sweep.sessions });
    return summary;
  }

  /**
   * Delete a project whose Discord thread is gone. Deletion intent is
   * unambiguous, so this does not wait behind the
   * thread's queue or a running turn: the queue is severed, the running turn
   * is aborted (questions rejected first — they hold turns open), and the
   * durable deletion blocks new work while existing delivery unwinds. The aborted turn routes through the
   * user-stop marker so it does not raise a spurious admin incident for a
   * thread that no longer exists.
   */
  forceDeleteProject(threadId: string, reason = "thread-delete"): Promise<void> {
    const running = this.deletions.get(threadId);
    if (running) return running;
    const task = this.removeDeletedProject(threadId, reason).finally(() => { this.deletions.delete(threadId); });
    this.deletions.set(threadId, task);
    return task;
  }

  private async removeDeletedProject(threadId: string, reason: string): Promise<void> {
    let project = this.store.getProject(threadId);
    if (!project) return;
    // Persist intent before the first external call. A failure must retain
    // enough identity to retry, while preventing recovery or new publication.
    project = await this.store.patchProject(threadId, {
      pendingDeletion: project.pendingDeletion ?? { requestedAt: new Date().toISOString(), reason }, pendingQueue: undefined,
    });
    this.severQueue(threadId);
    if (this.activeTurnThreads.has(threadId)) this.stopRequested.add(threadId);
    try {
      assertExclusiveResources(project, this.store.listProjects());
      await removalPaths(project);
      if (!project.pendingDeletion?.agentsDeleted) await this.opencode.deleteSessionsInDirectory(project.workspacePath, project.sessionId);
      // Delivery may already be building/pushing. Let it unwind before local
      // deletion; deleting underneath it could resurrect published files.
      const deadline = Date.now() + 30_000;
      while (this.activeTurnThreads.has(threadId) || (this.runningOperations.get(threadId) ?? 0) > 0) {
        if (Date.now() >= deadline) throw new Error("Waiting for the stopped project operation to finish; cleanup will retry.");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      project = this.store.getProject(threadId)!;
      assertExclusiveResources(project, this.store.listProjects());
      await removalPaths(project);
      // Repeat after operations settle to catch a title/subagent created while
      // the first stop was landing.
      if (!project.pendingDeletion?.agentsDeleted) {
        await this.opencode.deleteSessionsInDirectory(project.workspacePath, project.sessionId);
        project = await this.store.patchProject(threadId, { pendingDeletion: { ...project.pendingDeletion!, agentsDeleted: true } });
      }
      if (project.multiplayerGameId || (project.projectKind?.startsWith("game-") && project.multiplayerMode !== "singleplayer")) {
        await this.deleteRelayGame(project.multiplayerGameId ?? project.siteSlug);
      }
      for (const repo of projectRepos(project)) await this.forgejo.deleteRepository(repo);
      for (const account of projectAccounts(project)) await this.forgejo.deletePushAccount(account);
      for (const target of await removalPaths(project)) await fs.rm(target, { recursive: true, force: true, maxRetries: 3 });
      await this.usageLog.forgetThread(threadId);
      // Keep the retry marker even if gallery refresh fails.
      await publishIndex(this.store.listProjects().filter((item) => item.threadId !== threadId), (repo) => this.forgejo.repoWebUrl(repo));
      await this.store.deleteProject(threadId);
      this.runningOperations.delete(threadId);
      this.stopRequested.delete(threadId);
      log("info", "project.deleted", { threadId, repoName: project.repoName, siteSlug: project.siteSlug });
    } catch (error) {
      const current = this.store.getProject(threadId);
      if (current?.pendingDeletion) await this.store.patchProject(threadId, {
        pendingDeletion: { ...current.pendingDeletion, lastError: truncate(errorText(error), 1000) },
      });
      throw error;
    }
  }

  private deleteRelayGame = deleteRelayGame;

  /** Whether an agent turn is currently running for the project's session. */
  async agentBusy(threadId: string): Promise<boolean> {
    const project = this.store.getProject(threadId);
    if (!project) return false;
    return this.opencode.isBusy(project.workspacePath, project.sessionId);
  }

  /** How many turns are in flight right now (agent work through delivery). */
  activeTurnCount(): number {
    return this.activeTurns;
  }

  /**
   * Ask the model for a short preview of the project as it stands: the pitch
   * for the play card and what this turn added. Bounded and fail-open — a
   * preview that cannot be written costs the card its blurb, never the turn.
   */
  private async describeProject(project: ProjectRecord, summary: string, kind: ProjectKind): Promise<ProjectPreview | undefined> {
    const model = this.store.getModel();
    try {
      const generated = await this.opencode.generatePreview(project.workspacePath, {
        name: project.displayName,
        kind: projectKindLabel(kind),
        request: project.initialPrompt,
        summary,
        previous: project.preview?.pitch,
      }, model);
      await this.usageLog.record({ label: "preview", threadId: project.threadId, project: project.displayName,
        kind, usage: generated.usage, fallbackModel: model, failed: !generated.pitch });
      if (!generated.pitch) return undefined;
      return { pitch: generated.pitch, added: generated.added, play: generated.play };
    } catch (error) {
      const usage = errorUsage(error);
      if (usage) await this.usageLog.record({ label: "preview", threadId: project.threadId, project: project.displayName,
        kind, usage, fallbackModel: model, failed: true });
      log("warn", "project.preview_generation_failed", { threadId: project.threadId, model, error: serializeError(error) });
      return undefined;
    }
  }

  /**
   * Load the just-validated site in the preview browser. Confirmed page
   * defects are advisory and saved for the agent's next turn; the screenshot
   * rides the result for the thread. Browser QA never triggers a repair turn
   * or blocks publication.
   */
  private async runBrowserQa(project: ProjectRecord, onProgress?: ProgressCallback): Promise<BrowserQaResult | undefined> {
    if (!config.browserQaEnabled) return undefined;
    emit(onProgress, "📷 Browser QA");
    try {
      return await driveBrowserQa(project.guildId, project.threadId);
    } catch (error) {
      log("warn", "browserqa.failed", { threadId: project.threadId, error: serializeError(error) });
      const reason = `Browser check unavailable: ${truncate(errorText(error), 350)}`;
      return { findings: [], skippedReason: reason };
    }
  }

  /**
   * Gentle stop for the thread's running turn: abort the agent turn but keep
   * the session, workspace, git history, and project notes. The aborted turn's
   * mutate() rethrows as TurnStoppedError; partial edits stay in the tree.
   *
   * Three outcomes are reported separately because the caller's message must
   * not claim "no turn is running" while the thread is visibly stuck:
   * `stopped` (an abort landed, or a still-preparing turn was marked to stop
   * at its pre-prompt checkpoint), `delivering` (the turn is past the agent
   * and will finish on its own), and `queueFreed` (the agent service could
   * not be reached, so the wedged queue was released instead of aborting).
   */
  async stopTurn(threadId: string): Promise<StopTurnOutcome> {
    const project = this.store.getProject(threadId);
    if (!project) return { stopped: false, delivering: false, queueFreed: false };
    const busy = await this.opencode.isBusy(project.workspacePath, project.sessionId).catch(() => undefined);
    if (busy === false) {
      // No server-side turn: the thread is idle, the turn already moved on to
      // build/commit/publish (which releases the queue itself), or it is still
      // preparing — claimed but not prompting yet, so there was nothing busy
      // to abort. Mark a preparing turn so it bails at its pre-prompt
      // checkpoint instead of starting agent work the user just asked to stop.
      if (this.delivering.has(threadId)) return { stopped: false, delivering: true, queueFreed: false };
      if (this.activeTurnThreads.has(threadId)) {
        this.stopRequested.add(threadId);
        log("warn", "project.turn_stop_before_agent", { threadId, sessionId: project.sessionId });
        return { stopped: true, delivering: false, queueFreed: false };
      }
      return { stopped: false, delivering: false, queueFreed: false };
    }
    if (busy === undefined) {
      // The status call failed. A turn in its delivery tail is finishing on its
      // own, so leave its queue alone; otherwise a prompt against an
      // unreachable service may never settle, which is the one case where
      // leaving the chain intact wedges the thread for good. An active turn
      // that cannot be aborted is still marked, so it reports a user stop when
      // it finally settles — and restart recovery bails at its checkpoint
      // instead of prompting when the service returns.
      if (this.delivering.has(threadId)) return { stopped: false, delivering: true, queueFreed: false };
      if (this.activeTurnThreads.has(threadId)) this.stopRequested.add(threadId);
      this.severQueue(threadId);
      log("warn", "project.turn_stop_unreachable", { threadId, sessionId: project.sessionId });
      return { stopped: false, delivering: false, queueFreed: true };
    }
    // The agent is working — including a repair prompt inside the delivery
    // tail, which is abortable exactly like a normal turn.
    // A turn parked on a question holds itself open — the question must be
    // rejected before an abort can land (the same dance as the reset sweep).
    await this.rejectPendingQuestions(project.workspacePath);
    // Mark BEFORE the abort request: the server rejects the in-flight prompt as
    // soon as it processes the abort, so the turn's catch can observe the mark
    // before this function resumes. Marking afterwards let the rejection race
    // past and misreport the stop as a project failure.
    this.stopRequested.add(threadId);
    let aborted: boolean;
    try {
      aborted = await this.opencode.abortTurn(project.workspacePath, project.sessionId);
    } catch (error) {
      // Nothing consumed the mark, so it must not survive into the next turn.
      this.stopRequested.delete(threadId);
      throw error;
    }
    if (!aborted) this.stopRequested.delete(threadId);
    // The turn may have completed between the status check and the abort; if
    // the marker we saw is gone, nothing will consume the mark and it would
    // mislabel the next failure as a user stop. (With no marker there is
    // nothing to compare, so leave it for the turn's own catch/finally.)
    const after = this.store.getProject(threadId);
    if (project.pendingTurn && !pendingTurnMatches(after?.pendingTurn, project.pendingTurn)) this.stopRequested.delete(threadId);
    log("warn", "project.turn_stop_requested", { threadId, sessionId: project.sessionId, aborted });
    return { stopped: aborted, delivering: false, queueFreed: false };
  }

  /** Reject the directory's pending agent questions, best-effort; they hold their turns open. */
  private async rejectPendingQuestions(workspacePath: string): Promise<void> {
    for (const pending of await this.opencode.listPendingQuestions(workspacePath).catch(() => [] as Array<{ id: string }>)) {
      await this.opencode.rejectQuestion(workspacePath, pending.id).catch((error) => {
        log("warn", "opencode.question_reject_failed", { requestID: pending.id, workspacePath, error: serializeError(error) });
      });
    }
  }

  /**
   * Whether the model the thread's next turn will run on accepts image
   * attachments: the admin model override when set, else the model the
   * session last used. Undefined when no model can be determined — callers
   * treat that as "do not forward images".
   */
  async modelAcceptsImages(threadId: string): Promise<boolean | undefined> {
    const project = this.store.getProject(threadId);
    if (!project) return undefined;
    const parsed = parseModel(this.store.getModel())
      ?? await this.opencode.lastAssistantModel(project.workspacePath, project.sessionId);
    if (!parsed) return undefined;
    return this.opencode.modelAcceptsAttachments(parsed.providerID, parsed.modelID);
  }

  /** Discard uncommitted working-tree edits from a failed turn (button-initiated rollback). */
  async rollbackEdits(threadId: string): Promise<void> {
    const project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site.");
    await restoreWorkingTree(project.workspacePath);
    log("warn", "project.rollback_requested", { threadId, sessionId: project.sessionId });
  }

  /**
   * Issue (or rotate) repository-scoped push credentials for a project. The
   * account is a restricted Forgejo user with Write on exactly this repo, so
   * holders can push but see nothing else on the instance. Rotating deletes
   * the old account — Forgejo drops its collaborations, revoking access
   * immediately. Returns the clone URL alongside the credentials.
   */
  async issuePushKey(threadId: string, rotate: boolean): Promise<{ project: ProjectRecord; created: boolean }> {
    const project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site.");
    if (!rotate && project.pushKey) {
      return { project, created: false };
    }

    const { username, password } = generatePushCredentials();
    await this.store.patchProject(threadId, { pushAccountNames: [...new Set([...projectAccounts(project), username])] });
    const domain = new URL(config.forgejoPublicUrl).hostname;
    await this.forgejo.createPushAccount(username, password, `${username}@noreply.${domain}`);
    await this.forgejo.addCollaborator(project.repoName, username);
    if (rotate && project.pushKey) {
      // Best-effort revocation: a failure here leaves a stale account that can
      // still push, so it is logged loudly rather than silently dropped.
      await this.forgejo.deletePushAccount(project.pushKey.username).catch((error) => {
        log("error", "project.pushkey_rotate_revoke_failed", {
          threadId,
          oldUsername: project.pushKey!.username,
          error: serializeError(error),
        });
      });
    }
    const updated = await this.store.patchProject(threadId, {
      pushKey: { username, password, createdAt: new Date().toISOString() },
    });
    log("info", "project.pushkey_issued", { threadId, repoName: project.repoName, username, rotate });
    return { project: updated, created: true };
  }

  /**
   * Someone pushed to the repo's main branch from outside the bot (a push-key
   * holder). Adopt the commit and take it live: sync the workspace to
   * origin/main, rebuild, validate, publish. A validation failure rolls the
   * workspace back to the previously published commit and reports; the pushed
   * commit stays in the repo, the live site keeps the older version.
   */
  /**
   * The agent session vanished mid-prompt (404/not-found). Unless a deletion
   * is pending or the record's session was swapped meanwhile, create a fresh
   * session against the same files and retry the prompt through `reprompt`.
   */
  private async repromptOnVanishedSession(
    threadId: string, project: ProjectRecord, error: unknown,
    instruction: string, reprompt: (sessionId: string) => Promise<{ text: string; usage: TurnUsage }>,
  ): Promise<{ text: string; usage: TurnUsage; project: ProjectRecord }> {
    if (!/404|not found|unknown session/i.test(errorText(error))) throw error;
    if (this.store.getProject(threadId)?.pendingDeletion || this.store.getProject(threadId)?.sessionId !== project.sessionId) throw error;
    const sessionId = await this.opencode.createSession(project.workspacePath, `Discord: ${project.displayName}`);
    project = await this.store.patchProject(threadId, { sessionId });
    const result = await reprompt(sessionId);
    return { ...result, project };
  }

  /** Refuse while an agent turn is live; the message names the blocked action. */
  private async assertIdle(project: ProjectRecord, action: string): Promise<void> {
    if (await this.opencode.isBusy(project.workspacePath, project.sessionId)) {
      throw new Error(`A model turn is currently running in this thread. Wait for it to finish before ${action}.`);
    }
  }

  /**
   * Shared failure tail for mutate() and recoverTurn(): ledger the tokens the
   * failed turn spent, then clear the in-flight marker only while this turn
   * still owns it — a hard reset or a successor can swap the session and
   * marker while this failure is landing. A user stop keeps the prior
   * status/error, except a half-built initial project, which never shipped.
   * Returns true when the failure was a user stop.
   */
  private async settleFailedTurn(
    threadId: string, project: ProjectRecord, pending: ProjectRecord["pendingTurn"],
    usage: TurnUsage | undefined, error: unknown, turnStartedAt: number,
    queueClaimed: boolean, queuedStatusIds: readonly string[], supersededTag: string,
  ): Promise<boolean> {
    await this.recordTurnUsage(project, pending, addUsage(usage, errorUsage(error)), true, Date.now() - turnStartedAt);
    const stoppedByUser = this.stopRequested.delete(threadId);
    if (!queueClaimed && queuedStatusIds.length) {
      // The turn failed before it could claim the persisted batch: release it
      // now, or the acknowledged messages stay in pendingQueue and replay (or
      // are reported by boot recovery) after a restart that may be hours away.
      await this.store.dropQueuedRequests(threadId, queuedStatusIds).catch((dropError) => {
        log("warn", "project.queue_release_failed", { threadId, error: errorText(dropError) });
      });
    }
    const owning = this.store.getProject(threadId);
    if (owning && !owning.pendingDeletion && pendingTurnMatches(owning.pendingTurn, pending)) {
      await this.store.patchProject(threadId, stoppedByUser
        ? {
          ...(owning.status === "creating" ? { status: "error" as const, lastError: "Initial build stopped at the user's request" } : {}),
          pendingTurn: undefined,
          lastTurnAt: new Date().toISOString(),
        }
        : {
          status: "error" as const,
          lastError: truncate(errorText(error), 1000),
          pendingTurn: undefined,
          lastTurnAt: new Date().toISOString(),
        });
    } else if (queueClaimed) {
      log("warn", supersededTag, { threadId });
    }
    return stoppedByUser;
  }

  /**
   * Shared build/validate/publish tail: rebuild the harness bundle, validate,
   * publish, and stamp the ready state. On validation failure the workspace
   * rolls back to previousHead and the previously published site stays live.
   */
  private async publishValidatedBuild(
    threadId: string, project: ProjectRecord, commit: string,
    options: { failedLabel: string; previousHead?: string; logTag: string; logExtra?: Record<string, unknown>; onProgress?: ProgressCallback },
  ): Promise<{ project: ProjectRecord; validationError?: string }> {
    const siteDir = safeChild(project.workspacePath, "site");
    try {
      emit(options.onProgress, "⚙️ Rebuilding the TypeScript bundle");
      await this.ensureHarnessBuildInputs(project);
      await buildSite(project.workspacePath);
      emit(options.onProgress, "🧪 Validating rebuilt runtime files");
      await validateSite(siteDir);
      emit(options.onProgress, "🚀 Republishing to Apache");
      await publishSite(siteDir, project.siteSlug);
      const updated = await this.store.patchProject(threadId, {
        status: "ready",
        lastError: undefined,
        lastCommit: commit.slice(0, 10),
        lastTurnBaseCommit: undefined,
        lastSeenCommit: commit,
        lastTurnAt: new Date().toISOString(),
      });
      await publishIndex(this.store.listProjects(), (repo) => this.forgejo.repoWebUrl(repo));
      return { project: updated };
    } catch (error) {
      if (options.previousHead) {
        await resetToCommit(project.workspacePath, options.previousHead).catch(() => undefined);
      }
      const validationError = errorText(error);
      await this.store.patchProject(threadId, {
        status: "error",
        lastError: truncate(`${options.failedLabel} failed validation: ${validationError}`, 1000),
        lastSeenCommit: commit,
      });
      log("warn", options.logTag, { threadId, commit: commit.slice(0, 10), ...options.logExtra, error: truncate(validationError, 400) });
      return { project, validationError };
    }
  }

  async publishExternalPush(threadId: string): Promise<{ project: ProjectRecord; commit: string; validationError?: string }> {
    let project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site.");
    await this.assertIdle(project, "publishing the external push");

    const previousHead = await currentHead(project.workspacePath).catch(() => undefined);
    const { commit } = await syncToRemote(project.workspacePath, this.forgejo);
    const short = commit.slice(0, 10);
    // The pushed code does not validate: roll the workspace back to the last
    // good commit so the next agent turn starts from the published state.
    // The pushed commit stays in the repo; the live site keeps the older version.
    const { project: updated, validationError } = await this.publishValidatedBuild(threadId, project, commit, {
      failedLabel: `External push ${short}`,
      previousHead,
      logTag: "project.external_push_validation_failed",
    });
    if (!validationError) log("info", "project.external_push_published", { threadId, commit: short });
    return { project: updated, commit: short, validationError };
  }

  /**
   * Dismiss an external push: adopt the commit into the workspace and git
   * history (so the bot's next turn builds on it and its own push does not
   * collide), but leave the published site exactly as it was.
   */
  async adoptExternalCommit(threadId: string): Promise<{ project: ProjectRecord; commit: string }> {
    let project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site.");
    await this.assertIdle(project, "adopting the external push");
    const { commit } = await syncToRemote(project.workspacePath, this.forgejo);
    project = await this.store.patchProject(threadId, { lastSeenCommit: commit });
    log("info", "project.external_push_adopted", { threadId, commit: commit.slice(0, 10) });
    return { project, commit: commit.slice(0, 10) };
  }

  /**
   * Manual reconciliation for the thread: pull whatever sits on the repo's
   * main branch into the workspace, rebase any local-only commits (a turn whose
   * push was rejected) on top, push, and republish from the result. Unlike the
   * external-push poller this works even when the pushed commit predates
   * lastSeenCommit or the Publish button message is gone. Validation failure
   * keeps the previously published version live, mirroring publishExternalPush.
   */
  async sync(threadId: string, onProgress?: ProgressCallback): Promise<{
    project: ProjectRecord;
    commit: string;
    ahead: number;
    behind: number;
    validationError?: string;
  }> {
    let project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site.");
    await this.assertIdle(project, "syncing");
    // A dirty tree means a failed turn's partial edits are sitting uncommitted;
    // rebasing would destroy them, so refuse and point at the rollback choice.
    if (!(await workingTreeClean(project.workspacePath))) {
      throw new Error("The workspace has uncommitted edits from a failed turn. Roll them back or ask the agent to rework them before syncing.");
    }

    emit(onProgress, "📥 Pulling the repository's main branch");
    const { commit, ahead, behind } = await syncWithRemote(project.workspacePath, this.forgejo);
    const short = commit.slice(0, 10);
    if (behind === 0 && ahead === 0) {
      emit(onProgress, "✅ Already up to date");
    } else if (ahead > 0 && behind > 0) {
      emit(onProgress, `🔀 Rebased ${ahead} local commit${ahead === 1 ? "" : "s"} onto ${behind} pulled commit${behind === 1 ? "" : "s"}`);
    } else if (behind > 0) {
      emit(onProgress, `📥 Adopted ${behind} commit${behind === 1 ? "" : "s"} from the repository`);
    }

    // The synced tree does not validate: keep the live site on the last good
    // commit and roll the workspace back to it, like publishExternalPush.
    const previousHead = await commitHistory(project.workspacePath).then((h) => h.current).catch(() => undefined);
    const { project: updated, validationError } = await this.publishValidatedBuild(threadId, project, commit, {
      failedLabel: `Sync to ${short}`,
      previousHead,
      logTag: "project.sync_validation_failed",
      onProgress,
    });
    if (!validationError) log("info", "project.synced", { threadId, commit: short, ahead, behind });
    return { project: updated, commit: short, ahead, behind, validationError };
  }

  async republish(threadId: string): Promise<ProjectRecord> {
    let project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site.");
    const commit = (await currentHead(project.workspacePath).catch(() => undefined)) ?? project.lastCommit ?? "";
    // republish never rolls back: the tree is the last accepted (or pushed)
    // state and the previous publication stays live on any failure.
    return (await this.publishValidatedBuild(threadId, project, commit, {
      failedLabel: "Republish",
      logTag: "project.republish_failed",
    })).project;
  }

  async compact(threadId: string): Promise<{ model: string }> {
    const project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site.");
    await this.assertIdle(project, "compacting");
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
    await this.assertIdle(project, "reverting");

    const messageID = await this.opencode.lastUserMessageId(project.workspacePath, project.sessionId);
    if (!messageID) throw new Error("This session has no turns to revert yet.");

    const history = await turnRevertTarget(project.workspacePath, project.lastCommit, project.lastTurnBaseCommit);
    const headDrifted = history.headDrifted;
    if (!headDrifted && !history.target) {
      throw new Error("Only the initial workspace commit exists; there is no earlier published version to revert to.");
    }

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
      ({ undone: undoneCommit, kept: keptCommit } = await undoLastCommit(project.workspacePath, this.forgejo, history.target));
    }

    if (keptCommit) {
      // Reverting content must preserve the current project name and public links.
      await this.writeReadme(project);
      const siteDir = safeChild(project.workspacePath, "site");
      await this.ensureHarnessBuildInputs(project);
      await buildSite(project.workspacePath);
      await validateSite(siteDir);
      const metadata = await commitAndPush(project.workspacePath, `Rename project to ${project.displayName}`, this.forgejo);
      if (metadata) keptCommit = metadata.commit;
      await buildSite(project.workspacePath);
      await validateSite(siteDir);
      await publishSite(siteDir, project.siteSlug);
    }
    await this.store.patchProject(threadId, {
      status: "ready",
      lastError: undefined,
      lastCommit: keptCommit ?? history.current,
      lastTurnBaseCommit: undefined,
      lastSeenCommit: await currentHead(project.workspacePath),
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
    const readme = `# ${project.displayName}\n\nThis is a ${projectKindLabel(project.projectKind)} maintained by the ThreadSite Discord harness.\n\n- Live site: ${this.siteLink(project)}\n\nForgejo contains the authored source. Every accepted mutation is committed, then the harness builds a minified runtime-only deployment; generated bundles and harness networking inputs are not committed.\n`;
    await fs.writeFile(safeChild(project.workspacePath, "README.md"), readme, "utf8");
  }
}

/** Durable project memory (PROJECT_NOTES.md); empty when no notes exist yet. */
async function readProjectNotes(workspacePath: string): Promise<string | undefined> {
  const notes = await fs.readFile(path.join(workspacePath, "PROJECT_NOTES.md"), "utf8").catch(() => undefined);
  return notes?.trim() ? notes : undefined;
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

function emit(callback: ProgressCallback | undefined, text: string, detail?: string, phase?: ProgressPhase): void {
  if (!callback) return;
  Promise.resolve(callback({ text, detail, phase })).catch(() => undefined);
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
