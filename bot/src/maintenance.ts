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

/** Validate every ancestor before recursive removal; never follow a link outside a configured root. */
export async function checkedRemovalPath(root: string, target: string): Promise<string> {
  const base = path.resolve(root);
  const absolute = path.resolve(target);
  const relative = path.relative(base, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing removal outside the configured root: ${absolute}`);
  }
  let current = base;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error(`Refusing removal through a symlink: ${current}`);
  }
  return absolute;
}

export async function removalPaths(project: ProjectRecord): Promise<string[]> {
  if (!/^\d+$/.test(project.guildId) || !/^\d+$/.test(project.threadId)) throw new Error("Invalid project guild/thread identity.");
  const expected = path.resolve(config.workspaceRoot, project.guildId, project.threadId);
  if (path.resolve(project.workspacePath) !== expected) throw new Error(`Unexpected workspace path for ${project.threadId}: ${project.workspacePath}`);
  const paths = [await checkedRemovalPath(config.workspaceRoot, expected)];
  for (const slug of new Set([project.siteSlug, ...(project.siteAliases ?? [])])) {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) throw new Error(`Invalid site slug: ${slug}`);
    paths.push(await checkedRemovalPath(config.publishRoot, path.join(config.publishRoot, slug)));
  }
  return paths;
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
}

/** Keep the registration on any failure so the exact same selection can be retried. */
export async function removeProjects(store: Store, selected: ProjectRecord[], mode: "remove" | "forget", services: RemovalServices): Promise<void> {
  const all = store.listProjects();
  // Preflight the whole selection before the first external deletion.
  for (const project of selected) {
    assertIdle(project);
    if (JSON.stringify(store.getProject(project.threadId)) !== JSON.stringify(project)) throw new Error("A selected record changed. Stop the bot and retry.");
    if (mode === "remove") {
      await removalPaths(project);
      for (const other of all.filter((item) => item.threadId !== project.threadId)) {
        if (other.repoName === project.repoName || [other.siteSlug, ...(other.siteAliases ?? []), other.pendingRename?.siteSlug]
          .some((slug) => slug && [project.siteSlug, ...(project.siteAliases ?? [])].includes(slug))) {
          throw new Error(`Another project shares resources with ${project.threadId}; refusing removal.`);
        }
      }
    }
    // The agent can still be running after the bot container stops.
    if (await services.busy(project)) throw new Error(`${project.repoName} still has an active agent turn; stop it before cleanup.`);
  }
  if (!selected.length) return;
  console.log(`SQLite backup: ${await backupDatabase(store.file)}`);
  for (const project of selected) {
    if (mode === "remove") {
      await services.deleteRepository(project.repoName);
      await services.deleteThread(project);
      // Recheck immediately before deleting local files.
      for (const target of await removalPaths(project)) await fs.rm(target, { recursive: true, force: true, maxRetries: 3 });
    }
    await store.deleteProject(project.threadId);
    console.log(`${mode === "remove" ? "Removed project" : "Forgot registration"}: ${project.threadId} · ${project.displayName}`);
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args.shift() ?? "list";
  if (!["list", "remove", "forget"].includes(command)) throw new Error(`Unknown maintenance command: ${command}`);
  const selection: Selection = { threads: [], repos: [], games: [] };
  let apply = false;
  let tsv = false;
  let kind = "all";
  while (args.length) {
    const option = args.shift();
    if (option === "--apply") apply = true;
    else if (option === "--tsv") tsv = true;
    else if (["--thread", "--repo", "--game", "--kind"].includes(option ?? "")) {
      const value = args.shift();
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
      if (option === "--kind") kind = value;
      else selection[option === "--thread" ? "threads" : option === "--repo" ? "repos" : "games"].push(value);
    } else throw new Error(`Unknown option: ${option}`);
  }
  if (!["all", "games", "sites"].includes(kind)) throw new Error("--kind must be all, games or sites");
  if (command === "list" && apply) throw new Error("--apply is only valid with remove or forget.");
  await fs.access(config.stateDbFile);
  const store = await Store.open(config.stateDbFile);
  try {
    const all = store.listProjects();
    const filtered = all.filter((project) => kind === "all" || (kind === "games" ? project.projectKind?.startsWith("game-") : !project.projectKind?.startsWith("game-")));
    const selected = command === "list" ? filtered : selectProjects(filtered, selection);
    for (const project of selected) {
      const values = [project.threadId, project.projectKind ?? "site", project.status, project.displayName, project.repoName];
      const clean = values.map((value) => value.replace(/[\t\r\n\u001b]/g, " "));
      console.log(tsv ? clean.join("\t") : `${clean[0]} · ${clean[1]} · ${clean[2]} · ${clean[3]}\n  Repo: ${clean[4]}`);
      if (command !== "list") {
        console.log(command === "forget" ? "  Remove: SQLite registration only" : `  Remove: Discord thread, Forgejo repository, workspace and published site/aliases\n  Paths: ${(await removalPaths(project)).join(", ")}`);
      }
    }
    if (command === "list") { if (!selected.length && !tsv) console.log("No registered projects match."); return; }
    if (!apply) { console.log("Preview only. Add --apply to proceed. The bot must be stopped during cleanup."); return; }
    const forgejo = new ForgejoClient();
    const agent = new OpenCodeHarness();
    await removeProjects(store, selected, command as "remove" | "forget", {
      busy: (project) => agent.isBusy(project.workspacePath, project.sessionId),
      deleteRepository: (name) => forgejo.deleteRepository(name),
      deleteThread: removeDiscordThread,
    });
    if (command === "remove") await publishIndex(store.listProjects(), (name) => forgejo.repoWebUrl(name));
  } finally { store.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
