import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ChannelType, REST, Routes } from "discord.js";
import { config } from "./config.js";
import { ForgejoClient } from "./forgejo.js";
import { OpenCodeHarness } from "./opencode.js";
import { publishIndex } from "./publish.js";
import { Store } from "./store.js";
import type { ProjectRecord } from "./types.js";
import { removalPaths } from "./project-removal.js";
import { assertExclusiveResources } from "./project-removal.js";
import { UsageLog } from "./usage.js";
import { ProjectService } from "./project.js";
import { applyPurge, planPurge, type PurgePlan, type PurgeServices } from "./purge.js";
import { deleteRelayGame, listRelayGames } from "./relay-cleanup.js";
import { errorText } from "./util.js";
export { checkedRemovalPath, removalPaths } from "./project-removal.js";

export interface Selection { threads: string[]; repos: string[]; games: string[] }

export function selectProjects(projects: ProjectRecord[], selection: Selection): ProjectRecord[] {
  const selected = new Set<string>();
  const selectors = [
    ...selection.threads.map((value) => ({ value, match: (project: ProjectRecord) => project.threadId === value })),
    ...selection.repos.map((value) => ({ value, match: (project: ProjectRecord) => project.repoName === value })),
    ...selection.games.map((value) => ({ value, match: (project: ProjectRecord) => project.projectKind?.startsWith("game-") && [project.displayName, project.siteSlug].includes(value) })),
  ];
  if (!selectors.length) throw new Error("Select a project with --thread ID, --repo NAME or --game NAME. Names must match exactly.");
  for (const selector of selectors) {
    const matches = projects.filter(selector.match);
    if (matches.length !== 1) throw new Error(`${selector.value}: found ${matches.length} projects; use an exact thread ID to disambiguate.`);
    selected.add(matches[0].threadId);
  }
  return projects.filter((project) => selected.has(project.threadId));
}

export function assertIdle(project: ProjectRecord): void {
  if (project.pendingTurn || project.pendingQueue?.length || project.pendingRename || project.pendingThreadName) {
    throw new Error(`${project.repoName} has pending work. Use /site stop, clear /site queue, or finish recovery before removing it.`);
  }
}

export async function backupDatabase(file: string): Promise<string> {
  const destination = `${file}.before-cleanup-${randomUUID()}.db`;
  const handle = await fs.open(destination, "wx", 0o600);
  await handle.close();
  const source = new DatabaseSync(file, { readOnly: true });
  try { await backup(source, destination); } finally { source.close(); }
  return destination;
}

export async function removeDiscordThread(project: ProjectRecord, rest = new REST({ version: "10" }).setToken(config.discordToken)): Promise<void> {
  let channel: { type: number; guild_id?: string };
  try { channel = await rest.get(Routes.channel(project.threadId)) as typeof channel; }
  catch (error) { if ((error as { code?: number }).code === 10003) return; throw error; }
  if (![ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(channel.type)
    || channel.guild_id !== project.guildId) throw new Error("The selected Discord channel is not this project's thread; refusing deletion.");
  try { await rest.delete(Routes.channel(project.threadId), { reason: "ThreadSite project cleanup" }); }
  catch (error) { if ((error as { code?: number }).code !== 10003) throw error; }
}

interface RemovalServices {
  busy(project: ProjectRecord): Promise<boolean>;
  deleteRepository(name: string): Promise<void>;
  deleteThread(project: ProjectRecord): Promise<void>;
  removeProject?(project: ProjectRecord): Promise<void>;
}

/** Keep the registration on any failure so the exact same selection can be retried. */
export async function removeProjects(store: Store, selected: ProjectRecord[], mode: "remove" | "forget", services: RemovalServices, options: { backup?: boolean } = {}): Promise<void> {
  const all = store.listProjects();
  // Preflight the whole selection before the first external deletion.
  for (const project of selected) {
    if (!project.pendingDeletion || mode === "forget") assertIdle(project);
    if ((!project.pendingDeletion || mode === "forget") && store.listApprovals(project.threadId).length) {
      throw new Error(`${project.repoName} has requests awaiting owner approval; approve or reject them before cleanup.`);
    }
    if (JSON.stringify(store.getProject(project.threadId)) !== JSON.stringify(project)) throw new Error("A selected record changed. Stop the bot and retry.");
    if (mode === "remove") {
      await removalPaths(project);
      assertExclusiveResources(project, all);
      for (const other of all.filter((item) => item.threadId !== project.threadId)) {
        if (other.repoName === project.repoName || [other.siteSlug, ...(other.siteAliases ?? []), other.pendingRename?.siteSlug]
          .some((slug) => slug && [project.siteSlug, ...(project.siteAliases ?? [])].includes(slug))) {
          throw new Error(`Another project shares resources with ${project.threadId}; refusing removal.`);
        }
      }
    }
    // The agent can still be running after the bot container stops.
    if (!project.pendingDeletion && await services.busy(project)) throw new Error(`${project.repoName} still has an active agent turn; stop it before cleanup.`);
  }
  if (!selected.length) return;
  if (options.backup) console.log(`SQLite backup: ${await backupDatabase(store.file)}`);
  for (const project of selected) {
    if (mode === "remove") {
      if (services.removeProject) {
        await services.deleteThread(project);
        await services.removeProject(project);
      } else {
        await services.deleteRepository(project.repoName);
        await services.deleteThread(project);
        // Recheck immediately before deleting local files.
        for (const target of await removalPaths(project)) await fs.rm(target, { recursive: true, force: true, maxRetries: 3 });
      }
    }
    await store.deleteProject(project.threadId);
    console.log(`${mode === "remove" ? "Removed project" : "Forgot registration"}: ${project.threadId} · ${project.displayName}`);
  }
}

function printPurgePlan(plan: PurgePlan): void {
  const section = (label: string, values: string[]) => {
    console.log(`\n${label}: ${values.length}`);
    for (const value of values) console.log(`  ${value}`);
  };
  section("Missing Discord threads (full teardown)", plan.missingThreads.map((project) =>
    `${project.threadId} · ${project.displayName} · ${project.repoName}`));
  section("Orphaned workspaces", plan.workspaces.map((workspace) => workspace.directory));
  section("Orphaned Forgejo repositories", plan.repositories.map((repo) => `${repo.name} (${repo.id})`));
  section("Orphaned published folders", plan.published);
  section("Orphaned push accounts", plan.accounts);
  section("Orphaned relay worlds", plan.games);
  section("Orphaned usage records", plan.usageThreads);
  if (plan.warnings.length) {
    section("Warnings (resources retained)", plan.warnings);
  }
  if (!plan.missingThreads.length && !plan.workspaces.length && !plan.repositories.length && !plan.published.length
    && !plan.accounts.length && !plan.games.length && !plan.usageThreads.length) console.log("\nNothing to purge.");
}

async function purge(store: Store, forgejo: ForgejoClient, agent: OpenCodeHarness, projects: ProjectService,
  usage: UsageLog, apply: boolean, backup: boolean): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const services: PurgeServices = {
    thread: async (threadId) => await rest.get(Routes.channel(threadId)) as { guild_id?: string; type: number },
    repositories: () => forgejo.listOwnedRepositories(),
    managedRepository: (repo) => forgejo.isManagedRepository(repo),
    repository: (name) => forgejo.repositoryInfo(name),
    sessions: () => agent.workspaceSessions(),
    accounts: () => forgejo.listManagedPushAccounts(),
    games: () => listRelayGames(),
    usageThreads: () => usage.threadIds(),
    removeProject: (threadId) => projects.forceDeleteProject(threadId, "maintenance-purge"),
    removeSessions: (directory, knownId) => agent.deleteSessionsInDirectory(directory, knownId),
    removeRepository: (name) => forgejo.deleteRepository(name),
    removeAccount: (name) => forgejo.deletePushAccount(name),
    removeGame: (game) => deleteRelayGame(game),
    forgetUsage: (threadId) => usage.forgetThread(threadId),
    refreshIndex: async () => { await publishIndex(store.listProjects(), (name) => forgejo.repoWebUrl(name)); },
  };
  const plan = await planPurge(store, services);
  printPurgePlan(plan);
  if (!apply) {
    console.log("\nPreview only. Add --apply to proceed. The bot must be stopped during cleanup.");
    return;
  }
  // Purge has no selection to review afterward, so an explicit --backup is the
  // only chance to keep the registrations it is about to delete.
  if (backup && plan.missingThreads.length) console.log(`SQLite backup: ${await backupDatabase(store.file)}`);
  await applyPurge(store, plan, services);
  console.log("Purge complete.");
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args.shift() ?? "list";
  if (!["list", "remove", "forget", "purge"].includes(command)) throw new Error(`Unknown maintenance command: ${command}`);
  const selection: Selection = { threads: [], repos: [], games: [] };
  let apply = false;
  let backup = false;
  let tsv = false;
  let kind = "all";
  while (args.length) {
    const option = args.shift();
    if (option === "--apply") apply = true;
    else if (option === "--backup") backup = true;
    else if (option === "--tsv") tsv = true;
    else if (["--thread", "--repo", "--game", "--kind"].includes(option ?? "")) {
      const value = args.shift();
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
      if (option === "--kind") kind = value;
      else selection[option === "--thread" ? "threads" : option === "--repo" ? "repos" : "games"].push(value);
    } else throw new Error(`Unknown option: ${option}`);
  }
  if (!["all", "games", "sites"].includes(kind)) throw new Error("--kind must be all, games or sites");
  if (command === "list" && apply) throw new Error("--apply is only valid with remove, forget or purge.");
  if (command === "purge" && (selection.threads.length || selection.repos.length || selection.games.length || kind !== "all" || tsv)) {
    throw new Error("purge inventories every orphaned resource; it takes only --apply and --backup.");
  }
  await fs.access(config.stateDbFile);
  const store = await Store.open(config.stateDbFile);
  try {
    const forgejo = new ForgejoClient();
    const agent = new OpenCodeHarness();
    const usage = new UsageLog(config.usageLogFile);
    if (command === "purge") {
      await purge(store, forgejo, agent, new ProjectService(store, agent, forgejo, usage), usage, apply, backup);
      return;
    }
    const all = store.listProjects();
    const filtered = all.filter((project) => kind === "all" || (kind === "games" ? project.projectKind?.startsWith("game-") : !project.projectKind?.startsWith("game-")));
    const selected = command === "list" ? filtered : selectProjects(filtered, selection);
    for (const project of selected) {
      const values = [project.threadId, project.projectKind ?? "site", project.pendingDeletion ? "deleting" : project.status, project.displayName, project.repoName];
      const clean = values.map((value) => value.replace(/[\t\r\n\u001b]/g, " "));
      console.log(tsv ? clean.join("\t") : `${clean[0]} · ${clean[1]} · ${clean[2]} · ${clean[3]}\n  Repo: ${clean[4]}`);
      if (command !== "list") {
        console.log(command === "forget" ? "  Remove: SQLite registration only" : `  Remove: Discord thread, Forgejo repository, workspace and published site/aliases\n  Paths: ${(await removalPaths(project)).join(", ")}`);
      }
    }
    if (command === "list") { if (!selected.length && !tsv) console.log("No registered projects match."); return; }
    if (!apply) { console.log("Preview only. Add --apply to proceed. The bot must be stopped during cleanup."); return; }
    const projects = new ProjectService(store, agent, forgejo, usage);
    await removeProjects(store, selected, command as "remove" | "forget", {
      busy: (project) => agent.isBusy(project.workspacePath, project.sessionId),
      deleteRepository: (name) => forgejo.deleteRepository(name),
      deleteThread: removeDiscordThread,
      removeProject: (project) => projects.forceDeleteProject(project.threadId, "maintenance-remove"),
    }, { backup });
    if (command === "remove") await publishIndex(store.listProjects(), (name) => forgejo.repoWebUrl(name));
  } finally { store.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => { console.error(errorText(error)); process.exitCode = 1; });
}
