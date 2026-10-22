import fs from "node:fs/promises";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  ThreadAutoArchiveDuration,
  type Attachment,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type Message,
  type TextBasedChannel,
  type ThreadChannel,
} from "discord.js";
import { AdminReporter } from "./admin-reporter.js";
import { commandJson } from "./commands.js";
import { config } from "./config.js";
import { ForgejoClient } from "./forgejo.js";
import { getLogFile, log, logError, recentIncidents, recordIncident, serializeError } from "./logger.js";
import { multiplayerRelayStatus } from "./multiplayer.js";
import { OpenCodeHarness, formatTurnUsage, type PromptImage, type QuotaBlock } from "./opencode.js";
import { PROJECT_CARD_VERSION, renderProjectCard, type ProjectCardMessage, type ProjectCardState } from "./project-card.js";
import { DiscordProgress, type ProgressCallback } from "./progress.js";
import { ProjectService, TurnStoppedError, type MutationResult, type StopTurnOutcome } from "./project.js";
import { recoverPublishRoot } from "./publish.js";
import { Store, pendingTurnMatches } from "./store.js";
import { multiplayerModeLabel, projectKindLabel } from "./templates.js";
import type { CommitAuthor, MultiplayerMode, ProjectKind, ProjectRecord } from "./types.js";
import { UsageLog, type UsageTotal } from "./usage.js";
import { startWebhookServer } from "./webhook.js";
import { renderPlayCard, renderPlayText, renderTechnicalCard, renderTechnicalText, type TurnCardState } from "./turn-card.js";
import { reconcileProjectThreads } from "./thread-cleanup.js";
import { commitAuthorIdentity, errorText, formatCost, formatShortDuration, formatTokens, formatUtcClock, MAX_DISCORD_MESSAGE_CHARS, requestDisplayText, slugify, stripSummaryPreamble, truncate, withTimeout } from "./util.js";

// Stray async failures must log instead of killing the process: an unhandled
// rejection is process-fatal on Node 22 and would take every in-flight thread
// turn down with it. Individual turn failures are handled per-queue.
process.on("unhandledRejection", (reason) => {
  logError("process.unhandled_rejection", reason, {});
});
process.on("uncaughtException", (error) => {
  logError("process.uncaught_exception", error, {});
});

// Version stamps read package.json next to the running code (bot/ under tsx,
// dist's parent under node, /app in the image) — a literal here has drifted
// from package.json before.
const botVersion = await fs
  .readFile(new URL("../package.json", import.meta.url), "utf8")
  .then((raw) => (JSON.parse(raw) as { version?: string }).version)
  .catch(() => undefined);

const store = await Store.open(config.stateDbFile, config.defaultModel);
// A publish that died between its two renames leaves the live site missing
// with its content in a .backup-* directory; restore it before any turn can
// republish over the gap.
await recoverPublishRoot();
const opencode = new OpenCodeHarness();
const forgejo = new ForgejoClient();
const usageLog = new UsageLog(config.usageLogFile);
const projects = new ProjectService(store, opencode, forgejo, usageLog, async (project, title) => {
  const channel = await client.channels.fetch(project.threadId, { force: true });
  if (!channel?.isThread()) throw new Error("The project Discord thread is unavailable.");
  await applyAiThreadTitle(channel, title);
  await refreshProjectCard(project.threadId);
});

await registerCommands();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
const adminReporter = new AdminReporter(client);

// The HTTP listener always runs (it serves /healthz for the container
// healthcheck); WEBHOOK_ENABLED decides whether push events are acted on and
// hooks registered. Liveness is known only after the port actually binds — a
// failed bind falls back to the external-push poller instead of going deaf.
const webhookSecret = await store.ensureWebhookSecret();
const webhookServer = startWebhookServer({
  port: config.webhookPort,
  secret: webhookSecret,
  onPush: (event) => (config.webhookEnabled ? handleForgejoPush(event) : Promise.resolve()),
  health: () => ({
    uptimeSec: Math.round(process.uptime()),
    projects: store.listProjects().length,
    activeTurns: projects.activeTurnCount(),
    pendingTurns: store.listProjects().filter((project) => project.pendingTurn).length,
    agentService: config.opencodeUrl,
  }),
});
const webhookListenerLive = await webhookServer.listening.then(
  () => true,
  (error) => {
    logError("webhook.bind_failed", error, {});
    webhookServer.close();
    return false;
  },
);
const pushWebhooksLive = config.webhookEnabled && webhookListenerLive;

// Set once shutdown begins: new turns are refused, in-flight ones drain.
let shuttingDown = false;

// Live turn status messages that may carry agent-question buttons, keyed by the
// Discord status message id. Registered when a turn starts, removed when the
// turn's outcome message replaces the status message.
const liveProgress = new Map<string, DiscordProgress>();

function registerQuestionButtons(statusMessage: Message, progress: DiscordProgress): void {
  liveProgress.set(statusMessage.id, progress);
}

function unregisterQuestionButtons(statusMessageId: string | undefined): void {
  if (statusMessageId) liveProgress.delete(statusMessageId);
}

// customId "q:<requestID>:<questionIndex>:<optionIndex>" answers the agent's
// question; "qskip:<requestID>" rejects it so the agent proceeds on its own
// judgment. Option indices resolve against the DiscordProgress copy of the
// question, which also carries each option's real label.
async function handleQuestionButton(interaction: ButtonInteraction): Promise<void> {
  const progress = liveProgress.get(interaction.message.id);
  if (!progress) {
    await interaction.reply({ content: "That question is no longer pending.", flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return;
  }
  const [kind, requestID, qIndexRaw, oIndexRaw] = interaction.customId.split(":");
  const directory = store.getProject(interaction.channelId ?? "")?.workspacePath;
  if (!directory || !requestID) {
    await interaction.reply({ content: "This question's agent session could not be found.", flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.SendMessages)) {
    await interaction.reply({ content: "You need permission to post in this thread to answer the agent.", flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return;
  }
  // One answer per request: strip the buttons immediately so a double click
  // cannot double-answer, then ack before the awaited OpenCode call.
  await interaction.update({ components: [] }).catch(() => undefined);
  const responder = interaction.user.globalName ?? interaction.user.username;
  try {
    if (kind === "qskip") {
      await opencode.rejectQuestion(directory, requestID);
      progress.recordSkip(requestID, responder);
      await interaction.followUp({ content: "⏭️ Skipped", flags: MessageFlags.Ephemeral }).catch(() => undefined);
      return;
    }
    const question = progress.pendingQuestion(requestID);
    const qIndex = Number.parseInt(qIndexRaw ?? "", 10);
    const oIndex = Number.parseInt(oIndexRaw ?? "", 10);
    const label = question?.questions[qIndex]?.options[oIndex]?.label;
    if (!question || qIndex < 0 || oIndex < 0 || !label) {
      await interaction.followUp({ content: "That answer option is no longer available.", flags: MessageFlags.Ephemeral }).catch(() => undefined);
      await opencode.rejectQuestion(directory, requestID).catch(() => undefined);
      return;
    }
    // OpenCode expects one answer list per asked question, in order; unanswered
    // questions in the request get an empty selection.
    const answers = question.questions.map((_, index) => (index === qIndex ? [label] : []));
    await opencode.replyToQuestion(directory, requestID, answers);
    progress.recordAnswer(requestID, responder, label);
    await interaction.followUp({ content: `✅ Answered: **${truncate(label, 80)}**`, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  } finally {
    progress.clearQuestion(requestID);
  }
}

client.once(Events.ClientReady, (ready) => {
  log("info", "discord.ready", {
    user: ready.user.tag,
    version: botVersion ?? "unknown",
    projects: store.listProjects().length,
    model: store.getModel() || "the model default",
    multiplayer: config.multiplayerEnabled ? config.gameserverPublicUrl : "disabled",
    webhook: pushWebhooksLive
      ? `listening on :${config.webhookPort}`
      : webhookListenerLive
        ? "listener only (push webhooks disabled)"
        : "bind failed (external-push poller active)",
    errorRecipients: config.errorReportUserIds.size,
  });
  void (async () => {
    // Reconcile deleted threads before any interrupted build can resume.
    await sweepDeletedThreads();
    void recoverInterruptedTurns();
    void reconcileProjectCards();
    if (pushWebhooksLive) void ensureExistingProjectWebhooks();
    startExternalPushPoller();
  })().catch((error) => logError("project.startup_cleanup_failed", error, {}));
  const cleanupTimer = setInterval(() => { void sweepDeletedThreads(); }, config.projectCleanupIntervalMs);
  cleanupTimer.unref();
});

let cleanupSweepRunning = false;
async function sweepDeletedThreads(): Promise<void> {
  if (cleanupSweepRunning) return;
  cleanupSweepRunning = true;
  try {
    await reconcileProjectThreads(store, {
      available: (project) => client.guilds.cache.get(project.guildId)?.available === true,
      fetch: (id) => client.rest.get(Routes.channel(id)),
      remove: (id, reason) => handleThreadDeleted(id, reason),
    });
  } finally { cleanupSweepRunning = false; }
}

// Push-key holders push straight to the repo's main branch. With webhooks on
// (default), Forgejo tells the bot the moment it happens; the poller also runs
// as a safety net for missing hooks, rejected deliveries and lost events.
let externalPushTimer: NodeJS.Timeout | undefined;

function startExternalPushPoller(): void {
  if (externalPushTimer || config.externalPushPollMs <= 0) return;
  let scanning = false;
  externalPushTimer = setInterval(() => {
    if (scanning) return;
    scanning = true;
    void scanForExternalPushes().finally(() => { scanning = false; });
  }, config.externalPushPollMs);
  externalPushTimer.unref();
}

function stopExternalPushPoller(): void {
  if (externalPushTimer) clearInterval(externalPushTimer);
  externalPushTimer = undefined;
}

async function scanForExternalPushes(): Promise<void> {
  const candidates = store.listProjects().filter((project) => project.status === "ready" && !project.pendingDeletion);
  for (const project of candidates) {
    try {
      const sha = await forgejo.mainCommitSha(project.repoName);
      if (!sha) continue;
      await notifyExternalPushIfNeeded(project, sha, "poll");
    } catch (error) {
      logError("project.external_push_scan_failed", error, { threadId: project.threadId });
    }
  }
}

/**
 * One shared external-push decision for the webhook and the poller. Guards,
 * in order: nothing new on main; a bot turn mid-flight (its own push, or a
 * user push that the post-turn recheck will pick up); and the bot's own
 * commit landing before the store catches up — recognized silently via
 * lastCommit so the thread never gets a bogus "external push" for its own
 * turn. Only a genuinely foreign, fully idle push prompts the thread.
 */
async function notifyExternalPushIfNeeded(project: ProjectRecord, sha: string, source: "webhook" | "poll" | "recheck"): Promise<void> {
  if (sha === project.lastSeenCommit) return;
  if (project.pendingDeletion || project.pendingTurn || project.pendingRename) return;
  if (await projects.agentBusy(project.threadId).catch(() => true)) return;
  if (project.lastCommit && sha.startsWith(project.lastCommit)) {
    await store.patchProject(project.threadId, { lastSeenCommit: sha });
    return;
  }
  // lastSeenCommit is written only after a successful send, so two deliveries
  // arriving together (a webhook plus the poller, or a retried hook with a new
  // delivery id) would otherwise both reach the thread. The key is
  // thread+commit: a later commit still gets its own prompt.
  const key = `${project.threadId}:${sha}`;
  if (externalPushInFlight.has(key)) return;
  externalPushInFlight.add(key);
  try {
    await deliverExternalPushPrompt(project, sha, source);
  } finally {
    externalPushInFlight.delete(key);
  }
}

async function deliverExternalPushPrompt(project: ProjectRecord, sha: string, source: "webhook" | "poll" | "recheck"): Promise<void> {
  const channel = await client.channels.fetch(project.threadId).catch(() => undefined);
  const thread = channel?.isTextBased() && "send" in channel ? channel : undefined;
  // Mark the commit seen only after the prompt is actually delivered. Patching
  // first meant a failed send (thread deleted, permissions revoked) suppressed
  // the push permanently: neither the webhook nor the poller would mention it
  // again.
  if (!thread) {
    log("warn", "project.external_push_undeliverable", { source, threadId: project.threadId, commit: sha.slice(0, 10) });
    return;
  }
  try {
    await thread.send({
      content:
        `📥 **External push detected** on \`${project.repoName}\` · commit \`${sha.slice(0, 10)}\` — pushed with a repo push key.\n` +
        "Publish it to the live site, or dismiss it (the commit stays in git history either way).",
      components: [externalPushRow()],
    });
  } catch (error) {
    logError("project.external_push_notify_failed", error, { source, threadId: project.threadId, commit: sha.slice(0, 10) });
    return;
  }
  await store.patchProject(project.threadId, { lastSeenCommit: sha });
  log("info", "project.external_push_detected", { source, threadId: project.threadId, commit: sha.slice(0, 10) });
}

/** Signed Forgejo push event: react instantly when it touches a known repo's main. */
async function handleForgejoPush(event: { ref?: string; after?: string; repository?: { name?: string } }): Promise<void> {
  if (event.ref !== "refs/heads/main" || !event.after) return;
  const repoName = event.repository?.name;
  if (!repoName) return;
  const project = store.listProjects().find((candidate) => candidate.repoName === repoName && candidate.status !== "creating");
  if (!project) return;
  await notifyExternalPushIfNeeded(project, event.after, "webhook");
}

/**
 * A push that arrived while a turn was running was skipped by the guards in
 * notifyExternalPushIfNeeded; once the turn settles, look once more so it is
 * not lost to the one-shot webhook.
 */
async function recheckExternalPush(threadId: string): Promise<void> {
  if (!pushWebhooksLive) return;
  const project = store.getProject(threadId);
  if (!project || project.pendingDeletion || project.pendingTurn || project.pendingRename) return;
  try {
    const sha = await forgejo.mainCommitSha(project.repoName);
    if (sha) await notifyExternalPushIfNeeded(project, sha, "recheck");
  } catch (error) {
    logError("project.external_push_recheck_failed", error, { threadId });
  }
}

/** Backfill: make sure every existing project's repo has the push webhook. */
async function ensureExistingProjectWebhooks(): Promise<void> {
  const secret = store.getWebhookSecret();
  if (!secret) return;
  const url = `${config.webhookPublicUrl}/hooks/forgejo`;
  const list = store.listProjects().filter((project) => project.status !== "creating" && !project.pendingDeletion);
  await Promise.all(list.map(async (project) => {
    await forgejo.ensurePushWebhook(project.repoName, url, secret).catch((error) => {
      log("warn", "webhook.ensure_failed", { repoName: project.repoName, error: serializeError(error) });
    });
  }));
  log("info", "webhook.boot_sweep_done", { projects: list.length });
}

function externalPushRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("threadsite:extpub").setLabel("Publish").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("threadsite:extdismiss").setLabel("Dismiss").setStyle(ButtonStyle.Secondary),
  );
}

// Turns that were in flight when the bot stopped are marked in the store.
// Resume each one (continue the agent work, then commit and publish) now that
// Discord is available to report the outcome in the thread. The turn's own
// status message is resumed when it still exists, so the thread keeps one live
// message per request instead of a frozen leftover plus a new one; a fresh
// message is posted only as a fallback (e.g. the original was deleted).
async function recoverInterruptedTurns(): Promise<void> {
  const interrupted = store.listRecoveryProjects();
  if (!interrupted.length) return;
  log("info", "project.recovery_boot_scan", { interrupted: interrupted.length });
  // Reserve every persisted backlog before the first Discord fetch can yield to new messages.
  for (const project of interrupted) {
    pendingUpdates.set(project.threadId, { entries: [], scheduled: true });
  }
  for (const project of interrupted) {
    const channel = await client.channels.fetch(project.threadId).catch(() => undefined);
    const thread = channel?.isTextBased() && "send" in channel ? channel : undefined;
    if (!project.pendingTurn && (project.pendingRename || project.pendingThreadName || project.pendingNaming || project.repoName === `site-${project.siteSlug}` || /^(?:site|game)-/i.test(project.displayName))) {
      projects.enqueue(project.threadId, async () => {
        await projects.ensureProjectName(project.threadId);
      }).catch((error) => logError("project.rename_recovery_failed", error, { threadId: project.threadId }));
    }
    if (project.pendingTurn) {
      let status: Message | undefined;
      if (thread && project.pendingTurn?.statusMessageId) {
        const resumed = await thread.messages.fetch(project.pendingTurn.statusMessageId).catch(() => undefined);
        if (resumed && resumed.author.id === client.user?.id) status = resumed;
      }
      if (!status && thread) {
        status = await thread.send("♻️ Resuming the turn that was in flight when the bot restarted…").catch(() => undefined);
      }
      if (status && status.id !== project.pendingTurn.statusMessageId) {
        const fresh = store.getProject(project.threadId);
        if (fresh?.pendingTurn && pendingTurnMatches(fresh.pendingTurn, project.pendingTurn)) {
          await store.patchProject(project.threadId, { pendingTurn: { ...fresh.pendingTurn, statusMessageId: status.id } });
        }
      }
      const progress = status
        ? new DiscordProgress(status, `♻️ Recovering ${project.displayName}`, Date.parse(project.pendingTurn.startedAt))
        : undefined;
      if (status && progress) registerQuestionButtons(status, progress);
      progress?.enableStopButton();
      progress?.callback({
        kind: "heartbeat",
        text: "♻️ Resuming the interrupted turn",
        detail: "Checking the saved OpenCode session",
        phase: "preparing",
        active: false,
      });
      const deliver: (content: string) => Promise<unknown> = status
        ? (content) => setStatusMessage(status, content).catch(() => undefined)
        : thread
          ? (content) => thread.send(content).catch(() => undefined)
          : async () => undefined;
      // The recovered turn is presented like any other: the report goes to the
      // status message when it survived the restart, and both messages go to
      // the thread when it did not.
      const deliverCards = status
        ? (result: MutationResult, note?: string) => setTurnCards(status, result, note).catch(() => undefined)
        : (result: MutationResult, note?: string) => {
            if (!thread) return Promise.resolve(undefined);
            const state = turnCardState(result, note);
            return thread.send({ ...renderTechnicalCard(state), components: [] })
              .then(() => postPlayCard(thread, state))
              .catch(() => undefined);
          };
      const recoveryCallback = progress
        ? withQuestionPings(progress.callback, project.threadId, project.pendingTurn.requesterId)
        : undefined;
      projects.enqueue(project.threadId, async () => {
        try {
          const result = await projects.recoverTurn(project.threadId, recoveryCallback);
          await progress?.close();
          if (result.validationError || result.deliveryError || (!result.commit && !result.noChanges)) {
            await deliver(finishedWithErrorsMessageText(result));
            await sendOutcomeFollowUp(thread, result, { operation: "restart-recovery", guildId: project.guildId });
          } else {
            const recoveryHead = result.noChanges
              ? "♻️ Recovered the interrupted turn after a restart · no changes to the site"
              : `♻️ Recovered the interrupted turn after a restart · commit \`${result.commit}\` · ${result.commitFiles} file${result.commitFiles === 1 ? "" : "s"} changed (+${result.additions}/−${result.deletions})`;
            await deliverCards(result, recoveryHead);
          }
        } catch (error) {
          await progress?.close();
          if (error instanceof TurnStoppedError) {
            await deliver("🛑 **Stopped at your request** — the recovered turn's partial edits are preserved in the workspace.");
            return;
          }
          const incident = await reportFailure(error, {
            operation: "restart-recovery",
            guildId: project.guildId,
            threadId: project.threadId,
            project,
            model: store.getModel() || "the model default",
          });
          await deliver(
            `${quotaNotice(error) ? `${quotaNotice(error)}\n` : ""}❌ Could not recover the interrupted turn from the last restart · reference \`${incident.id}\`. Partial edits were kept — send a message to try again.`,
          );
        } finally {
          void recheckExternalPush(project.threadId);
          void refreshProjectCard(project.threadId);
        }
      }).catch((error) => logError("project.queue_failed", error, { threadId: project.threadId }));
    }

    // Messages coalesced for the next pass when the bot stopped were
    // acknowledged in the thread but never started; re-run them as one
    // catch-up turn behind the recovery so nothing is silently lost.
    const queuedAtBoot = project.pendingQueue?.filter((entry) => entry.prompt.trim()) ?? [];
    if (queuedAtBoot.length && thread) {
      projects.enqueue(project.threadId, async () => {
        const fresh = store.getProject(project.threadId);
        // Re-read on the queue: /site queue (or a cancelled entry) may have
        // withdrawn some of these between boot and this closure running.
        const queued = fresh?.pendingQueue?.filter((entry) => entry.prompt.trim()) ?? [];
        if (!fresh || !queued.length) {
          const accumulator = pendingUpdates.get(project.threadId);
          if (accumulator) {
            accumulator.scheduled = false;
            if (accumulator.entries.length) scheduleUpdateDrain(project.threadId, project.projectKind === "game-2d" || project.projectKind === "game-3d");
            else pendingUpdates.delete(project.threadId);
          }
          return;
        }
        const live = await thread.messages.fetch(queued[0].statusMessageId).catch(() => undefined);
        const status = live && live.author.id === client.user?.id
          ? live
          : await thread.send(`🔁 Re-running ${queued.length} message${queued.length === 1 ? "" : "s"} that were queued when the bot restarted…`).catch(() => undefined);
        if (!status) return;
        const isGame = fresh.projectKind === "game-2d" || fresh.projectKind === "game-3d";
        const progress = new DiscordProgress(status, `🔁 Catching up ${fresh.displayName}`);
        registerQuestionButtons(status, progress);
        const entries: QueuedUpdate[] = [];
        for (const [index, entry] of queued.entries()) {
          const previous = index === 0 ? status : await thread.messages.fetch(entry.statusMessageId).catch(() => undefined);
          const message = previous?.author.id === client.user?.id ? previous
            : await thread.send("🔁 Restored a queued request after restart.");
          entries.push({
            prompt: entry.prompt,
            requestStatusId: entry.statusMessageId,
            images: entry.images ?? [],
            author: entry.author,
            requesterId: entry.requesterId,
            status: message && message.author.id === client.user?.id ? message : status,
            ...(index === 0 ? { progress } : {}),
          });
        }
        log("info", "project.queued_messages_recovered", { threadId: project.threadId, messages: queued.length });
        const accumulator = pendingUpdates.get(project.threadId)!;
        accumulator.entries.unshift(...entries);
        accumulator.scheduled = false;
        scheduleUpdateDrain(project.threadId, isGame);
      }).catch((error) => logError("project.queue_failed", error, { threadId: project.threadId }));
    } else {
      const accumulator = pendingUpdates.get(project.threadId);
      if (accumulator) {
        accumulator.scheduled = false;
        if (accumulator.entries.length) scheduleUpdateDrain(project.threadId, project.projectKind === "game-2d" || project.projectKind === "game-3d");
        else pendingUpdates.delete(project.threadId);
      }
    }
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    try {
      if (interaction.customId.startsWith("q:") || interaction.customId.startsWith("qskip:")) {
        await handleQuestionButton(interaction);
      } else if (interaction.customId === "threadsite:stop") {
        await handleStopButton(interaction);
      } else if (interaction.customId.startsWith("threadsite:qcancel:")) {
        await handleQueueCancelButton(interaction);
      } else if (interaction.customId.startsWith("threadsite:ext")) {
        await handleExternalPushButton(interaction);
      } else {
        await handleFailureButton(interaction);
      }
    } catch (error) {
      logError("discord.button_failed", error, {
        customId: interaction.customId,
        userId: interaction.user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
      });
      const text = `❌ ${truncate(errorText(error), 1800)}`;
      if (interaction.deferred || interaction.replied) await interaction.editReply(text).catch(() => undefined);
      else await interaction.reply({ content: text, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
    return;
  }
  if (interaction.isAutocomplete()) {
    try {
      await handleAutocomplete(interaction);
    } catch (error) {
      logError("discord.autocomplete_failed", error, {
        command: interaction.commandName,
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });
      await interaction.respond([]).catch(() => undefined);
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === "site") await handleSiteCommand(interaction);
    if (interaction.commandName === "makegam") await handleMakeGameCommand(interaction);
    if (interaction.commandName === "site-admin") await handleAdminCommand(interaction);
  } catch (error) {
    logError("discord.command_failed", error, {
      command: interaction.commandName,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
    });
    // Slash command replies here are ephemeral, so the invoking user can safely receive the useful detail.
    const text = `❌ ${truncate(errorText(error), 1800)}`;
    if (interaction.deferred || interaction.replied) await interaction.editReply(text).catch(() => undefined);
    else await interaction.reply({ content: text, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
});

// Per-thread update coalescing: while a turn is running (or queued), further
// messages merge into ONE follow-up turn instead of each becoming a full
// sequential agent turn. The accumulator exists from the first message of a
// burst until no entries remain after a drain; entries carry their own status
// replies so every message gets a visible outcome.
interface QueuedUpdate {
  prompt: string;
  images: PromptImage[];
  author?: CommitAuthor;
  /** Discord user whose message started the batch; pinged when the agent asks a question. */
  requesterId?: string;
  status: Message;
  /** Original persisted key, retained when recovery replaces a deleted status message. */
  requestStatusId?: string;
  /** Progress instance already live on this status (the burst-initial message). */
  progress?: DiscordProgress;
}

interface PendingUpdate {
  entries: QueuedUpdate[];
  /** True while a drain closure sits on the project queue. */
  scheduled: boolean;
}

const pendingUpdates = new Map<string, PendingUpdate>();
/**
 * Persisted request ids that a drain has taken but has not started prompting
 * yet. `/site queue` must not remove these from the store: the in-memory batch
 * already holds the prompt, so cancelling would still run it.
 */
const inFlightQueuedRequests = new Set<string>();

// Threads whose project is still being created. The store record only appears
// at the very end of createProject (after engine install, repo creation, and
// webhook registration), so message handlers and thread deletion must consult
// this set for that window — otherwise messages are dropped silently and a
// deleted thread still gets a published site.
const creatingThreads = new Set<string>();
// Threads deleted while their project was being created. The creation closure
// checks this when it finishes and tears the fresh project down.
const abandonedThreads = new Set<string>();
// External-push prompts currently being delivered, keyed thread:commit.
const externalPushInFlight = new Set<string>();

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guildId || !message.channel.isThread()) return;
  const project = store.getProject(message.channel.id);
  if (!project) {
    // The thread exists but its record does not yet: setup is still running.
    // Acknowledge instead of dropping the message on the floor.
    if (creatingThreads.has(message.channel.id)) {
      await message
        .reply("⏳ This thread is still being set up — please send that again once the first build starts.")
        .catch(() => undefined);
    }
    return;
  }
  if (shuttingDown) {
    await message.reply("♻️ The bot is restarting — please send this again in a moment.").catch(() => undefined);
    return;
  }
  const content = message.content.trim();
  const imageAttachments = [...message.attachments.values()].filter((attachment) =>
    (attachment.contentType ?? "").startsWith("image/")
  );
  if (!content && !imageAttachments.length) {
    if (message.attachments.size > 0) {
      // A PDF/zip/log attachment with no text: nothing will ever consume it, so
      // say so instead of leaving the message unanswered.
      await message
        .reply("🚫 Only images can be attached right now — describe the change you want in text instead.")
        .catch(() => undefined);
    }
    return;
  }

  // Acknowledge first: the capability check below calls the agent service,
  // whose HTTP timeouts are disabled by design, so a wedged service would
  // otherwise leave the message with no reply at all.
  const status = await message.reply("⏳ Saving your request…").catch(() => undefined);
  if (!status) {
    log("warn", "discord.reply_failed", { threadId: message.channel.id });
    return;
  }

  // Images only reach the agent when the model the next turn will run on is
  // verified vision-capable; anything else drops them, and an image-only
  // message says so in the thread instead of vanishing silently.
  let images: PromptImage[] = [];
  if (imageAttachments.length) {
    const accepts = await withTimeout(
      projects.modelAcceptsImages(message.channel.id).catch(() => undefined),
      3000,
    );
    if (accepts === true) {
      images = await downloadImageAttachments(imageAttachments);
      log("info", "discord.images_forwarded", { threadId: message.channel.id, requested: imageAttachments.length, downloaded: images.length });
      if (!images.length && !content) {
        await status.edit("🚫 The image could not be downloaded, so there was nothing to send. Please try attaching it again.").catch(() => undefined);
        return;
      }
    } else if (!content) {
      await status.edit(
        accepts === undefined
          ? "🚫 Could not confirm that this project's model can see images, so the attachment was not sent. Describe the change you want in text instead."
          : "🚫 This project's model can't see images, so the attachment was not sent. Describe the change you want in text instead.",
      ).catch(() => undefined);
      return;
    }
  }
  const prompt = content
    || (images.length ? `The user attached ${images.length} image${images.length === 1 ? "" : "s"} to this message.` : "");
  if (!prompt) {
    await status.edit("🚫 There was nothing to send. Describe the change you want in text instead.").catch(() => undefined);
    return;
  }

  // Only an explicit Discord reply to the current turn's status can steer it.
  // Ordinary messages, replies to other messages, images and late replies queue.
  if (!imageAttachments.length && await projects.steerActiveTurn(message.channel.id, prompt, message.reference?.messageId)) {
    await status.edit("🧭 Sent to the running turn").catch(() => undefined);
    return;
  }

  const author = commitAuthorIdentity({
    displayName: message.member?.displayName,
    globalName: message.author.globalName,
    username: message.author.username,
    id: message.author.id,
  });

  const isGame = project.projectKind === "game-2d" || project.projectKind === "game-3d";

  try {
    // Save every accepted message, including the first one, before exposing it to a drain.
    await store.appendQueuedRequest(message.channel.id, {
      prompt, author, requesterId: message.author.id, statusMessageId: status.id, images: images.length ? images : undefined,
    });
  } catch (error) {
    await status.edit("❌ Could not save this request. Please send it again.").catch(() => undefined);
    throw error;
  }
  await status.edit("✅ Request saved — queued for the next update pass.").catch(() => undefined);
  let pending = pendingUpdates.get(message.channel.id);
  if (!pending) {
    pending = { entries: [], scheduled: false };
    pendingUpdates.set(message.channel.id, pending);
  }
  pending.entries.push({ prompt, images, author, requesterId: message.author.id, status });
  const running = store.getProject(message.channel.id);
  if (running?.pendingTurn?.statusMessageId) {
    liveProgress.get(running.pendingTurn.statusMessageId)?.callback({
      kind: "queue", text: "Saved requests", queuedRequests: running.pendingQueue?.length ?? 0,
    });
  }
  scheduleUpdateDrain(message.channel.id, isGame);
});

function scheduleUpdateDrain(threadId: string, isGame: boolean): void {
  const pending = pendingUpdates.get(threadId);
  if (!pending || pending.scheduled) return;
  pending.scheduled = true;
  projects.enqueue(threadId, async () => {
    // Take over scheduling duty only now that this closure actually runs:
    // appends from here on must trigger a fresh drain after this turn.
    const state = pendingUpdates.get(threadId);
    if (state) state.scheduled = false;
    const batch = takeUpdateBatch(threadId);
    try {
      if (batch) await runUpdateTurn(threadId, isGame, batch);
    } finally {
      // Overflow was put back into the accumulator and is cancellable again.
      if (batch) for (const entry of batch) inFlightQueuedRequests.delete(entry.requestStatusId ?? entry.status.id);
    }
  }).catch((error) => logError("project.queue_failed", error, { threadId })).finally(() => {
    const state = pendingUpdates.get(threadId);
    if (!state) return;
    if (state.entries.length) scheduleUpdateDrain(threadId, isGame);
    else pendingUpdates.delete(threadId);
  });
}

/**
 * Take the in-memory batch. Its persisted requests stay queued until mutate()
 * atomically replaces exactly the consumed entries with a pendingTurn marker.
 */
function takeUpdateBatch(threadId: string): QueuedUpdate[] | undefined {
  const pending = pendingUpdates.get(threadId);
  if (!pending || !pending.entries.length) return undefined;
  const entries = pending.entries;
  pending.entries = [];
  for (const entry of entries) inFlightQueuedRequests.add(entry.requestStatusId ?? entry.status.id);
  return entries;
}

/**
 * Merge a batch into one prompt (first message plus a numbered list of the
 * rest, so the commit subject still reads as the user's own request). Entries
 * that no longer fit under the prompt cap overflow back into the accumulator
 * and become their own follow-up turn.
 */
function mergeUpdateBatch(batch: QueuedUpdate[]): { prompt: string; display: string | undefined; images: PromptImage[]; overflow: QueuedUpdate[] } {
  const head = batch[0].prompt;
  const images = [...batch[0].images];
  const rest: string[] = [];
  // The card repeats the user's own words only when this turn merges several
  // messages: a single message is still visible in the thread. The merged
  // prompt's harness preamble is never shown — that text is for the model.
  const requests = [head];
  let used = head.length;
  for (let index = 1; index < batch.length; index += 1) {
    const entry = batch[index];
    if (used + entry.prompt.length + 8 > config.maxPromptChars - 160) {
      return {
        prompt: composeMergedPrompt(head, rest),
        display: mergedDisplay(requests),
        images,
        overflow: batch.slice(index),
      };
    }
    rest.push(`${rest.length + 2}. ${entry.prompt}`);
    requests.push(entry.prompt);
    images.push(...entry.images);
    used += entry.prompt.length + 8;
  }
  return { prompt: composeMergedPrompt(head, rest), display: mergedDisplay(requests), images, overflow: [] };
}

/** Display text for a merged batch, or undefined when only one message ran. */
function mergedDisplay(requests: readonly string[]): string | undefined {
  return requests.length > 1 ? requestDisplayText(requests) : undefined;
}

function composeMergedPrompt(head: string, rest: string[]): string {
  if (!rest.length) return head;
  return `${head}\n\nWhile updates were queued, the user sent ${rest.length} more message${rest.length === 1 ? "" : "s"} — apply all of them in this same pass:\n${rest.join("\n")}`;
}

async function runUpdateTurn(threadId: string, isGame: boolean, batch: QueuedUpdate[]): Promise<void> {
  const first = batch[0];
  const project = store.getProject(threadId);
  if (!project) {
    for (const entry of batch) await entry.status.edit("❌ This thread's project no longer exists.").catch(() => undefined);
    return;
  }
  const progress = first.progress ?? new DiscordProgress(first.status, `${isGame ? "🎮 Updating" : "🛠️ Updating"} ${project.displayName}`);
  if (!first.progress) registerQuestionButtons(first.status, progress);
  const callback = withQuestionPings(progress.callback, threadId, first.requesterId);
  const merged = mergeUpdateBatch(batch);
  const consumed = batch.slice(0, batch.length - merged.overflow.length);
  for (const entry of consumed.slice(1)) {
    await entry.progress?.close();
    unregisterQuestionButtons(entry.status.id);
    await entry.status.edit({ content: "🔗 Merged into the update above", embeds: [], components: [] }).catch(() => undefined);
  }
  if (merged.overflow.length) {
    const pending = pendingUpdates.get(threadId);
    if (pending) pending.entries.unshift(...merged.overflow);
  }
  progress.enableStopButton();
  try {
    const result = await projects.mutate(threadId, merged.prompt, false, callback, first.author, first.status.id, merged.images, consumed.map((entry) => entry.requestStatusId ?? entry.status.id), merged.display, first.requesterId);
    await progress.close();
    if (result.validationError || result.deliveryError || (!result.commit && !result.noChanges)) {
      await setStatusMessage(first.status, finishedWithErrorsMessageText(result));
      const outcomeChannel = first.status.channel;
      await sendOutcomeFollowUp("send" in outcomeChannel ? outcomeChannel : undefined, result, {
        operation: "thread-update",
        guildId: project.guildId,
      });
    } else {
      await publishTurnResult(first.status, result, isGame);
    }
  } catch (error) {
    await progress.close();
    if (error instanceof TurnStoppedError) {
      await setStatusMessage(
        first.status,
        "🛑 **Stopped at your request** — the agent's partial edits are preserved in the workspace. Reply here to build on them, or roll them back below.",
        (await offerEditsChoice(store.getProject(threadId), error)) ? [failureEditsRow()] : undefined,
      );
      return;
    }
    const incident = await reportFailure(error, {
      operation: "thread-update",
      guildId: project.guildId,
      threadId,
      project,
      model: store.getModel() || "the model default",
    });
    await setStatusMessage(
      first.status,
      `${quotaNotice(error) ? `${quotaNotice(error)}\n` : ""}❌ Update failed · reference \`${incident.id}\`. The previous published version is unchanged.`,
      (await offerEditsChoice(project, error)) ? [failureEditsRow()] : undefined,
    );
  } finally {
    void recheckExternalPush(threadId);
    void refreshProjectCard(threadId);
  }
}

// Deleting a thread tears the project down: workspace, Forgejo repo, and published page.
// Deletion intent is unambiguous, so this does not queue behind the thread's
// running turn — forceDeleteProject blocks new work, aborts the agent, waits
// for active delivery, and retains a retry receipt until every resource is gone.
async function handleThreadDeleted(threadId: string, reason: string): Promise<void> {
  if (creatingThreads.has(threadId)) abandonedThreads.add(threadId);
  if (!store.getProject(threadId)) {
    // Deleted while createProject is still running: there is no record to tear
    // down yet, so mark it and let the creation closure remove what it builds.
    if (creatingThreads.has(threadId)) {
      abandonedThreads.add(threadId);
      log("warn", "project.thread_deleted_during_creation", { threadId, reason });
    }
    return;
  }
  pendingUpdates.delete(threadId);
  try {
    await projects.forceDeleteProject(threadId, reason);
    log("info", "project.thread_deleted", { threadId, reason });
  } catch (error) {
    logError("project.thread_delete_failed", error, { threadId, reason });
  }
}

client.on(Events.ThreadDelete, (thread) => {
  void handleThreadDeleted(thread.id, "thread-delete");
});

// Deleting a parent channel cascades thread deletions without individual ThreadDelete events.
client.on(Events.ChannelDelete, (channel) => {
  for (const project of store.listProjects()) {
    if (project.parentChannelId === channel.id) void handleThreadDeleted(project.threadId, "parent-channel-delete");
  }
});

await client.login(config.discordToken);

async function registerCommands(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  if (config.discordGuildId) {
    await rest.put(Routes.applicationGuildCommands(config.discordApplicationId, config.discordGuildId), { body: commandJson });
    log("info", "discord.commands_registered", { scope: "guild", guildId: config.discordGuildId });
  } else {
    await rest.put(Routes.applicationCommands(config.discordApplicationId), { body: commandJson });
    log("info", "discord.commands_registered", { scope: "global" });
  }
}

/**
 * Shared thread-creation flow for /site start and /makegam: resolve or create
 * the thread, pin the project card, open the live status card, enqueue the
 * first build, and deliver the outcome — the two commands differ only in
 * labels, project kind, and the multiplayer mode.
 */
async function startProjectThread(
  interaction: ChatInputCommandInteraction,
  options: {
    projectKind: ProjectKind;
    multiplayerMode?: MultiplayerMode;
    commandName: string;
    preparingText: string;
    buildingPrefix: string;
    acceptedText: string;
    outcome: "site" | "game";
    operation: string;
  },
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    throw new Error(options.projectKind === "site" ? "Sites can only be used in a server." : "Games can only be created in a server.");
  }
  const prompt = interaction.options.getString("prompt", true).trim();
  const requestedName = interaction.options.getString("name")?.trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (shuttingDown) throw new Error("The bot is restarting — try again in a moment.");

  const { thread, created } = await resolveOrCreateThread(interaction, requestedName || prompt,
    options.projectKind === "site" ? undefined : "game");
  if (store.getProject(thread.id)) {
    throw new Error(options.projectKind === "site"
      ? "That thread already has a site. Just reply in the thread to mutate it."
      : "That thread already has a project. Use a fresh thread for /makegam, then reply normally to mutate the game.");
  }
  // The pinned project card goes up FIRST — before the turn's status
  // message — so the thread opens with its front page on top.
  const card = await postProjectCard(thread, previewProjectRecord(
    thread.id, interaction.guildId, thread.parentId || interaction.channelId, requestedName || thread.name, prompt,
    options.projectKind, options.multiplayerMode,
  ));
  const status = await thread.send(options.preparingText);
  const progress = new DiscordProgress(status, `${options.buildingPrefix} Building ${requestedName || thread.name}`);
  registerQuestionButtons(status, progress);
  progress.enableStopButton();
  progress.update(options.acceptedText);
  const callback = withQuestionPings(progress.callback, thread.id, interaction.user.id);

  await interaction.editReply(`Created/attached <#${thread.id}>.`);
  creatingThreads.add(thread.id);
  projects.enqueue(thread.id, async () => {
    try {
      // The thread may have been deleted while this job waited in the queue.
      if (abandonedThreads.has(thread.id)) return;
      const result = await projects.createProject({
        threadId: thread.id,
        guildId: interaction.guildId,
        parentChannelId: thread.parentId || interaction.channelId,
        displayName: requestedName || thread.name,
        initialPrompt: prompt,
        projectKind: options.projectKind,
        multiplayerMode: options.multiplayerMode,
        renameable: created && !requestedName,
        initiator: interactionInitiator(interaction),
        initiatorUserId: interaction.user.id,
        statusMessageId: status.id,
        infoMessageId: card?.id,
      }, callback, (title) => applyAiThreadTitle(thread, title));
      await progress.close();
      if (result.validationError || result.deliveryError || (!result.commit && !result.noChanges)) {
        await setStatusMessage(status, finishedWithErrorsMessageText(result,
          options.outcome === "site" ? "Eevery message in this thread edits this same site. Run `/site help` for details." : undefined));
        await sendOutcomeFollowUp(thread, result, {
          operation: options.operation,
          guildId: interaction.guildId,
          requesterId: interaction.user.id,
        });
      } else {
        await publishTurnResult(status, result, options.outcome === "game",
          options.outcome === "site" ? "From now on, **every normal message in this thread edits this same site**. Run `/site help` for details." : undefined);
      }
    } catch (error) {
      await progress.close();
      if (error instanceof TurnStoppedError) {
        await setStatusMessage(
          status,
          "🛑 **Stopped at your request** — the partial first build is preserved in the workspace. Reply here to continue from it.",
        );
        return;
      }
      const project = store.getProject(thread.id);
      // Setup died before the record existed: the pinned card has no project
      // to describe, so take it down instead of pinning a ghost.
      if (!project) await card?.delete().catch(() => undefined);
      const incident = await reportFailure(error, {
        operation: options.operation,
        guildId: interaction.guildId,
        threadId: thread.id,
        requesterId: interaction.user.id,
        project,
        model: store.getModel() || "the model default",
      });
      const retry = project
        ? "Reply in this thread to retry after the configuration/provider issue is fixed."
        : `Run \`${options.commandName}\` again inside this thread after the setup issue is fixed.`;
      await setStatusMessage(
        status,
        `${quotaNotice(error) ? `${quotaNotice(error)}\n` : ""}❌ ${options.outcome === "site" ? "Initial generation" : "Initial game generation"} failed · reference \`${incident.id}\`. ${retry}`,
        (await offerEditsChoice(project, error)) ? [failureEditsRow()] : undefined,
      );
    } finally {
      // A thread deleted mid-setup must not leave a repository and a live
      // site behind: the delete event found no record, so clean up here.
      if (abandonedThreads.has(thread.id) && store.getProject(thread.id)) {
        void projects.forceDeleteProject(thread.id).catch((error) => {
          logError("project.abandoned_teardown_failed", error, { threadId: thread.id });
        });
      }
      creatingThreads.delete(thread.id);
      abandonedThreads.delete(thread.id);
      void recheckExternalPush(thread.id);
      if (store.getProject(thread.id)) void refreshProjectCard(thread.id);
    }
  }).catch((error) => logError("project.queue_failed", error, { threadId: thread.id }));
}

async function handleSiteCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (!interaction.inGuild() || !interaction.guildId) throw new Error("Sites can only be used in a server.");

  if (sub === "start") {
    await startProjectThread(interaction, {
      projectKind: "site",
      commandName: "/site start",
      buildingPrefix: "🛠️",
      preparingText: "🛠️ Preparing this thread's persistent site…",
      acceptedText: "📋 Request accepted",
      outcome: "site",
      operation: "initial-site-build",
    });
    return;
  }

  if (sub === "help") {
    await interaction.reply({
      content:
        "**ThreadSite** — every normal message in a project thread edits its site or game.\n" +
        "Use Discord Reply on the **running turn's status message** to steer it live. Other messages queue for the next update; several queued requests may merge into one update. Image attachments reach the model when it can see them and always queue for the next pass. " +
        "The live status message carries a **Stop** button while a turn runs; `/site stop` works even if that message is gone. " +
        "A turn with no progress for a few minutes is flagged on the card. Failures offer rollback or keep.\n\n" +
        "**/site start** — create a site (works in any channel)\n" +
        "**/makegam** — create a 2D or 3D game thread\n" +
        "**/site info** — links, project type, model, usage\n" +
        "**/site rename name:…** — change the project name and links (old site links redirect)\n" +
        "**/site sync** — adopt commits pushed to the repo from outside the bot\n" +
        "**/site republish** — rebuild and republish without the model\n" +
        "**/site compact** — summarize the session context now\n" +
        "**/site multiplayer** — switch a game between arena, rooms, and singleplayer (the agent asks how, then rewrites the netcode; you get pinged when it asks)\n" +
        "**/site stop** — interrupt the running turn without dropping its session\n" +
        "**/site queue** — show queued messages and cancel individual entries\n" +
        "**/site revert** — undo the last accepted turn\n" +
        "**/site reset** — stop the running turn and drop the agent session (site kept)\n" +
        "**/site pushkey** — issue repo-scoped git push credentials\n" +
        "**/site-admin** — admin: model, effort, usage, errors, reset (Manage Server)\n\n" +
        "Deleting the Discord thread deletes the project, workspace, repository, and published site.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.channel?.isThread()) throw new Error(`/${interaction.commandName} ${sub} must be used inside a site thread.`);
  const project = store.getProject(interaction.channel.id);
  if (!project) throw new Error("This thread has no site. Use /site start first.");

  if (sub === "info") {
    const usage = await usageLog.threadTotal(project.threadId);
    const context = project.lastTurnUsage;
    const contextLine = context?.contextTokens
      ? `\nSession context: ${formatTokens(context.contextTokens)}${context.contextLimit ? ` of ${formatTokens(context.contextLimit)} (${Math.round((context.contextTokens / context.contextLimit) * 100)}%)` : ""}`
      : "";
    await interaction.reply({
      content:
        `**${project.displayName}** — ${project.status}\n` +
        `[open site](${projects.siteLink(project)}) · [source](${projects.repoLink(project)})\n` +
        `Type: ${projectKindLabel(project.projectKind)}${project.multiplayerMode && project.projectKind !== "site" ? ` (${project.multiplayerMode === "arena" ? "arena multiplayer" : project.multiplayerMode === "rooms" ? "invite-code rooms" : "singleplayer"})` : ""}\n` +
        `Model: \`${store.getModel() || "the model default"}\` · Effort: \`${store.getEffort() || "auto"}\`` +
        contextLine + "\n" +
        threadUsageText(usage, isAdmin(interaction)) +
        (project.lastError && config.errorReportUserIds.has(interaction.user.id) ? `\nLast private error summary: ${truncate(project.lastError, 900)}` : ""),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "rename") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const name = interaction.options.getString("name", true);
    const renamed = await projects.enqueue(project.threadId, () => projects.renameProject(project.threadId, name));
    let titleUpdated = true;
    await applyAiThreadTitle(interaction.channel, renamed.displayName).catch((error) => {
      titleUpdated = false;
      log("warn", "project.thread_rename_failed", { threadId: project.threadId, error: serializeError(error) });
    });
    await interaction.editReply(`Renamed to **${renamed.displayName}**.\n[open site](${projects.siteLink(renamed)}) · [source](${projects.repoLink(renamed)})\nOld site links redirect to the new address.${titleUpdated ? "" : "\nThe thread title could not be updated yet; it will be retried."}`);
    void refreshProjectCard(project.threadId);
    return;
  }

  if (sub === "republish") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const updated = await projects.enqueue(project.threadId, () => projects.republish(project.threadId));
    await interaction.editReply(`Republished [${updated.displayName}](${projects.siteLink(updated)}) without calling the model.`);
    return;
  }

  if (sub === "sync") {
    await interaction.deferReply();
    const status = await interaction.channel?.send("📥 Syncing the workspace with the repository…").catch(() => undefined);
    const progress = status ? new DiscordProgress(status, `📥 Syncing ${project.displayName}`) : undefined;
    try {
      const result = await projects.enqueue(project.threadId, () => projects.sync(project.threadId, progress?.callback));
      await progress?.close();
      if (result.validationError) {
        await interaction.editReply(
          `⚠️ Synced to \`${result.commit}\`, but validation failed — the live site keeps the previous version.\n` +
          `${truncate(result.validationError, 1200)}\n` +
          "The commits remain in the repository; reply in this thread to have the agent fix them.",
        );
      } else {
        const detail = result.behind === 0 && result.ahead === 0
          ? "the repository had nothing new — republished the checked-in tree"
          : `pulled ${result.behind} commit${result.behind === 1 ? "" : "s"}, rebased ${result.ahead} local commit${result.ahead === 1 ? "" : "s"}`;
        await interaction.editReply(
          `✅ **${result.project.displayName}** synced on \`${result.commit}\` — ${detail}.\n` +
          `[open site](${projects.siteLink(result.project)}) · [source](${projects.repoLink(result.project)})`,
        );
      }
    } finally {
      await progress?.close();
      void refreshProjectCard(project.threadId);
    }
    return;
  }

  if (sub === "compact") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await projects.enqueue(project.threadId, () => projects.compact(project.threadId));
    await interaction.editReply(
      `🧠 Compaction started with \`${result.model}\`. Older session context is being summarized; ` +
      "this thread keeps working normally afterwards. The site itself is unchanged.",
    );
    return;
  }

  if (sub === "multiplayer") {
    const raw = interaction.options.getString("mode", true);
    const mode: MultiplayerMode = raw === "rooms" || raw === "singleplayer" ? raw : "arena";
    const userNote = interaction.options.getString("prompt")?.trim() || undefined;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!project.projectKind || project.projectKind === "site") {
      throw new Error("Multiplayer architectures apply to games. Create one with /makegam.");
    }
    if ((project.multiplayerMode ?? "arena") === mode) {
      await interaction.editReply(`This game already runs ${multiplayerModeLabel(mode)}.`);
      return;
    }
    const status = await interaction.channel?.send(`🕹️ Switching the multiplayer architecture to **${multiplayerModeLabel(mode)}** — the agent will inspect the netcode, then ask about anything it finds tricky…`).catch(() => undefined);
    if (!status) throw new Error("Could not post a status message in this thread.");
    const progress = new DiscordProgress(status, `🕹️ Rewiring ${project.displayName}`);
    registerQuestionButtons(status, progress);
    progress.enableStopButton();
    const callback = withQuestionPings(progress.callback, project.threadId, interaction.user.id);
    try {
      const result = await projects.enqueue(project.threadId, () =>
        projects.switchMultiplayer(project.threadId, mode, status.id, callback, interaction.user.id, userNote));
      await progress.close();
      if (result.validationError || result.deliveryError || (!result.commit && !result.noChanges)) {
        await setStatusMessage(status, finishedWithErrorsMessageText(result));
        await sendOutcomeFollowUp(interaction.channel, result, {
          operation: "multiplayer-switch",
          guildId: interaction.guildId,
          requesterId: interaction.user.id,
        });
        await interaction.editReply(`The switch to ${multiplayerModeLabel(mode)} did not land cleanly — see the status message. The architecture setting is already switched; reply here to have the agent finish the rewrite.`);
      } else {
        await publishTurnResult(status, result, true, `The game now runs **${multiplayerModeLabel(mode)}**.`);
        await interaction.editReply(`Switched to ${multiplayerModeLabel(mode)}.`);
      }
    } catch (error) {
      await progress.close();
      if (error instanceof TurnStoppedError) {
        await setStatusMessage(status, "🛑 **Stopped at your request** — the half-finished network rewrite is preserved in the workspace. Reply here to continue it.");
        await interaction.editReply("Stopped. The architecture setting is switched; reply in the thread to finish the rewrite.");
        return;
      }
      const incident = await reportFailure(error, {
        operation: "multiplayer-switch",
        guildId: interaction.guildId,
        threadId: project.threadId,
        project,
        requesterId: interaction.user.id,
        model: store.getModel() || "the model default",
      });
      await setStatusMessage(
        status,
        `${quotaNotice(error) ? `${quotaNotice(error)}\n` : ""}❌ Multiplayer switch failed · reference \`${incident.id}\`. The architecture setting is switched; reply here to have the agent finish or revert the rewrite.`,
      );
      await interaction.editReply(`The switch failed — reference \`${incident.id}\`.`);
    } finally {
      void refreshProjectCard(project.threadId);
    }
    return;
  }

  if (sub === "stop") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // Deliberately not queued: a stop that waited behind the turn it targets
    // would be useless when the turn is wedged on an unreachable provider.
    const outcome = await projects.stopTurn(project.threadId);
    await interaction.editReply(stopOutcomeText(outcome));
    if (outcome.stopped) log("info", "discord.stop_command_used", { threadId: project.threadId, userId: interaction.user.id });
    return;
  }

  if (sub === "queue") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await showQueue(interaction, project.threadId);
    return;
  }

  if (sub === "reset") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // Deliberately not queued: the reset must not wait behind the very turn it
    // is meant to stop. It severs the thread's queue, aborts a running turn,
    // and swaps in a fresh session; the stopped turn (if any) reports failure
    // in the thread through its normal path.
    const stoppedStatusId = project.pendingTurn?.statusMessageId;
    const { stoppedTurn } = await projects.resetSession(project.threadId);
    if (stoppedStatusId) {
      // The stopped turn's live status message would otherwise keep its
      // heartbeat forever (its prompt may never settle); retire it now.
      await liveProgress.get(stoppedStatusId)?.close();
      unregisterQuestionButtons(stoppedStatusId);
      const stopped = await interaction.channel?.messages.fetch(stoppedStatusId).catch(() => undefined);
      if (stopped && stopped.author.id === client.user?.id) {
        await stopped.edit({
          content: "🛑 This turn was stopped by `/site reset` — its agent session was dropped. Send a new message to continue.",
          embeds: [], components: [],
        }).catch(() => undefined);
      }
    }
    await interaction.editReply(
      `🔄 Agent session dropped${stoppedTurn ? " — the running turn was stopped and will report a failure in this thread" : ""}. ` +
      "Anything waiting in this thread's queue was released, and the next message starts a fresh conversation — " +
      "the site, git history, and project notes are all kept.",
    );
    void refreshProjectCard(project.threadId);
    return;
  }

  if (sub === "revert") {
    await interaction.deferReply();
    const result = await projects.enqueue(project.threadId, () => projects.revert(project.threadId));
    const updated = store.getProject(project.threadId) ?? project;
    const body = result.undoneCommit
      ? `↩️ Undid the last turn (commit \`${result.undoneCommit}\`) and republished \`${result.keptCommit}\`.`
      : "↩️ The last turn had not been published, so only its conversation with the agent was removed.";
    await interaction.editReply(
      `${body}${result.conversationReverted ? "" : "\n⚠️ The agent conversation revert failed (see the bot log); files and git were still reverted."}\n` +
      `[open site](${projects.siteLink(updated)}) · [source](${projects.repoLink(updated)})`,
    );
    void refreshProjectCard(project.threadId);
    return;
  }

  if (sub === "pushkey") {
    const rotate = interaction.options.getBoolean("rotate") ?? false;
    await interaction.deferReply();
    const { project: updated, created } = await projects.enqueue(project.threadId, () => projects.issuePushKey(project.threadId, rotate));
    if (!updated.pushKey) throw new Error("Push key issuance failed.");
    await interaction.editReply(
      (created
        ? `🔑 ${rotate ? "Rotated" : "Issued"} repository push credentials for **${updated.displayName}**:\n`
        : "🔑 A push key already exists for this thread (use `rotate: true` to replace it):\n") +
      "```\n" +
      `git clone ${forgejo.repoGitPublicUrl(updated.repoName)}\n` +
      `username: ${updated.pushKey.username}\n` +
      `password: ${updated.pushKey.password}\n` +
      "```\n" +
      "These credentials can push to this project's repository only. A push does not go live until someone publishes it here in the thread.",
    );
    return;
  }
}

async function handleMakeGameCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const dimension = interaction.options.getString("dimension", true);
  const rawMode = interaction.options.getString("multiplayer");
  await startProjectThread(interaction, {
    projectKind: dimension === "3d" ? "game-3d" : "game-2d",
    multiplayerMode: rawMode === "rooms" || rawMode === "singleplayer" ? rawMode : "arena",
    commandName: "/makegam",
    buildingPrefix: "🎮",
    preparingText: "🎮 Preparing a persistent static web game…",
    acceptedText: "🕹️ Game profile selected",
    outcome: "game",
    operation: "initial-game-build",
  });
}

async function handleAdminCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) throw new Error("Admin commands can only be used in a server.");
  if (!isAdmin(interaction)) throw new Error("You need Manage Server (or an allowlisted admin user ID) to use this command.");
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (sub === "status") {
    await interaction.editReply(
      `Model: \`${store.getModel() || "the model default"}\`\n` +
      `Effort: \`${store.getEffort() || "auto"}\`\n` +
      `Agent service: ${await opencode.health()}\n` +
      `Provider quota: ${opencode.quotaStatus()}\n` +
      `Failover: ${config.opencodeFailoverModels.length ? config.opencodeFailoverModels.join(", ") : "disabled (fail fast on quota)"}\n` +
      `Light turns: ${config.opencodeLightModel ? `${config.opencodeLightModel} (≤ ${config.opencodeLightPromptChars} chars, no images)` : "disabled"}\n` +
      `Browser QA: ${config.browserQaEnabled ? `enabled (${config.previewMcpUrl})` : "disabled"}\n` +
      `Web search: enabled for agent research\n` +
      `Asset tool: guarded downloads to site/assets\n` +
      `Multiplayer relay: ${await multiplayerRelayStatus()}\n` +
      `Forgejo: ${config.forgejoPublicUrl}/${config.forgejoOwner}\n` +
      `Sites: ${config.publicSitesBaseUrl}\n` +
      `Transport recovery: ${Math.round(config.opencodeReconcileTimeoutMs / 60000)}m window · ${config.opencodeReconcilePollMs}ms poll\n` +
      `Private error recipients: ${config.errorReportUserIds.size}\n` +
      `Bot log: \`${getLogFile()}\``,
    );
    return;
  }

  if (sub === "usage") {
    const days = interaction.options.getInteger("days") ?? 7;
    await interaction.editReply(await usageLog.renderReport(days));
    return;
  }

  if (sub === "models") {
    // The admin-only counterpart of the model detail removed from the public
    // pinned card: active routing plus which models actually served which
    // projects, with token/cost figures.
    const breakdown = await usageLog.modelBreakdown();
    const header = `🎛️ Active model: \`${store.getModel() || "the model default"}\` · effort \`${store.getEffort() || "auto"}\``
      + (config.opencodeLightModel ? ` · light turns \`${config.opencodeLightModel}\`` : "");
    const modelLines = breakdown.models.map((model) =>
      `\`${model.model}\` — ${model.turns} turn${model.turns === 1 ? "" : "s"} · in ${formatTokens(model.inputTokens)} · out ${formatTokens(model.outputTokens)} · ${formatCost(model.cost)}`,
    );
    const projectLines = breakdown.threads.map(({ threadId, project, turns, models }) => {
      const context = store.getProject(threadId)?.lastTurnUsage;
      const contextBit = context?.contextTokens && context.contextLimit
        ? ` · ctx ${Math.round((context.contextTokens / context.contextLimit) * 100)}%`
        : "";
      const used = models.slice(0, 3).map((model) => `\`${model.model}\` (${model.turns})`).join(", ");
      return `**${truncate(project, 40)}** — ${turns} turn${turns === 1 ? "" : "s"}${contextBit}${used ? `\n· ${used}` : ""}`;
    });
    const body = modelLines.length
      ? `**Models (lifetime, all projects)**\n${modelLines.join("\n")}${projectLines.length ? `\n\n**Per project**\n${projectLines.join("\n")}` : ""}`
      : "No model usage recorded yet.";
    await interaction.editReply(truncate(`${header}\n\n${body}`, 1950));
    return;
  }

  if (sub === "model") {
    const raw = interaction.options.getString("model", true).trim();
    const model = /^default$/i.test(raw) ? undefined : raw;
    if (model && !/^[^/\s]+\/.+/.test(model)) throw new Error("Model must use provider/model-id format.");
    await store.setModel(model);
    log("info", "admin.model_changed", { userId: interaction.user.id, model: model || "default" });
    await interaction.editReply(`Future turns will use \`${model || "the model default"}\`. Existing thread sessions switch on their next message too.`);
    for (const project of store.listProjects()) void refreshProjectCard(project.threadId);
    return;
  }

  if (sub === "effort") {
    const level = interaction.options.getString("level", true);
    await store.setEffort(level === "auto" ? undefined : level);
    log("info", "admin.effort_changed", { userId: interaction.user.id, effort: level });
    await interaction.editReply(
      level === "auto"
        ? "Future turns will use the model's default reasoning effort."
        : `Future turns will request \`${level}\` reasoning effort. Models without that variant just fall back to their default.`,
    );
    for (const project of store.listProjects()) void refreshProjectCard(project.threadId);
    return;
  }

  if (sub === "token") {
    const provider = interaction.options.getString("provider", true).trim();
    const token = interaction.options.getString("token", true);
    await opencode.setProviderToken(provider, token);
    await interaction.editReply(`Stored a new API credential for provider \`${provider}\`. The token is not echoed or stored in the Discord bot state/log.`);
    return;
  }

  if (sub === "token-clear") {
    const provider = interaction.options.getString("provider", true).trim();
    await opencode.clearProviderToken(provider);
    await interaction.editReply(`Removed the stored credential for \`${provider}\`.`);
    return;
  }

  if (sub === "reset") {
    const summary = await projects.resetAllSessions();
    log("info", "admin.reset_all", { userId: interaction.user.id, ...summary });
    if (!summary.total && !summary.aborted) {
      await interaction.editReply("Nothing to reset — no projects exist and no agent sessions were active.");
      return;
    }
    await interaction.editReply(
      `🛑 Hard reset complete: aborted ${summary.aborted} running turn(s) and deleted every agent session on the service. ` +
      `Fresh sessions were started for ${summary.stopped}/${summary.total} project(s).` +
      `${summary.failed ? ` ${summary.failed} project(s) could not be re-sessioned — see the bot log.` : ""}\n` +
      "Sites, git history, and project notes are untouched. Interrupted threads will show a failure message for the turn that was stopped.",
    );
    return;
  }

  if (sub === "errors") {
    if (!config.errorReportUserIds.has(interaction.user.id)) {
      throw new Error("This private diagnostic command is restricted to DISCORD_ERROR_REPORT_USER_IDS.");
    }
    const limit = interaction.options.getInteger("limit") ?? 5;
    const incidents = await recentIncidents(limit);
    if (!incidents.length) {
      await interaction.editReply("No recorded ThreadSite failure incidents were found in the current log window.");
      return;
    }
    const body = incidents.map((incident) => {
      const operation = typeof incident.context.operation === "string" ? incident.context.operation : "unknown";
      const model = typeof incident.context.model === "string" ? incident.context.model : undefined;
      const detail = incident.details ? `\nCause: ${truncate(JSON.stringify(incident.details), 450)}` : "";
      return `**${incident.id}** · ${incident.timestamp}\n${operation}${model ? ` · \`${model}\`` : ""}\n${truncate(incident.message, 600)}${detail}`;
    }).join("\n\n");
    await interaction.editReply(truncate(body, 1950));
  }
}

// Autocomplete currently serves only /site-admin model: the agent service's
// current free OpenCode models plus the configured Surplus models, filtered by
// what the admin has typed. Choice names are the exact "provider/model-id"
// strings the command accepts; "default" is offered too since it clears the
// override. The command stays free-text — unlisted provider/model ids remain
// valid.
async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (interaction.commandName !== "site-admin" || interaction.options.getSubcommand(false) !== "model") {
    await interaction.respond([]);
    return;
  }
  // The chat-input command enforces Manage Server (or an allowlisted admin
  // id); the autocomplete must not become a way for other members to
  // enumerate the deployment's model list just because a server admin
  // overrode the command's default permissions.
  if (!isAdmin(interaction)) {
    await interaction.respond([]);
    return;
  }
  const typed = interaction.options.getFocused().trim().toLowerCase();
  // Discord drops the suggestion list unless the autocomplete answers within
  // ~3s. The provider list is cached on the harness, so this normally answers
  // instantly; the race only falls back to "default" when the agent service is
  // unreachable or wedged.
  const catalog = await Promise.race([
    opencode.listSelectableModels(),
    new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 2_500)),
  ]);
  const matchTier = (id: string): number => {
    if (!typed) return 1;
    if (id === typed) return 0;
    if (id.startsWith(typed)) return 1;
    return 2;
  };
  const choices = ["default", ...catalog]
    .filter((id) => id.length <= 100 && (!typed || id.toLowerCase().includes(typed)))
    .sort((a, b) => matchTier(a) - matchTier(b) || a.localeCompare(b))
    .slice(0, 25)
    .map((id) => ({ name: id, value: id }));
  await interaction.respond(choices);
}

// Final success message: status line, agent summary, stats, then the play/open
// and git links. The summary gets whatever budget the fixed parts leave free;
// a fixed 1600-char allowance let long project names and URLs push the whole
// message past Discord's 2000-char edit cap and lose the turn report. Recovery
// passes a ♻️ head override; its summary then shows whether the turn was
// continued by the agent or had already finished on the agent side.
function successMessageText(result: MutationResult, isGame: boolean, note?: string, headOverride?: string): string {
  const head = headOverride
    ?? (result.noChanges
      ? `ℹ️ **${result.project.displayName}** — no changes to the site this turn`
      : `✅ **${result.project.displayName}** · commit \`${result.commit}\` · ${commitStatsText(result)}`);
  const stats = turnStatsText(result);
  const notes = [note, result.browserQaFindings?.length ? `⚠️ Browser QA: ${truncate(result.browserQaFindings[0], 220)} · findings saved for the next update` : undefined].filter(Boolean);
  const noteLine = notes.length ? `\n${notes.join("\n")}\n` : "\n";
  const links = `# [${isGame ? "PLAY GAME" : "OPEN SITE"}](${projects.siteLink(result.project)})\n[git](<${projects.repoLink(result.project)}>)`;
  const budget = MAX_DISCORD_MESSAGE_CHARS - head.length - stats.length - noteLine.length - links.length - 1;
  return `${head}${agentSummaryText(result.agentSummary, budget)}\n${stats}${noteLine}${links}`;
}

// Final message for a turn whose agent finished but whose work did not ship
// cleanly: validation failed (committed, not published), publishing failed
// (committed, not live), or the commit itself failed (edits kept in the
// workspace). The agent's summary still leads; the error detail follows in a
// separate thread message (sendOutcomeFollowUp).
function finishedWithErrorsMessageText(result: MutationResult, note?: string): string {
  const head = !result.commit
    ? result.noChanges
      ? result.validationError
        ? `ℹ️ **${result.project.displayName}** — nothing changed this turn; validation errors persist and the live site still shows the older version`
        : `ℹ️ **${result.project.displayName}** — answered without changing the project · nothing to commit`
      : `⚠️ **${result.project.displayName}** — the agent finished, but committing failed · edits preserved in the workspace`
    : result.validationError
      ? `⚠️ **${result.project.displayName}** · validation failed — committed \`${result.commit}\`, not published · ${commitStatsText(result)}`
      : `⚠️ **${result.project.displayName}** · committed \`${result.commit}\`, but publishing failed — not live · ${commitStatsText(result)}`;
  const stats = turnStatsText(result);
  const noteLine = note ? `\n${note}\n` : "\n";
  const links = `[git](<${projects.repoLink(result.project)}>)`;
  const budget = MAX_DISCORD_MESSAGE_CHARS - head.length - stats.length - noteLine.length - links.length - 1;
  return `${head}${agentSummaryText(result.agentSummary, budget)}\n${stats}${noteLine}${links}`;
}

/** `12 files changed (+300/−20)` — shared by the success and outcome heads. */
function commitStatsText(result: MutationResult): string {
  return `${result.commitFiles} file${result.commitFiles === 1 ? "" : "s"} changed (+${result.additions}/−${result.deletions})`;
}

// Final-message summary block: agent text minus the meta opener ("Implemented a
// complete 3D browser game in site/…"), squeezed into the given character budget.
function agentSummaryText(raw: string | undefined, budget: number): string {
  if (budget < 80) return "";
  const stripped = raw ? stripSummaryPreamble(raw) : "";
  return stripped ? `\n${truncate(stripped, budget - 1)}` : "";
}

// Final-message subtext: how long the turn took plus its cumulative token
// usage and the context size the model ended on, when the agent reported them.
function turnStatsText(result: MutationResult): string {
  const usage = result.usage ? formatTurnUsage(result.usage) : "";
  return `-# ⏱️ ${formatShortDuration(result.durationMs)}${usage ? ` · 🧠 ${usage}` : ""}`;
}

/**
 * Follow-up thread message with the errors behind a finished-but-unshipped
 * turn: validation errors verbatim, and — for commit/publish pipeline
 * failures, which are operational — an incident reference for the private
 * error report. Best-effort delivery; the outcome message already went out.
 */
async function sendOutcomeFollowUp(
  channel: { send?: (options: { content: string }) => Promise<unknown> } | undefined,
  result: MutationResult,
  context: { operation: string; guildId?: string | null; requesterId?: string },
): Promise<void> {
  if (!channel?.send) return;
  const blocks: string[] = [];
  if (result.validationError) {
    blocks.push(
      `⚠️ **Validation errors**${result.commit
        ? ` — the work is committed as \`${result.commit}\` but **not published**; the live version is unchanged`
        : result.noChanges
          ? " — and nothing changed this turn, so there is no new work to fix; the live site still shows the older version"
          : " — and the work could not be committed"}.\n`
        + `${truncate(result.validationError, 900)}\n`
        + "Reply in this thread to have the agent fix these errors.",
    );
  }
  // No-change turns have no operational failure: the block below is only for
  // real commit/publish problems.
  if ((!result.commit && !result.noChanges) || result.deliveryError) {
    const incident = await reportFailure(new Error(result.deliveryError ?? "Committing the finished work failed"), {
      operation: context.operation,
      guildId: context.guildId,
      threadId: result.project.threadId,
      requesterId: context.requesterId,
      project: result.project,
      model: store.getModel() || "the model default",
    });
    blocks.push(!result.commit
      ? `❌ Committing the finished work failed · reference \`${incident.id}\`.\n${truncate(result.deliveryError ?? "", 600)}\nThe agent's edits are preserved in the workspace — reply in this thread to try again.`
      : `❌ Publishing failed after commit \`${result.commit}\` · reference \`${incident.id}\`.\n${truncate(result.deliveryError ?? "", 600)}\nThe live site keeps the previous version — try \`/site republish\` once the server issue is resolved.`);
  }
  if (!blocks.length) return;
  await channel.send({ content: truncate(blocks.join("\n\n"), MAX_DISCORD_MESSAGE_CHARS) }).catch(() => undefined);
}

// /site info usage block: the thread's lifetime ledgered usage. Token counts
// are public; the spend figure stays admin-only, matching /site-admin usage.
function threadUsageText(total: UsageTotal, includeCost: boolean): string {
  if (!total.turns) return "Usage: none recorded yet";
  const cached = total.cacheTokens > 0 ? ` (${formatTokens(total.cacheTokens)} cached)` : "";
  const cost = includeCost ? ` · ${formatCost(total.cost)}` : "";
  const failed = total.failedTurns > 0 ? ` · ${total.failedTurns} failed` : "";
  // Per-model figures for this thread (the card keeps only the totals).
  const models = [...total.models.values()]
    .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))
    .slice(0, 8)
    .map((model) => `\`${model.model}\` — ${model.turns} turn${model.turns === 1 ? "" : "s"} · in ${formatTokens(model.inputTokens)} · out ${formatTokens(model.outputTokens)}${includeCost ? ` · ${formatCost(model.cost)}` : ""}`);
  const more = total.models.size - 8;
  return `Usage: ${total.turns} model turns${failed} · in ${formatTokens(total.inputTokens)}${cached} · out ${formatTokens(total.outputTokens)} tok${cost}\n`
    + `Models:\n${models.join("\n")}${more > 0 ? `\n+${more} more model${more === 1 ? "" : "s"}` : ""}`;
}

// --- The pinned project card -------------------------------------------------
// Posted when a project thread is created, pinned to it, and edited in place
// after every outcome: the durable front page (original request, model,
// settings, lifetime usage, links), unlike the per-turn tracking card.

async function projectCardState(project: ProjectRecord): Promise<ProjectCardState> {
  return {
    project,
    usage: await usageLog.threadTotal(project.threadId),
    siteUrl: project.status !== "creating" ? projects.siteLink(project) : undefined,
    repoUrl: project.repoName ? projects.repoLink(project) : undefined,
  };
}

/** Any channel a project card can be posted into (project threads, in practice). */
interface CardChannel {
  send(options: ProjectCardMessage): Promise<Message>;
}

/** Send the card, pin it, and link it to the project record when one exists. */
async function postProjectCard(thread: CardChannel, project: ProjectRecord): Promise<Message | undefined> {
  const message = await thread.send({ ...renderProjectCard(await projectCardState(project)) }).catch((error: unknown) => {
    log("warn", "discord.project_card_post_failed", { threadId: project.threadId, error: serializeError(error) });
    return undefined;
  });
  if (!message) return undefined;
  // Pinning needs Manage Messages; an unpinned card still works, it just does
  // not sit at the top of the thread.
  await message.pin().catch((error) => log("warn", "discord.project_card_pin_failed", { threadId: project.threadId, error: serializeError(error) }));
  if (store.getProject(project.threadId)) {
    await store.patchProject(project.threadId, { infoMessageId: message.id, infoCardVersion: PROJECT_CARD_VERSION }).catch(() => undefined);
  }
  log("info", "discord.project_card_posted", { threadId: project.threadId, messageId: message.id, version: PROJECT_CARD_VERSION });
  return message;
}

/** Edit the pinned card in place; (re)post and pin when missing or deleted. */
async function refreshProjectCard(threadId: string): Promise<void> {
  try {
    const project = store.getProject(threadId);
    if (!project) return;
    const channel = await client.channels.fetch(threadId).catch(() => undefined);
    const thread = channel?.isTextBased() && "send" in channel ? channel : undefined;
    if (!thread) return;
    if (project.infoMessageId) {
      const card = await thread.messages.fetch(project.infoMessageId).catch(() => undefined);
      if (card && card.author.id === client.user?.id) {
        await card.edit(renderProjectCard(await projectCardState(project)));
        // A refresh always renders the current design; sync a stale stored
        // version so boot reconciliation can skip this card next time.
        if (project.infoCardVersion !== PROJECT_CARD_VERSION) {
          await store.patchProject(threadId, { infoCardVersion: PROJECT_CARD_VERSION }).catch(() => undefined);
        }
        return;
      }
    }
    await postProjectCard(thread, project);
  } catch (error) {
    log("warn", "discord.project_card_refresh_failed", { threadId, error: serializeError(error) });
  }
}

/** A stand-in record so the card can render before createProject persists the real one. */
function previewProjectRecord(
  threadId: string, guildId: string, parentChannelId: string, displayName: string, prompt: string,
  projectKind: ProjectKind, multiplayerMode?: MultiplayerMode,
): ProjectRecord {
  const now = new Date().toISOString();
  return {
    threadId, guildId, parentChannelId, displayName, workspacePath: "", siteSlug: "", repoName: "", sessionId: "",
    projectKind, status: "creating", createdAt: now, updatedAt: now, initialPrompt: truncate(prompt, 2_000),
    ...(projectKind !== "site" ? { multiplayerMode: multiplayerMode ?? "arena" as const } : {}),
  };
}

/**
 * Boot-time card reconciliation: projects from before the card feature get
 * one, and cards still on an older design version are upgraded — bump
 * PROJECT_CARD_VERSION and every pinned card re-renders on the next start.
 */
async function reconcileProjectCards(): Promise<void> {
  for (const project of store.listProjects()) {
    if (project.pendingDeletion) continue;
    const usageChanged = await projects.reconcileProjectUsage(project.threadId);
    if (!usageChanged && project.infoMessageId && project.infoCardVersion === PROJECT_CARD_VERSION) continue;
    await refreshProjectCard(project.threadId);
  }
}

/**
 * Wrap a turn's progress callback so the first appearance of each agent
 * question pings the requester in the thread: the buttons live on the status
 * card and are easy to miss, while a parked question holds the whole turn
 * (and the thread's queue) open.
 */
function withQuestionPings(callback: ProgressCallback, threadId: string, requesterId?: string): ProgressCallback {
  if (!requesterId) return callback;
  const pinged = new Set<string>();
  return (update) => {
    if (update.kind === "question" && update.question && !update.question.resolved
      && update.question.requestID && !pinged.has(update.question.requestID)) {
      pinged.add(update.question.requestID);
      void client.channels.fetch(threadId).then(async (channel) => {
        if (channel?.isTextBased() && "send" in channel) {
          await channel.send({
            content: `<@${requesterId}> ❓ The agent needs your answer to continue`,
            allowedMentions: { users: [requesterId] },
          }).catch(() => undefined);
        }
      }).catch(() => undefined);
    }
    return callback(update);
  };
}

function isAdmin(interaction: ChatInputCommandInteraction | AutocompleteInteraction): boolean {
  if (config.adminUserIds.has(interaction.user.id)) return true;
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

// Slash-command variant of the commit author: prefer the server display name,
// then the global name, then the raw @username.
function interactionInitiator(interaction: ChatInputCommandInteraction) {
  const member = interaction.guild?.members.cache.get(interaction.user.id);
  return commitAuthorIdentity({
    displayName: member?.displayName,
    globalName: interaction.user.globalName,
    username: interaction.user.username,
    id: interaction.user.id,
  });
}

async function resolveOrCreateThread(
  interaction: ChatInputCommandInteraction,
  nameSource: string,
  prefix = "site",
): Promise<{ thread: ThreadChannel; created: boolean }> {
  if (interaction.channel?.isThread()) return { thread: interaction.channel, created: false };
  if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
    throw new Error("Run /site start or /makegam in a normal text channel or an existing thread.");
  }
  const name = truncate(`${prefix}-${slugify(nameSource)}`, 90);
  const thread = await interaction.channel.threads.create({
    name,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    type: ChannelType.PublicThread,
    reason: `ThreadSite requested by ${interaction.user.tag}`,
  });
  return { thread, created: true };
}

// Discord acknowledgement is separate from repository delivery; retain its
// pending marker until setName succeeds, including resumed builds.
async function applyAiThreadTitle(thread: ThreadChannel, title: string): Promise<void> {
  if (thread.name !== truncate(title, 100)) await thread.setName(truncate(title, 100));
  if (store.getProject(thread.id)?.pendingThreadName === title) {
    await store.patchProject(thread.id, { pendingThreadName: undefined });
  }
}

/**
 * Present a finished turn in two messages: the turn's own message becomes the
 * technical card (the agent's report, the commit, the usage), and a new
 * message under it carries the playable card (the screenshot, the preview, the
 * play link). Servers without Embed Links permission get the same information
 * as text.
 */
async function setTurnCards(status: Message, result: MutationResult, note?: string): Promise<void> {
  // The cards replace the live status: any pending agent-question buttons on
  // it are gone, so stop routing clicks for this message.
  await liveProgress.get(status.id)?.close();
  unregisterQuestionButtons(status.id);
  const state = turnCardState(result, note);
  try {
    await status.edit({ ...renderTechnicalCard(state), components: [] });
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === 50013) {
      // No Embed Links permission: the same information as plain text.
      await status.edit({ ...renderTechnicalText(state), components: [] });
    } else if (code === 10008) {
      // The status message was deleted mid-turn: deliver the report as a fresh
      // thread message instead of failing the whole turn report.
      const { channel } = status;
      if (!("send" in channel)) throw error;
      await channel.send({ ...renderTechnicalCard(state), components: [] }).catch(() => undefined);
    } else {
      throw error;
    }
  }
  // The playable card is a message of its own, under the turn's report.
  await postPlayCard(status.channel, state);
}

/** Post the playable card — the screenshot, the preview and the play link. */
async function postPlayCard(channel: TextBasedChannel, state: TurnCardState): Promise<void> {
  if (!("send" in channel)) return;
  const card = renderPlayCard(state);
  try {
    await channel.send({ ...card, components: [] });
  } catch (error) {
    if ((error as { code?: number }).code === 50013) {
      // No Embed Links permission: the same information as plain text, with
      // the screenshot attached as an ordinary file.
      await channel.send({ ...renderPlayText(state), files: card.files, components: [] }).catch(() => undefined);
      return;
    }
    log("warn", "discord.play_card_post_failed", { error: String(error) });
  }
}

/** The card state of a finished turn: what the agent did and what shipped. */
function turnCardState(result: MutationResult, note?: string): TurnCardState {
  return {
    name: result.project.displayName,
    kind: result.project.projectKind ?? "site",
    published: !result.validationError && !result.deliveryError,
    commit: result.commit,
    commitFiles: result.commitFiles,
    additions: result.additions,
    deletions: result.deletions,
    durationMs: result.durationMs,
    usage: result.usage,
    summary: result.agentSummary,
    note,
    findings: result.browserQaFindings,
    description: result.description,
    changelog: result.changelog,
    request: result.project.initialPrompt,
    meta: turnCardMeta(result.project),
    siteUrl: projects.siteLink(result.project),
    repoUrl: projects.repoLink(result.project),
    screenshot: result.screenshot,
  };
}

/** The playable card's footer: the dimension and how the game is played. */
function turnCardMeta(project: ProjectRecord): string | undefined {
  const kind = project.projectKind ?? "site";
  if (kind === "site") return undefined;
  const dimension = kind === "game-3d" ? "3D" : "2D";
  return `${dimension} · ${multiplayerModeLabel(project.multiplayerMode ?? "arena")}`;
}

/**
 * The final post of a turn. A failure to build the cards must never swallow
 * the turn's report: fall back to the plain-text outcome.
 */
async function publishTurnResult(status: Message, result: MutationResult, isGame: boolean, note?: string): Promise<void> {
  try {
    await setTurnCards(status, result, note);
  } catch (error) {
    log("warn", "discord.turn_cards_failed", { messageId: status.id, error: String(error) });
    await setStatusMessage(status, successMessageText(result, isGame, note)).catch(() => undefined);
  }
}

function failureEditsRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("threadsite:rollback").setLabel("Rollback edits").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("threadsite:keep").setLabel("Keep edits").setStyle(ButtonStyle.Success),
  );
}

/**
 * Publish a final outcome on a turn's live status message. The user may have
 * deleted that message mid-turn (Discord 10008 Unknown Message) — deliver the
 * outcome as a fresh thread message instead of failing the whole turn report.
 * Content is hard-capped under Discord's 2000-char limit so no assembly bug
 * above this point can make the delivery itself fail.
 */
async function setStatusMessage(
  status: Message,
  content: string,
  components?: ActionRowBuilder<ButtonBuilder>[],
): Promise<void> {
  // The outcome message replaces the live status: any pending agent-question
  // buttons on it are gone, so stop routing clicks for this message.
  await liveProgress.get(status.id)?.close();
  unregisterQuestionButtons(status.id);
  // Discord keeps existing components when an edit omits them — an explicit
  // empty array is what actually strips leftover question buttons.
  const payload = { content: truncate(content, MAX_DISCORD_MESSAGE_CHARS), embeds: [], components: components ?? [], allowedMentions: { parse: [] as never[] } };
  try {
    await status.edit(payload);
  } catch (error) {
    if ((error as { code?: number }).code !== 10008) throw error;
    const { channel } = status;
    if ("send" in channel) await channel.send(payload).catch(() => undefined);
  }
}

/**
 * Decide whether the failure message should offer rollback/keep buttons: only for
 * attached projects (there is a workspace to roll back) and only when the agent
 * turn provably stopped — rolling back underneath a live turn would race it.
 */
async function offerEditsChoice(project: ProjectRecord | undefined, error: unknown): Promise<boolean> {
  if (!project) return false;
  if ((error as any)?.mayStillBeRunning) return false;
  try {
    return !(await projects.agentBusy(project.threadId));
  } catch {
    return false;
  }
}

// Publish/Dismiss on an external-push prompt. Publish adopts the pushed commit
// and takes it live through the normal build/validate/publish path; Dismiss
// adopts it into git history only. Both must go through the project queue so
// they cannot race an in-flight agent turn.
async function handleExternalPushButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.channel?.isThread()) {
    throw new Error("This button only works inside a project thread.");
  }
  const publish = interaction.customId === "threadsite:extpub";
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (shuttingDown) throw new Error("The bot is restarting — try again in a moment.");
  if (await projects.agentBusy(interaction.channel.id)) {
    throw new Error("An agent turn is currently running in this thread. Wait for it to finish before deciding.");
  }
  // One decision per prompt: strip the buttons before the queued work runs.
  await interaction.message.edit({ components: [] }).catch(() => undefined);

  if (publish) {
    const result = await projects.enqueue(interaction.channel.id, () => projects.publishExternalPush(interaction.channel!.id));
    if (result.validationError) {
      await interaction.editReply(
        `⚠️ The pushed commit \`${result.commit}\` failed validation and was **not** published — the live site keeps the previous version.\n` +
        `${truncate(result.validationError, 1200)}\n` +
        "The commit remains in the repository; reply in this thread to have the agent fix it.",
      );
    } else {
      await interaction.editReply(
        `✅ Published external commit \`${result.commit}\` — [open site](${projects.siteLink(result.project)})`,
      );
    }
  } else {
    const result = await projects.enqueue(interaction.channel.id, () => projects.adoptExternalCommit(interaction.channel!.id));
    await interaction.editReply(
      `🗂️ Adopted external commit \`${result.commit}\` into the workspace without publishing. The next message in this thread builds on it.`,
    );
  }
  log("info", "discord.external_push_button_used", { action: publish ? "publish" : "dismiss", threadId: interaction.channel.id, userId: interaction.user.id });
}

/** One wording for the Stop button and `/site stop`; the slash command exists
 * so a deleted status message or a turn that never rendered one is still
 * interruptible. */
function stopOutcomeText(outcome: StopTurnOutcome): string {
  if (outcome.stopped) {
    return "🛑 Stop requested — the running update is being interrupted. Its partial edits are kept; the status message will show the outcome.";
  }
  if (outcome.queueFreed) {
    return "⚠️ The agent service is not answering, so the running update could not be aborted. " +
      "The thread's queue has been freed so new messages are not blocked.";
  }
  if (outcome.delivering) {
    return "⏳ The agent has already finished and the update is now being validated, committed, and published. " +
      "There is nothing left to interrupt; the status message will show the result.";
  }
  return "No model turn is currently running in this thread. Waiting messages, if any, can be cancelled with `/site queue`.";
}

// Stop on a live status message: abort the running agent turn but keep the
// session, workspace, and history — the gentle alternative to /site reset.
// Works from the moment the button renders (queued turns report "nothing to
// stop" until the model actually starts).
async function handleStopButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.channel?.isThread()) {
    throw new Error("This button only works inside a project thread.");
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const outcome = await projects.stopTurn(interaction.channel.id);
  await interaction.editReply(stopOutcomeText(outcome));
  if (outcome.stopped) log("info", "discord.stop_button_used", { threadId: interaction.channel.id, userId: interaction.user.id });
}

/** How many queued entries `/site queue` lists and offers cancel buttons for. */
const MAX_QUEUE_LIST = 20;

/**
 * `/site queue`: make the backlog visible and withdraw individual waiting
 * messages. Entries a drain has already taken are reported separately — they
 * cannot be cancelled without removing the prompt from under the live batch.
 */
async function showQueue(interaction: ChatInputCommandInteraction, threadId: string): Promise<void> {
  const project = store.getProject(threadId);
  const all = project?.pendingQueue ?? [];
  const preparing = all.filter((entry) => inFlightQueuedRequests.has(entry.statusMessageId)).length;
  const queue = all.filter((entry) => !inFlightQueuedRequests.has(entry.statusMessageId));
  if (!queue.length) {
    await interaction.editReply(
      preparing
        ? `📭 Nothing else is queued. ${preparing} message${preparing === 1 ? " is" : "s are"} already part of the update being prepared — use \`/site stop\` to interrupt that turn.`
        : "📭 Nothing is queued in this thread.",
    );
    return;
  }

  const listed = queue.slice(0, MAX_QUEUE_LIST);
  const lines = listed.map((entry, index) => {
    const prompt = truncate(entry.prompt.replace(/\s+/g, " ").trim(), 70);
    const author = entry.author?.name ? ` — ${truncate(entry.author.name, 30)}` : "";
    const images = entry.images?.length ? ` · ${entry.images.length} image${entry.images.length === 1 ? "" : "s"}` : "";
    return `**${index + 1}.** ${prompt}${author}${images}`;
  });
  const header = `📬 **${queue.length}** message${queue.length === 1 ? "" : "s"} waiting for the next update pass. They run together after the current turn; cancel any with the buttons below.`;
  const preparingLine = preparing ? `\n⏳ ${preparing} more ${preparing === 1 ? "is" : "are"} already part of the update being prepared and can only be interrupted with \`/site stop\`.` : "";
  const moreLine = queue.length > listed.length ? `\n… and **${queue.length - listed.length}** more; cancel these or run \`/site queue\` again.` : "";
  const content = truncate(`${header}\n${lines.join("\n")}${preparingLine}${moreLine}`, MAX_DISCORD_MESSAGE_CHARS - 20);

  const rows: Array<ActionRowBuilder<ButtonBuilder>> = [];
  for (let start = 0; start < listed.length; start += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (let index = start; index < Math.min(start + 5, listed.length); index += 1) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`threadsite:qcancel:${listed[index].statusMessageId}`)
          .setLabel(`Cancel ${index + 1}`)
          .setStyle(ButtonStyle.Secondary),
      );
    }
    rows.push(row);
  }
  await interaction.editReply({ content, components: rows });
}

/** Remove one waiting request from the in-memory batch and the durable queue. */
async function handleQueueCancelButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.channel?.isThread()) {
    throw new Error("This button only works inside a project thread.");
  }
  const statusId = interaction.customId.slice("threadsite:qcancel:".length);
  if (!/^\d{5,25}$/.test(statusId)) throw new Error("That queue entry id is invalid.");
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const threadId = interaction.channel.id;
  if (inFlightQueuedRequests.has(statusId)) {
    await interaction.editReply("⏳ That request is already part of the update being prepared and can no longer be cancelled. Use `/site stop` to interrupt the turn.");
    return;
  }
  const pending = pendingUpdates.get(threadId);
  const index = pending
    ? pending.entries.findIndex((entry) => (entry.requestStatusId ?? entry.status.id) === statusId)
    : -1;
  const memory = index >= 0 ? pending!.entries.splice(index, 1)[0] : undefined;
  const stored = await store.cancelQueuedRequest(threadId, statusId);
  if (!memory && !stored.removed) {
    await interaction.editReply("That request is no longer queued.");
    return;
  }

  // The original acknowledgement message should say what happened to its request.
  const original = memory?.status
    ?? await interaction.channel.messages.fetch(statusId).catch(() => undefined);
  if (original && original.author.id === client.user?.id) {
    await original.edit({ content: "🚫 **Cancelled**", embeds: [], components: [] }).catch(() => undefined);
  }
  if (memory) {
    await memory.progress?.close();
    unregisterQuestionButtons(memory.status.id);
  }

  const fresh = store.getProject(threadId);
  const remaining = fresh?.pendingQueue?.length ?? 0;
  if (fresh?.pendingTurn?.statusMessageId) {
    liveProgress.get(fresh.pendingTurn.statusMessageId)?.callback({ kind: "queue", text: "Saved requests", queuedRequests: remaining });
  }
  const preview = truncate((stored.prompt ?? memory?.prompt ?? "").replace(/\s+/g, " ").trim(), 120);
  await interaction.editReply(`🚫 Cancelled${preview ? `: **${preview}**` : " that request"} · **${remaining}** still queued.`);
  log("info", "discord.queue_request_cancelled", { threadId, statusId, userId: interaction.user.id });
}

async function handleFailureButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.channel?.isThread()) {
    throw new Error("This button only works inside a project thread.");
  }
  const action = interaction.customId === "threadsite:rollback" ? "rollback" : "keep";
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (shuttingDown) throw new Error("The bot is restarting — try again in a moment.");
  if (await projects.agentBusy(interaction.channel.id)) {
    throw new Error("An agent turn is currently running in this thread. Wait for it to finish before deciding.");
  }

  // Remove the buttons from the failure message so the choice can't be repeated.
  await interaction.message.edit({ components: [] }).catch(() => undefined);

  if (action === "keep") {
    await interaction.editReply("🗂️ Keeping the partial edits — the next message will build on them.");
    return;
  }

  await projects.enqueue(interaction.channel.id, () => projects.rollbackEdits(interaction.channel!.id));
  await interaction.editReply("↩️ Rolled the workspace back to the last published commit. The partial edits were discarded.");
  log("info", "discord.failure_button_used", { action, threadId: interaction.channel.id, userId: interaction.user.id });
}

/**
 * Public wording for a quota-exhaustion failure (the OpenCode free tier's
 * daily limit): deliberately generic — the thread only learns the provider is
 * down and when to try again. The reason, subscribe pitch, and link go to
 * admins via the incident DM (one per block; see reportFailure). Ordinary
 * provider failures return undefined and keep the incident-reference wording.
 */
function quotaNotice(error: unknown): string | undefined {
  const block = (error as { quotaBlock?: QuotaBlock } | undefined)?.quotaBlock;
  if (!block || block.until <= Date.now()) return undefined;
  return `🚫 The AI provider is unavailable until ~${formatUtcClock(block.until)} (in ${formatShortDuration(block.until - Date.now())}) — new requests will fail fast until then. An admin has been notified with the details; try again after the reset.`;
}

// One admin DM per quota block (provider -> block.until): later fail-fast
// incidents during the same outage are still recorded for /site-admin errors
// and the log, but do not re-DM on every failed turn.
const quotaBlocksNotified = new Map<string, number>();

async function reportFailure(  error: unknown,
  context: {
    operation: string;
    guildId?: string | null;
    threadId?: string;
    requesterId?: string;
    project?: ProjectRecord;
    model?: string;
  },
): Promise<{ id: string; notified: boolean }> {
  const quotaBlock = (error as { quotaBlock?: QuotaBlock } | undefined)?.quotaBlock;
  const quotaDmSent = quotaBlock ? quotaBlocksNotified.get(quotaBlock.provider) === quotaBlock.until : false;
  if (quotaBlock && !quotaDmSent) quotaBlocksNotified.set(quotaBlock.provider, quotaBlock.until);
  const incident = await recordIncident(error, {
    operation: context.operation,
    guildId: context.guildId,
    threadId: context.threadId,
    requesterId: context.requesterId,
    projectName: context.project?.displayName,
    projectKind: context.project?.projectKind,
    repoName: context.project?.repoName,
    sessionId: context.project?.sessionId,
    model: context.model,
  });
  const notified = quotaDmSent ? false : await adminReporter.notify(incident);
  return { id: incident.id, notified };
}

// Discord CDN attachment URLs expire, so image bytes are downloaded at message
// receipt — before the turn waits behind the project queue — and embedded as
// data URIs that travel with the prompt request itself.
const MAX_TURN_IMAGES = 4;
const MAX_TURN_IMAGE_BYTES = 8 * 1024 * 1024;

async function downloadImageAttachments(attachments: Attachment[]): Promise<PromptImage[]> {
  const images: PromptImage[] = [];
  for (const attachment of attachments.slice(0, MAX_TURN_IMAGES)) {
    if (attachment.size > MAX_TURN_IMAGE_BYTES) {
      log("warn", "discord.image_attachment_too_large", { bytes: attachment.size });
      continue;
    }
    try {
      const response = await fetch(attachment.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const mime = attachment.contentType ?? "image/png";
      const base64 = Buffer.from(await response.arrayBuffer()).toString("base64");
      images.push({ mime, filename: attachment.name ?? undefined, dataUrl: `data:${mime};base64,${base64}` });
    } catch (error) {
      logError("discord.image_download_failed", error, { url: attachment.url });
    }
  }
  return images;
}

// Graceful shutdown: docker stop sends SIGTERM with ~10s before SIGKILL.
// Stop taking new work immediately, give in-flight turns a bounded window to
// finish and report their outcomes in their threads, then close Discord and
// exit. Turns that miss the window are recovered by the next boot's
// pendingTurn pass, exactly like a crash — but most restarts now avoid the
// spurious "update failed" messages a hard kill produces.
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "process.shutdown_begin", { signal, activeTurns: projects.activeTurnCount(), drainMs: config.shutdownDrainMs });
  stopExternalPushPoller();
  webhookServer?.close();
  const deadline = Date.now() + config.shutdownDrainMs;
  while (Date.now() < deadline && projects.activeTurnCount() > 0) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  log("info", "process.shutdown_exit", { activeTurnsRemaining: projects.activeTurnCount() });
  await client.destroy().catch(() => undefined);
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
