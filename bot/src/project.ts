import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { ForgejoClient } from "./forgejo.js";
import { captureWorkingTreeSnapshot, commitAndPush, commitHistory, currentHead, ensureGitRepository, ensureLocalBaseline, generatePushCredentials, resetToCommit, restoreWorkingTree, syncToRemote, syncWithRemote, undoLastCommit, workingTreeClean, workingTreeStats } from "./git.js";
import { ensureMultiplayerFiles, multiplayerContext } from "./multiplayer.js";
import { OpenCodeHarness, addUsage, errorUsage, type PromptResult, type TurnUsage } from "./opencode.js";
import { publishIndex, publishSite, siteUrl, validateSite } from "./publish.js";
import { buildSite, GENERATED_GITIGNORE } from "./build.js";
import { enginePackages, ensureEnginePackages } from "./engines.js";
import { ensureSkillFiles, skillNames } from "./skills.js";
import { Store } from "./store.js";
import { initialProjectInstruction, mutationInstruction, projectAgents, projectKindLabel, recoveryInstruction, repairInstruction } from "./templates.js";
import { starterHtml, starterSource } from "./starter.js";
import type { CommitAuthor, MultiplayerContext, ProjectKind, ProjectRecord } from "./types.js";
import { UsageLog } from "./usage.js";
import type { ProgressCallback } from "./progress.js";
import type { WorkingTreeStats } from "./git.js";
import { log, logError, serializeError } from "./logger.js";
import { errorText, parseModel, safeChild, slugify, truncate, withTimeout } from "./util.js";

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

export class ProjectService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    readonly store: Store,
    readonly opencode: OpenCodeHarness,
    readonly forgejo: ForgejoClient,
    readonly usageLog: UsageLog,
  ) {}

  /** Recreate ignored harness build inputs after a checkout/clean or on a fresh host. */
  private async ensureHarnessBuildInputs(project: ProjectRecord, siteSlug = project.siteSlug): Promise<void> {
    await ensureEnginePackages(project.workspacePath, project.projectKind ?? "site");
    const multiplayer = multiplayerContext(project.projectKind ?? "site", siteSlug);
    if (multiplayer) await ensureMultiplayerFiles(project.workspacePath, multiplayer, project.projectKind ?? "site");
  }

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
    const srcDir = safeChild(workspacePath, "site", "src");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(siteDir, "index.html"), starterHtml(input.displayName), "utf8");
    await fs.writeFile(path.join(srcDir, "main.ts"), starterSource(projectKind), "utf8");
    // Authored source is the Git record. Harness build inputs and generated
    // bundles are recreated locally and never enter Forgejo.
    await fs.writeFile(path.join(workspacePath, ".gitignore"), `${GENERATED_GITIGNORE.join("\n")}\n`, "utf8");
    const multiplayer = multiplayerContext(projectKind, siteSlug);
    if (multiplayer) {
      // Games are multi-tenant clients of the shared relay: vendored protocol
      // client + this game's net config + the multiplayer AGENTS.md section.
      emit(onProgress, "🕹️ Provisioning multiplayer client and AGENTS.md");
      await ensureMultiplayerFiles(workspacePath, multiplayer, projectKind);
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
      // Applied only after the build actually ships: a turn that failed
      // validation or delivery keeps its slug name (see titlePromise above).
      if (title && !result.validationError && !result.deliveryError && result.commit) {
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
        await this.ensureHarnessBuildInputs(project, siteSlug);
        await buildSite(project.workspacePath);
        await validateSite(safeChild(project.workspacePath, "site"));
        // Commit the restamped README before publishing so the deploy stamp
        // names the exact Forgejo commit. Ignored tenant config/bundles remain
        // in the workspace for the runtime copy.
        await commitAndPush(project.workspacePath, `Rename project to ${title}`, this.forgejo);
        await publishSite(safeChild(project.workspacePath, "site"), siteSlug);
        await fs.rm(safeChild(config.publishRoot, project.siteSlug), { recursive: true, force: true }).catch(() => undefined);
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

    // Hoisted so the failure ledger in the catch can see what the turn spent
    // even when a later stage (repair, validation tail, store) throws.
    let usage: TurnUsage | undefined;
    const turnStartedAt = Date.now();
    try {
      let agentSummary: string;
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
        const agents = await projectAgents(projectKind);
        if ((await fs.readFile(agentsFile, "utf8").catch(() => undefined)) !== agents) {
          await fs.writeFile(agentsFile, agents, "utf8");
        }
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
          // The session was replaced out from under this turn (e.g. /site-admin
          // reset deleted it) — recreating here would resurrect a turn the
          // reset just stopped.
          if (this.store.getProject(threadId)?.sessionId !== project.sessionId) throw error;
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
      const result = await this.completeTurn({
        project, prompt, initial, projectKind, multiplayer, agentSummary, author, onProgress, usage, startedAt: turnStartedAt,
      });
      // Ledger every finished turn here — published or not — so a turn records
      // exactly once; thrown failures record in the catch below.
      await this.usageLog.record({
        threadId,
        project: project.displayName,
        kind: projectKind,
        durationMs: Date.now() - turnStartedAt,
        usage: result.usage,
        fallbackModel: this.store.getModel(),
        failed: Boolean(result.validationError || result.deliveryError || (!result.commit && !result.noChanges)),
      });
      return result;
    } catch (error) {
      // A failed run still spent its tokens: ledger whatever was observed —
      // the hoisted total plus anything the failing prompt attached to the
      // error itself — before marking the project errored.
      await this.usageLog.record({
        threadId,
        project: project.displayName,
        kind: project.projectKind ?? "site",
        durationMs: Date.now() - turnStartedAt,
        usage: addUsage(usage, errorUsage(error)),
        fallbackModel: this.store.getModel(),
        failed: true,
      });
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
    // The static build step of deployment: bundle site/src/ TypeScript into
    // site/js/ (with code-framed bundler errors an agent can act on), then
    // validate the resulting tree. Kept as one unit so a bundle failure feeds
    // the same repair round-trip as a validation failure.
    const buildAndValidate = async (): Promise<{ files: number; bytes: number }> => {
      const built = await buildSite(workspacePath);
      if (!built.skipped) {
        emit(input.onProgress, `⚙️ Bundled TypeScript · ${built.emitted} output file${built.emitted === 1 ? "" : "s"}${built.pruned ? ` · ${built.pruned} stale pruned` : ""}`);
      }
      emit(input.onProgress, "🧪 Validating static output");
      return validateSite(siteDir);
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
        emit(input.onProgress, "🔧 Validation errors found — asking the agent to repair them");
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
      emit(input.onProgress, "⬆️ Committing and pushing to Forgejo");
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
    project = await this.store.patchProject(threadId, {
      ...(noChanges ? {} : {
        status: published ? "ready" : "error",
        lastError: published ? undefined : truncate(validationError || deliveryError || "the turn did not publish", 1000),
      }),
      ...(commitStats ? { lastCommit: commitStats.commit } : {}),
      // Keep the external-push poller in sync: after the bot's own push,
      // origin/main's tip is exactly this turn's commit.
      ...(commitStats ? { lastSeenCommit: await currentHead(workspacePath) } : {}),
      pendingTurn: undefined,
      // Record when the session was last used and how full its context window
      // ended; the next turn's lifecycle check reads both.
      lastTurnAt: new Date().toISOString(),
      ...(usage?.contextTokens ? { lastTurnUsage: { contextTokens: usage.contextTokens, contextLimit: usage.contextLimit } } : {}),
    });

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

    return {
      project,
      agentSummary,
      usage,
      durationMs: Date.now() - input.startedAt,
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
    // Hoisted for the failure ledger in the catch, mirroring mutate().
    let usage: TurnUsage | undefined;
    log("info", "project.recovery_started", { threadId, initial: pending.initial, startedAt: pending.startedAt });

    try {
      emit(onProgress, "🔌 Waiting for the agent service to be reachable");
      await this.waitForAgentService();
      emit(onProgress, "⏳ Waiting for the interrupted agent turn to finish");
      await this.waitForIdleTurn(project.workspacePath, project.sessionId);

      let agentSummary: string;
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
          if (this.store.getProject(threadId)?.sessionId !== project.sessionId) throw error;
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
      await this.usageLog.record({
        threadId,
        project: project.displayName,
        kind: projectKind,
        durationMs: Date.now() - turnStartedAt,
        usage: result.usage,
        fallbackModel: this.store.getModel(),
        failed: Boolean(result.validationError || result.deliveryError || (!result.commit && !result.noChanges)),
      });
      log("info", "project.recovery_completed", { threadId, commit: result.commit, published: !result.validationError && !result.deliveryError });
      return result;
    } catch (error) {
      await this.usageLog.record({
        threadId,
        project: project.displayName,
        kind: projectKind,
        durationMs: Date.now() - turnStartedAt,
        usage: addUsage(usage, errorUsage(error)),
        fallbackModel: this.store.getModel(),
        failed: true,
      });
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
      const info = newest?.info;
      return Boolean(
        info?.id &&
          info.role === "assistant" &&
          !info.error &&
          (!info.agent || info.agent === "sitebuilder") &&
          info.finish &&
          info.finish !== "tool-calls" &&
          (info.time?.completed ?? 0) > since - 2_000,
      );
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

  /**
   * Admin-wide hard reset: stop EVERY active session on the agent service —
   * abort running turns, discard pending questions, and delete each session —
   * then start a fresh session for every project the store tracks. The sweep
   * also covers sessions the store no longer knows about (orphans, subagent
   * children, abandoned titler runs), so nothing survives to keep working or
   * be resumed. Unlike resetSession this does not refuse while a turn runs —
   * the turn is stopped and its Discord turn fails through the normal failure
   * path. Sites, git history, and project notes are untouched.
   */
  async resetAllSessions(): Promise<{ total: number; stopped: number; failed: number; aborted: number }> {
    // Sweep first, while every existing session is still listed; fresh
    // sessions created afterwards are the only thing left alive on the service.
    const sweep = await this.opencode.stopAllSessions(new Set()).catch((error) => {
      logError("project.admin_reset_sweep_failed", error, {});
      return { sessions: 0, aborted: 0 };
    });

    const projects = this.store.listProjects();
    const outcomes = await Promise.all(projects.map(async (project) => {
      try {
        const sessionId = await this.opencode.createSession(project.workspacePath, `Discord: ${project.displayName}`);
        // Clear pendingTurn so boot recovery does not resurrect the aborted
        // turn after the next restart, and mirror resetSession for the rest.
        await this.store.patchProject(project.threadId, { sessionId, pendingTurn: undefined, lastTurnUsage: undefined, lastTurnAt: undefined });
        log("info", "project.session_admin_reset", { threadId: project.threadId, oldSessionId: project.sessionId, sessionId });
        return true;
      } catch (error) {
        logError("project.admin_reset_failed", error, { threadId: project.threadId });
        return false;
      }
    }));
    const summary = {
      total: projects.length,
      stopped: outcomes.filter(Boolean).length,
      failed: outcomes.filter((ok) => !ok).length,
      aborted: sweep.aborted,
    };
    log("info", "project.admin_reset_completed", { ...summary, sweptSessions: sweep.sessions });
    return summary;
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
  async publishExternalPush(threadId: string): Promise<{ project: ProjectRecord; commit: string; validationError?: string }> {
    let project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site.");
    if (await this.opencode.isBusy(project.workspacePath, project.sessionId)) {
      throw new Error("A model turn is currently running in this thread. Wait for it to finish before publishing the external push.");
    }

    const previousHead = await currentHead(project.workspacePath).catch(() => undefined);
    const { commit } = await syncToRemote(project.workspacePath, this.forgejo);
    const short = commit.slice(0, 10);
    const siteDir = safeChild(project.workspacePath, "site");
    try {
      await this.ensureHarnessBuildInputs(project);
      await buildSite(project.workspacePath);
      await validateSite(siteDir);
      await publishSite(siteDir, project.siteSlug);
      project = await this.store.patchProject(threadId, {
        status: "ready",
        lastError: undefined,
        lastCommit: short,
        lastSeenCommit: commit,
        lastTurnAt: new Date().toISOString(),
      });
      await publishIndex(this.store.listProjects(), (repo) => this.forgejo.repoWebUrl(repo));
      log("info", "project.external_push_published", { threadId, commit: short });
      return { project, commit: short };
    } catch (error) {
      // The pushed code does not validate: roll the workspace back to the last
      // good commit so the next agent turn starts from the published state.
      // The pushed commit stays in the repo; the live site keeps the older version.
      if (previousHead) {
        await resetToCommit(project.workspacePath, previousHead).catch(() => undefined);
      }
      const validationError = errorText(error);
      await this.store.patchProject(threadId, {
        status: "error",
        lastError: truncate(`External push ${short} failed validation: ${validationError}`, 1000),
        lastSeenCommit: commit,
      });
      log("warn", "project.external_push_validation_failed", { threadId, commit: short, error: truncate(validationError, 400) });
      return { project, commit: short, validationError };
    }
  }

  /**
   * Dismiss an external push: adopt the commit into the workspace and git
   * history (so the bot's next turn builds on it and its own push does not
   * collide), but leave the published site exactly as it was.
   */
  async adoptExternalCommit(threadId: string): Promise<{ project: ProjectRecord; commit: string }> {
    let project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site.");
    if (await this.opencode.isBusy(project.workspacePath, project.sessionId)) {
      throw new Error("A model turn is currently running in this thread. Wait for it to finish before adopting the external push.");
    }
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
    if (await this.opencode.isBusy(project.workspacePath, project.sessionId)) {
      throw new Error("A model turn is currently running in this thread. Wait for it to finish before syncing.");
    }
    // A dirty tree means a failed turn's partial edits are sitting uncommitted;
    // rebasing would destroy them, so refuse and point at the rollback choice.
    if (!(await workingTreeClean(project.workspacePath))) {
      throw new Error("The workspace has uncommitted edits from a failed turn. Roll them back or ask the agent to rework them before syncing.");
    }

    emit(onProgress, "📥 Pulling the repository's main branch");
    const { commit, ahead, behind } = await syncWithRemote(project.workspacePath, this.forgejo);
    const short = commit.slice(0, 10);
    if (behind === 0 && ahead === 0) {
      emit(onProgress, "✅ Already up to date — republishing the checked-in tree");
    } else if (ahead > 0 && behind > 0) {
      emit(onProgress, `🔀 Rebased ${ahead} local commit${ahead === 1 ? "" : "s"} onto ${behind} pulled commit${behind === 1 ? "" : "s"}`);
    } else if (behind > 0) {
      emit(onProgress, `📥 Adopted ${behind} commit${behind === 1 ? "" : "s"} from the repository`);
    }

    const siteDir = safeChild(project.workspacePath, "site");
    const previousHead = await commitHistory(project.workspacePath).then((h) => h.current).catch(() => undefined);
    try {
      emit(onProgress, "⚙️ Rebuilding the TypeScript bundle");
      await this.ensureHarnessBuildInputs(project);
      await buildSite(project.workspacePath);
      emit(onProgress, "🧪 Validating rebuilt runtime files");
      await validateSite(siteDir);
      emit(onProgress, "🚀 Republishing to Apache");
      await publishSite(siteDir, project.siteSlug);
      project = await this.store.patchProject(threadId, {
        status: "ready",
        lastError: undefined,
        lastCommit: short,
        lastSeenCommit: commit,
        lastTurnAt: new Date().toISOString(),
      });
      await publishIndex(this.store.listProjects(), (repo) => this.forgejo.repoWebUrl(repo));
      log("info", "project.synced", { threadId, commit: short, ahead, behind });
      return { project, commit: short, ahead, behind };
    } catch (error) {
      // The synced tree does not validate: keep the live site on the last good
      // commit and roll the workspace back to it, like publishExternalPush.
      if (previousHead) {
        await resetToCommit(project.workspacePath, previousHead).catch(() => undefined);
      }
      const validationError = errorText(error);
      await this.store.patchProject(threadId, {
        status: "error",
        lastError: truncate(`Sync to ${short} failed validation: ${validationError}`, 1000),
        lastSeenCommit: commit,
      });
      log("warn", "project.sync_validation_failed", { threadId, commit: short, error: truncate(validationError, 400) });
      return { project, commit: short, ahead, behind, validationError };
    }
  }

  async republish(threadId: string, onProgress?: ProgressCallback): Promise<ProjectRecord> {
    let project = this.store.getProject(threadId);
    if (!project) throw new Error("This thread is not attached to a site.");
    const siteDir = safeChild(project.workspacePath, "site");
    emit(onProgress, "⚙️ Rebuilding the TypeScript bundle");
    await this.ensureHarnessBuildInputs(project);
    await buildSite(project.workspacePath);
    emit(onProgress, "🧪 Validating rebuilt runtime files");
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
      await this.ensureHarnessBuildInputs(project);
      await buildSite(project.workspacePath);
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
    const readme = `# ${project.displayName}\n\nThis is a ${projectKindLabel(project.projectKind)} maintained by the ThreadSite Discord harness.\n\n- Live site: ${this.siteLink(project)}\n\nForgejo contains the authored source. Every accepted mutation is committed, then the harness builds a minified runtime-only deployment; generated bundles and harness networking inputs are not committed.\n`;
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
