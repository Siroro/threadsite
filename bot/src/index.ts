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
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type Message,
  type ThreadChannel,
} from "discord.js";
import { AdminReporter } from "./admin-reporter.js";
import { commandJson } from "./commands.js";
import { config } from "./config.js";
import { ForgejoClient } from "./forgejo.js";
import { getLogFile, log, logError, recentIncidents, recordIncident } from "./logger.js";
import { multiplayerRelayStatus } from "./multiplayer.js";
import { OpenCodeHarness, formatTurnUsage } from "./opencode.js";
import { DiscordProgress, formatElapsed } from "./progress.js";
import { ProjectService, type MutationResult } from "./project.js";
import { Store } from "./store.js";
import { projectKindLabel } from "./templates.js";
import type { ProjectKind, ProjectRecord } from "./types.js";
import { UsageLog, type UsageTotal } from "./usage.js";
import { commitAuthorIdentity, errorText, formatCost, formatTokens, MAX_DISCORD_MESSAGE_CHARS, slugify, stripSummaryPreamble, truncate } from "./util.js";

// Stray async failures must log instead of killing the process: an unhandled
// rejection is process-fatal on Node 22 and would take every in-flight thread
// turn down with it. Individual turn failures are handled per-queue.
process.on("unhandledRejection", (reason) => {
  logError("process.unhandled_rejection", reason, {});
});
process.on("uncaughtException", (error) => {
  logError("process.uncaught_exception", error, {});
});

const store = await Store.open(config.stateFile, config.defaultModel);
const opencode = new OpenCodeHarness();
const forgejo = new ForgejoClient();
const usageLog = new UsageLog(config.usageLogFile);
const projects = new ProjectService(store, opencode, forgejo, usageLog);

await registerCommands();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
const adminReporter = new AdminReporter(client);

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
    await interaction.reply({ content: "That question is no longer pending — the turn it belonged to already finished.", flags: MessageFlags.Ephemeral }).catch(() => undefined);
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
  try {
    if (kind === "qskip") {
      await opencode.rejectQuestion(directory, requestID);
      await interaction.followUp({ content: "⏭️ Skipped — the agent will use its best judgment.", flags: MessageFlags.Ephemeral }).catch(() => undefined);
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
    await interaction.followUp({ content: `✅ Answered: **${truncate(label, 80)}**`, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  } finally {
    progress.clearQuestion(requestID);
  }
}

client.once(Events.ClientReady, (ready) => {
  log("info", "discord.ready", {
    user: ready.user.tag,
    version: "2.3.0",
    projects: store.listProjects().length,
    model: store.getModel() || "the model default",
    multiplayer: config.multiplayerEnabled ? config.gameserverPublicUrl : "disabled",
    errorRecipients: config.errorReportUserIds.size,
  });
  void recoverInterruptedTurns();
});

// Turns that were in flight when the bot stopped are marked in the store.
// Resume each one (continue the agent work, then commit and publish) now that
// Discord is available to report the outcome in the thread. The turn's own
// status message is resumed when it still exists, so the thread keeps one live
// message per request instead of a frozen leftover plus a new one; a fresh
// message is posted only as a fallback (e.g. the original was deleted).
async function recoverInterruptedTurns(): Promise<void> {
  const interrupted = store.listProjects().filter((project) => project.pendingTurn);
  if (!interrupted.length) return;
  log("info", "project.recovery_boot_scan", { interrupted: interrupted.length });
  for (const project of interrupted) {
    const channel = await client.channels.fetch(project.threadId).catch(() => undefined);
    const thread = channel?.isTextBased() && "send" in channel ? channel : undefined;
    let status: Message | undefined;
    if (thread && project.pendingTurn?.statusMessageId) {
      const resumed = await thread.messages.fetch(project.pendingTurn.statusMessageId).catch(() => undefined);
      if (resumed && resumed.author.id === client.user?.id) status = resumed;
    }
    if (!status && thread) {
      status = await thread.send("♻️ Resuming the turn that was in flight when the bot restarted…").catch(() => undefined);
    }
    const progress = status ? new DiscordProgress(status, `♻️ Recovering ${project.displayName}`) : undefined;
    if (status && progress) registerQuestionButtons(status, progress);
    progress?.update("♻️ Resuming the interrupted turn");
    const deliver: (content: string) => Promise<unknown> = status
      ? (content) => setStatusMessage(status, content).catch(() => undefined)
      : thread
        ? (content) => thread.send(content).catch(() => undefined)
        : async () => undefined;
    projects.enqueue(project.threadId, async () => {
      try {
        const result = await projects.recoverTurn(project.threadId, progress?.callback);
        progress?.close();
        const isGame = result.project.projectKind === "game-2d" || result.project.projectKind === "game-3d";
        if (result.validationError || result.deliveryError || (!result.commit && !result.noChanges)) {
          await deliver(finishedWithErrorsMessageText(result));
          await sendOutcomeFollowUp(thread, result, { operation: "restart-recovery", guildId: project.guildId });
        } else {
          const recoveryHead = result.noChanges
            ? "♻️ Recovered the interrupted turn after a restart · no changes to the site"
            : `♻️ Recovered the interrupted turn after a restart · commit \`${result.commit}\` · ${result.commitFiles} file${result.commitFiles === 1 ? "" : "s"} changed (+${result.additions}/−${result.deletions})`;
          await deliver(successMessageText(result, isGame, undefined, recoveryHead));
        }
      } catch (error) {
        progress?.close();
        const incident = await reportFailure(error, {
          operation: "restart-recovery",
          guildId: project.guildId,
          threadId: project.threadId,
          project,
          model: store.getModel() || "the model default",
        });
        await deliver(
          `❌ Could not recover the interrupted turn from the last restart · reference \`${incident.id}\`. Partial edits were kept — send a message to try again.`,
        );
      }
    }).catch((error) => logError("project.queue_failed", error, { threadId: project.threadId }));
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    try {
      if (interaction.customId.startsWith("q:") || interaction.customId.startsWith("qskip:")) {
        await handleQuestionButton(interaction);
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

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guildId || !message.channel.isThread()) return;
  const project = store.getProject(message.channel.id);
  if (!project) return;
  const content = message.content.trim();
  if (!content) return;

  const isGame = project.projectKind === "game-2d" || project.projectKind === "game-3d";
  const status = await message.reply(isGame ? "🎮 Queued game update…" : "🛠️ Queued site update…");
  const progress = new DiscordProgress(status, `${isGame ? "🎮 Updating" : "🛠️ Updating"} ${project.displayName}`);
  registerQuestionButtons(status, progress);
  progress.update("⏱️ Waiting for the project queue");

  projects.enqueue(message.channel.id, async () => {
    try {
      const result = await projects.mutate(
        message.channel.id,
        content,
        false,
        progress.callback,
        commitAuthorIdentity({
          displayName: message.member?.displayName,
          globalName: message.author.globalName,
          username: message.author.username,
          id: message.author.id,
        }),
        status.id,
      );
      progress.close();
      if (result.validationError || result.deliveryError || (!result.commit && !result.noChanges)) {
        await setStatusMessage(status, finishedWithErrorsMessageText(result));
        await sendOutcomeFollowUp(message.channel, result, {
          operation: "thread-update",
          guildId: message.guildId,
          requesterId: message.author.id,
        });
      } else {
        await setStatusMessage(status, successMessageText(result, isGame));
      }
    } catch (error) {
      progress.close();
      const incident = await reportFailure(error, {
        operation: "thread-update",
        guildId: message.guildId,
        threadId: message.channel.id,
        requesterId: message.author.id,
        project,
        model: store.getModel() || "the model default",
      });
      await setStatusMessage(
        status,
        `❌ Update failed · reference \`${incident.id}\`. The previous published version is unchanged.`,
        (await offerEditsChoice(project, error)) ? [failureEditsRow()] : undefined,
      );
    }
  }).catch((error) => logError("project.queue_failed", error, { threadId: message.channel.id }));
});

// Deleting a thread tears the project down: workspace, Forgejo repo, and published page.
async function handleThreadDeleted(threadId: string, reason: string): Promise<void> {
  if (!store.getProject(threadId)) return;
  try {
    await projects.enqueue(threadId, () => projects.deleteProject(threadId));
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
  if (!("parentId" in channel) || !channel.parentId) return;
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

async function handleSiteCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (!interaction.inGuild() || !interaction.guildId) throw new Error("Sites can only be used in a server.");

  if (sub === "start") {
    const prompt = interaction.options.getString("prompt", true).trim();
    const requestedName = interaction.options.getString("name")?.trim();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const { thread, created } = await resolveOrCreateThread(interaction, requestedName || prompt);
    if (store.getProject(thread.id)) throw new Error("That thread already has a site. Just reply in the thread to mutate it.");
    const status = await thread.send("🛠️ Preparing this thread's persistent site…");
    const progress = new DiscordProgress(status, `🛠️ Building ${requestedName || thread.name}`);
    registerQuestionButtons(status, progress);
    progress.update("📋 Request accepted");

    await interaction.editReply(`Created/attached <#${thread.id}>. The public thread will show live build stages; detailed failures stay private.`);
    projects.enqueue(thread.id, async () => {
      try {
        const result = await projects.createProject({
          threadId: thread.id,
          guildId: interaction.guildId!,
          parentChannelId: thread.parentId || interaction.channelId,
          displayName: requestedName || thread.name,
          initialPrompt: prompt,
          renameable: created && !requestedName,
          initiator: interactionInitiator(interaction),
          statusMessageId: status.id,
        }, progress.callback, created && !requestedName
          ? (title) => applyAiThreadTitle(thread, title)
          : undefined);
        progress.close();
        if (result.validationError || result.deliveryError || (!result.commit && !result.noChanges)) {
          await setStatusMessage(
            status,
            finishedWithErrorsMessageText(result, "From now on, **every normal message in this thread edits this same site**."),
          );
          await sendOutcomeFollowUp(thread, result, {
            operation: "initial-site-build",
            guildId: interaction.guildId,
            requesterId: interaction.user.id,
          });
        } else {
          await setStatusMessage(
            status,
            successMessageText(result, false, "From now on, **every normal message in this thread edits this same site**."),
          );
        }
      } catch (error) {
        progress.close();
        const project = store.getProject(thread.id);
        const incident = await reportFailure(error, {
          operation: "initial-site-build",
          guildId: interaction.guildId,
          threadId: thread.id,
          requesterId: interaction.user.id,
          project,
          model: store.getModel() || "the model default",
        });
        const retry = project
          ? "Reply in this thread to retry after the configuration/provider issue is fixed."
          : "Run `/site start` again inside this thread after the setup issue is fixed.";
        await setStatusMessage(
          status,
          `❌ Initial generation failed · reference \`${incident.id}\`. ${retry}`,
          (await offerEditsChoice(project, error)) ? [failureEditsRow()] : undefined,
        );
      }
    }).catch((error) => logError("project.queue_failed", error, { threadId: thread.id }));
    return;
  }

  if (!interaction.channel?.isThread()) throw new Error(`/${interaction.commandName} ${sub} must be used inside a site thread.`);
  const project = store.getProject(interaction.channel.id);
  if (!project) throw new Error("This thread has no site. Use /site start first.");

  if (sub === "info") {
    const usage = await usageLog.threadTotal(project.threadId);
    await interaction.reply({
      content:
        `**${project.displayName}** — ${project.status}\n` +
        `[open site](${projects.siteLink(project)}) · [source](${projects.repoLink(project)})\n` +
        `Type: ${projectKindLabel(project.projectKind)}\n` +
        `Model: \`${store.getModel() || "the model default"}\` · Effort: \`${store.getEffort() || "auto"}\`\n` +
        threadUsageText(usage, isAdmin(interaction)) +
        (project.lastError && config.errorReportUserIds.has(interaction.user.id) ? `\nLast private error summary: ${truncate(project.lastError, 900)}` : ""),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "republish") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const updated = await projects.enqueue(project.threadId, () => projects.republish(project.threadId));
    await interaction.editReply(`Republished [${updated.displayName}](${projects.siteLink(updated)}) without calling the model.`);
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

  if (sub === "reset") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await projects.enqueue(project.threadId, () => projects.resetSession(project.threadId));
    await interaction.editReply(
      "🔄 Agent session dropped. The next message in this thread starts a fresh conversation — " +
      "the site, git history, and project notes are all kept.",
    );
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
    return;
  }
}

async function handleMakeGameCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) throw new Error("Games can only be created in a server.");

  const dimension = interaction.options.getString("dimension", true);
  const projectKind: ProjectKind = dimension === "3d" ? "game-3d" : "game-2d";
  const prompt = interaction.options.getString("prompt", true).trim();
  const requestedName = interaction.options.getString("name")?.trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { thread, created } = await resolveOrCreateThread(interaction, requestedName || prompt, "game");
  if (store.getProject(thread.id)) throw new Error("That thread already has a project. Use a fresh thread for /makegam, then reply normally to mutate the game.");
  const status = await thread.send(`🎮 Preparing a persistent **${dimension.toUpperCase()} static web game**…`);
  const progress = new DiscordProgress(status, `🎮 Building ${requestedName || thread.name}`);
  registerQuestionButtons(status, progress);
  progress.update(`🕹️ ${dimension.toUpperCase()} game profile selected`);

  await interaction.editReply(`Created/attached <#${thread.id}>. The thread will show live research/edit/publish stages; detailed failures stay private.`);
  projects.enqueue(thread.id, async () => {
    try {
      const result = await projects.createProject({
        threadId: thread.id,
        guildId: interaction.guildId!,
        parentChannelId: thread.parentId || interaction.channelId,
        displayName: requestedName || thread.name,
        initialPrompt: prompt,
        projectKind,
        renameable: created && !requestedName,
        initiator: interactionInitiator(interaction),
        statusMessageId: status.id,
      }, progress.callback, created && !requestedName
        ? (title) => applyAiThreadTitle(thread, title)
        : undefined);
      progress.close();
        if (result.validationError || result.deliveryError || (!result.commit && !result.noChanges)) {
          await setStatusMessage(status, finishedWithErrorsMessageText(result));
        await sendOutcomeFollowUp(thread, result, {
          operation: `initial-${dimension}-game-build`,
          guildId: interaction.guildId,
          requesterId: interaction.user.id,
        });
      } else {
        await setStatusMessage(status, successMessageText(result, true));
      }
    } catch (error) {
      progress.close();
      const project = store.getProject(thread.id);
      const incident = await reportFailure(error, {
        operation: `initial-${dimension}-game-build`,
        guildId: interaction.guildId,
        threadId: thread.id,
        requesterId: interaction.user.id,
        project,
        model: store.getModel() || "the model default",
      });
      const retry = project
        ? "Reply in this thread to retry after the configuration/provider issue is fixed."
        : "Run `/makegam` again inside this thread after the setup issue is fixed.";
      await setStatusMessage(
        status,
        `❌ Initial game generation failed · reference \`${incident.id}\`. ${retry}`,
        (await offerEditsChoice(project, error)) ? [failureEditsRow()] : undefined,
      );
    }
  }).catch((error) => logError("project.queue_failed", error, { threadId: thread.id }));
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

  if (sub === "model") {
    const raw = interaction.options.getString("model", true).trim();
    const model = /^default$/i.test(raw) ? undefined : raw;
    if (model && !/^[^/\s]+\/.+/.test(model)) throw new Error("Model must use provider/model-id format.");
    await store.setModel(model);
    log("info", "admin.model_changed", { userId: interaction.user.id, model: model || "default" });
    await interaction.editReply(`Future turns will use \`${model || "the model default"}\`. Existing thread sessions switch on their next message too.`);
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
  const noteLine = note ? `\n${note}\n` : "\n";
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
  return `-# ⏱️ ${formatElapsed(result.durationMs)}${usage ? ` · 🧠 ${usage}` : ""}`;
}

/**
 * Follow-up thread message with the errors behind a finished-but-unshipped
 * turn: validation errors verbatim, and — for commit/publish pipeline
 * failures, which are operational — an incident reference for the private
 * error report. Best-effort delivery; the outcome message already went out.
 */
async function sendOutcomeFollowUp(
  channel: { send: (options: { content: string }) => Promise<unknown> } | undefined,
  result: MutationResult,
  context: { operation: string; guildId?: string | null; requesterId?: string },
): Promise<void> {
  if (!channel) return;
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
  const models = [...total.models.values()]
    .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))
    .slice(0, 3)
    .map((model) => `\`${model.model}\` (${model.turns})`);
  const more = total.models.size - models.length;
  return `Usage: ${total.turns} model turns${failed} · in ${formatTokens(total.inputTokens)}${cached} · out ${formatTokens(total.outputTokens)} tok${cost}\n`
    + `Models: ${models.join(" · ")}${more > 0 ? ` · +${more} more` : ""}`;
}

function isAdmin(interaction: ChatInputCommandInteraction): boolean {
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

// Thread titles Discord displays come from the AI after the first successful build,
// but only when ThreadSite itself created the thread from a prompt slug.
async function applyAiThreadTitle(thread: ThreadChannel, title: string): Promise<void> {
  await thread.setName(truncate(title, 100));
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
  unregisterQuestionButtons(status.id);
  const payload = { content: truncate(content, MAX_DISCORD_MESSAGE_CHARS), ...(components ? { components } : {}) };
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

async function handleFailureButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.channel?.isThread()) {
    throw new Error("This button only works inside a project thread.");
  }
  const action = interaction.customId === "threadsite:rollback" ? "rollback" : "keep";
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
  const notified = await adminReporter.notify(incident);
  return { id: incident.id, notified };
}
