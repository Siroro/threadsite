import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type ThreadChannel,
} from "discord.js";
import { AdminReporter } from "./admin-reporter.js";
import { commandJson } from "./commands.js";
import { config } from "./config.js";
import { ForgejoClient } from "./forgejo.js";
import { getLogFile, log, logError, recentIncidents, recordIncident } from "./logger.js";
import { multiplayerRelayStatus } from "./multiplayer.js";
import { OpenCodeHarness } from "./opencode.js";
import { DiscordProgress } from "./progress.js";
import { ProjectService } from "./project.js";
import { Store } from "./store.js";
import { projectKindLabel } from "./templates.js";
import type { ProjectKind, ProjectRecord } from "./types.js";
import { commitAuthorIdentity, errorText, slugify, stripSummaryPreamble, truncate } from "./util.js";

const store = await Store.open(config.stateFile, config.defaultModel);
const opencode = new OpenCodeHarness();
const forgejo = new ForgejoClient();
const projects = new ProjectService(store, opencode, forgejo);

await registerCommands();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
const adminReporter = new AdminReporter(client);

client.once(Events.ClientReady, (ready) => {
  log("info", "discord.ready", {
    user: ready.user.tag,
    version: "2.3.0",
    projects: store.listProjects().length,
    model: store.getModel() || "the model default",
    multiplayer: config.multiplayerEnabled ? config.gameserverPublicUrl : "disabled",
    errorRecipients: config.errorReportUserIds.size,
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    try {
      await handleFailureButton(interaction);
    } catch (error) {
      logError("discord.button_failed", error, {
        customId: interaction.customId,
        userId: interaction.user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
      });
      const text = `❌ ${truncate(errorText(error), 1800)}`;
      if (interaction.deferred || interaction.replied) await interaction.editReply(text).catch(() => undefined);
      else await interaction.reply({ content: text, ephemeral: true }).catch(() => undefined);
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
    else await interaction.reply({ content: text, ephemeral: true }).catch(() => undefined);
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
      );
      progress.close();
      const summary = agentSummaryText(result.agentSummary);
      await status.edit(
        `✅ **${result.project.displayName}** · commit \`${result.commit}\` · ${result.commitFiles} file${result.commitFiles === 1 ? "" : "s"} changed (+${result.additions}/−${result.deletions})${summary}\n` +
        `\n# [${isGame ? "PLAY GAME" : "OPEN SITE"}](${projects.siteLink(result.project)})\n[git](${projects.repoLink(result.project)})`,
      );
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
      await status.edit({
        content: `❌ Update failed · reference \`${incident.id}\`. The previous published version is unchanged.`,
        ...(await offerEditsChoice(project, error) ? { components: [failureEditsRow()] } : {}),
      });
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
    await interaction.deferReply({ ephemeral: true });

    const { thread, created } = await resolveOrCreateThread(interaction, requestedName || prompt);
    if (store.getProject(thread.id)) throw new Error("That thread already has a site. Just reply in the thread to mutate it.");
    const status = await thread.send("🛠️ Preparing this thread's persistent site…");
    const progress = new DiscordProgress(status, `🛠️ Building ${requestedName || thread.name}`);
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
        }, progress.callback, created && !requestedName
          ? (title) => applyAiThreadTitle(thread, title)
          : undefined);
        progress.close();
        const summary = agentSummaryText(result.agentSummary);
        await status.edit(
          `✅ **${result.project.displayName}** · commit \`${result.commit}\` · ${result.commitFiles} file${result.commitFiles === 1 ? "" : "s"} changed (+${result.additions}/−${result.deletions})${summary}\n` +
          `\nFrom now on, **every normal message in this thread edits this same site**.\n` +
          `# [OPEN SITE](${projects.siteLink(result.project)})\n[git](${projects.repoLink(result.project)})`,
        );
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
        await status.edit({
          content: `❌ Initial generation failed · reference \`${incident.id}\`. ${retry}`,
          ...(await offerEditsChoice(project, error) ? { components: [failureEditsRow()] } : {}),
        });
      }
    }).catch((error) => logError("project.queue_failed", error, { threadId: thread.id }));
    return;
  }

  if (!interaction.channel?.isThread()) throw new Error(`/${interaction.commandName} ${sub} must be used inside a site thread.`);
  const project = store.getProject(interaction.channel.id);
  if (!project) throw new Error("This thread has no site. Use /site start first.");

  if (sub === "info") {
    await interaction.reply({
      content:
        `**${project.displayName}** — ${project.status}\n` +
        `[open site](${projects.siteLink(project)}) · [source](${projects.repoLink(project)})\n` +
        `Type: ${projectKindLabel(project.projectKind)}\n` +
        `Model: \`${store.getModel() || "the model default"}\`` +
        (project.lastError && config.errorReportUserIds.has(interaction.user.id) ? `\nLast private error summary: ${truncate(project.lastError, 900)}` : ""),
      ephemeral: true,
    });
    return;
  }

  if (sub === "republish") {
    await interaction.deferReply({ ephemeral: true });
    const updated = await projects.enqueue(project.threadId, () => projects.republish(project.threadId));
    await interaction.editReply(`Republished [${updated.displayName}](${projects.siteLink(updated)}) without calling the model.`);
    return;
  }

  if (sub === "compact") {
    await interaction.deferReply({ ephemeral: true });
    const result = await projects.enqueue(project.threadId, () => projects.compact(project.threadId));
    await interaction.editReply(
      `🧠 Compaction started with \`${result.model}\`. Older session context is being summarized; ` +
      "this thread keeps working normally afterwards. The site itself is unchanged.",
    );
    return;
  }

  if (sub === "reset") {
    await interaction.deferReply({ ephemeral: true });
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
  await interaction.deferReply({ ephemeral: true });

  const { thread, created } = await resolveOrCreateThread(interaction, requestedName || prompt, "game");
  if (store.getProject(thread.id)) throw new Error("That thread already has a project. Use a fresh thread for /makegam, then reply normally to mutate the game.");
  const status = await thread.send(`🎮 Preparing a persistent **${dimension.toUpperCase()} static web game**…`);
  const progress = new DiscordProgress(status, `🎮 Building ${requestedName || thread.name}`);
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
      }, progress.callback, created && !requestedName
        ? (title) => applyAiThreadTitle(thread, title)
        : undefined);
      progress.close();
      const summary = agentSummaryText(result.agentSummary);
      await status.edit(
        `✅ **${result.project.displayName}** · commit \`${result.commit}\` · ${result.commitFiles} file${result.commitFiles === 1 ? "" : "s"} changed (+${result.additions}/−${result.deletions})${summary}\n` +
        `\n# [PLAY GAME](${projects.siteLink(result.project)})\n[git](${projects.repoLink(result.project)})`,
      );
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
      await status.edit({
        content: `❌ Initial game generation failed · reference \`${incident.id}\`. ${retry}`,
        ...(await offerEditsChoice(project, error) ? { components: [failureEditsRow()] } : {}),
      });
    }
  }).catch((error) => logError("project.queue_failed", error, { threadId: thread.id }));
}

async function handleAdminCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) throw new Error("Admin commands can only be used in a server.");
  if (!isAdmin(interaction)) throw new Error("You need Manage Server (or an allowlisted admin user ID) to use this command.");
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  if (sub === "status") {
    await interaction.editReply(
      `Model: \`${store.getModel() || "the model default"}\`\n` +
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

  if (sub === "model") {
    const raw = interaction.options.getString("model", true).trim();
    const model = /^default$/i.test(raw) ? undefined : raw;
    if (model && !/^[^/\s]+\/.+/.test(model)) throw new Error("Model must use provider/model-id format.");
    await store.setModel(model);
    log("info", "admin.model_changed", { userId: interaction.user.id, model: model || "default" });
    await interaction.editReply(`Future turns will use \`${model || "the model default"}\`. Existing thread sessions switch on their next message too.`);
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

// Final-message summary block: agent text minus the meta opener ("Implemented a
// complete 3D browser game in site/…"), ready to paste under the status line.
function agentSummaryText(raw: string | undefined): string {
  const stripped = raw ? stripSummaryPreamble(raw) : "";
  return stripped ? `\n${truncate(stripped, 1600)}` : "";
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
  await interaction.deferReply({ ephemeral: true });
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
