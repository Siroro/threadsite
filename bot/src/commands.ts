import {
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

export const siteCommand = new SlashCommandBuilder()
  .setName("site")
  .setDescription("Create and manage a persistent website for a Discord thread")
  .addSubcommand((sub) => sub
    .setName("start")
    .setDescription("Create a site in this thread, or create a new thread here")
    .addStringOption((option) => option
      .setName("prompt")
      .setDescription("What should the site be?")
      .setRequired(true)
      .setMaxLength(6000))
    .addStringOption((option) => option
      .setName("name")
      .setDescription("Optional site/thread name")
      .setMaxLength(80)))
  .addSubcommand((sub) => sub
    .setName("info")
    .setDescription("Show the live site and source repository for this thread"))
  .addSubcommand((sub) => sub
    .setName("republish")
    .setDescription("Republish the current checked-in static files without asking the model"))
  .addSubcommand((sub) => sub
    .setName("compact")
    .setDescription("Compact this thread's agent session context now"))
  .addSubcommand((sub) => sub
    .setName("reset")
    .setDescription("Drop this thread's agent session and start fresh on the next message (site and history are kept)"))
  .addSubcommand((sub) => sub
    .setName("revert")
    .setDescription("Undo the last accepted turn: reset git, force-push, and republish the previous version"));

export const makeGameCommand = new SlashCommandBuilder()
  .setName("makegam")
  .setDescription("Create a persistent static web game in a Discord thread")
  .addStringOption((option) => option
    .setName("dimension")
    .setDescription("Game rendering/play-space style")
    .setRequired(true)
    .addChoices(
      { name: "2D", value: "2d" },
      { name: "3D", value: "3d" },
    ))
  .addStringOption((option) => option
    .setName("prompt")
    .setDescription("What game should be made?")
    .setRequired(true)
    .setMaxLength(6000))
  .addStringOption((option) => option
    .setName("name")
    .setDescription("Optional game/thread name")
    .setMaxLength(80));

export const adminCommand = new SlashCommandBuilder()
  .setName("site-admin")
  .setDescription("Admin settings for the ThreadSite bot")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) => sub
    .setName("status")
    .setDescription("Show the active model and agent status"))
  .addSubcommand((sub) => sub
    .setName("usage")
    .setDescription("Show daily token usage, cost, and which models were used")
    .addIntegerOption((option) => option
      .setName("days")
      .setDescription("How many days back to include, today included (default 7, max 30)")
      .setMinValue(1)
      .setMaxValue(30)))
  .addSubcommand((sub) => sub
    .setName("model")
    .setDescription("Change the model used on every future Discord mutation")
    .addStringOption((option) => option
      .setName("model")
      .setDescription("provider/model-id, or 'default' to let the default apply")
      .setRequired(true)
      .setMaxLength(200)))
  .addSubcommand((sub) => sub
    .setName("effort")
    .setDescription("Change the reasoning effort (model variant) used on every future Discord mutation")
    .addStringOption((option) => option
      .setName("level")
      .setDescription("Availability depends on the active model/provider; 'auto' uses the model default")
      .setRequired(true)
      .addChoices(
        { name: "auto (model default)", value: "auto" },
        { name: "minimal", value: "minimal" },
        { name: "low", value: "low" },
        { name: "medium", value: "medium" },
        { name: "high", value: "high" },
        { name: "xhigh", value: "xhigh" },
        { name: "max (Anthropic)", value: "max" },
      )))
  .addSubcommand((sub) => sub
    .setName("token")
    .setDescription("Store/replace a provider API token (ephemeral reply)")
    .addStringOption((option) => option
      .setName("provider")
      .setDescription("Provider ID, e.g. anthropic, openai, openrouter, surplus")
      .setRequired(true)
      .setMaxLength(80))
    .addStringOption((option) => option
      .setName("token")
      .setDescription("Provider API token")
      .setRequired(true)
      .setMaxLength(2000)))
  .addSubcommand((sub) => sub
    .setName("token-clear")
    .setDescription("Remove a stored provider API token")
    .addStringOption((option) => option
      .setName("provider")
      .setDescription("Provider ID")
      .setRequired(true)
      .setMaxLength(80)))
  .addSubcommand((sub) => sub
    .setName("errors")
    .setDescription("Privately show recent ThreadSite failure incidents")
    .addIntegerOption((option) => option
      .setName("limit")
      .setDescription("How many incidents to show (default 5)")
      .setMinValue(1)
      .setMaxValue(10)));

export const commandJson = [siteCommand.toJSON(), makeGameCommand.toJSON(), adminCommand.toJSON()];
