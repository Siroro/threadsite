import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { Store } from "./store.js";
import type { ProjectRecord } from "./types.js";
import { checkedRemovalPath, projectAccounts, projectRepos, projectSlugs, removalPaths } from "./project-removal.js";

export interface PurgeServices {
  thread(threadId: string): Promise<{ guild_id?: string; type: number }>;
  repositories(): Promise<Array<{ id: number; name: string; description?: string }>>;
  managedRepository(repo: { name: string; description?: string }): Promise<boolean>;
  repository(name: string): Promise<{ id: number; name: string } | undefined>;
  sessions(): Promise<Array<{ id: string; directory: string }>>;
  accounts(): Promise<string[]>;
  games(): Promise<string[]>;
  usageThreads(): Promise<string[]>;
  removeProject(threadId: string): Promise<void>;
  removeSessions(directory: string, knownId: string): Promise<void>;
  removeRepository(name: string): Promise<void>;
  removeAccount(name: string): Promise<void>;
  removeGame(gameId: string): Promise<void>;
  forgetUsage(threadId: string): Promise<void>;
  refreshIndex(): Promise<void>;
}

export interface PurgePlan {
  missingThreads: ProjectRecord[];
  workspaces: Array<{ directory: string; threadId: string; sessionIds: string[] }>;
  repositories: Array<{ id: number; name: string }>;
  published: string[];
  accounts: string[];
  games: string[];
  usageThreads: string[];
  warnings: string[];
}

async function entries(root: string) {
  return fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []; throw error;
  });
}

function workspaceIdentity(directory: string): { directory: string; threadId: string } | undefined {
  const relative = path.relative(path.resolve(config.workspaceRoot), path.resolve(directory));
  const parts = relative.split(path.sep);
  if (parts.length < 2 || !/^\d+$/.test(parts[0]!) || !/^\d+$/.test(parts[1]!)) return undefined;
  return { directory: path.join(config.workspaceRoot, parts[0]!, parts[1]!), threadId: parts[1]! };
}

function gameIds(projects: ProjectRecord[]): Set<string> {
  return new Set(projects.flatMap((project) => project.multiplayerGameId ? [project.multiplayerGameId]
    : project.projectKind?.startsWith("game-") && project.multiplayerMode !== "singleplayer" ? [project.siteSlug] : []));
}

/** Inventory is read-only. A failed lookup never turns a registered resource into an orphan. */
export async function planPurge(store: Store, services: PurgeServices): Promise<PurgePlan> {
  const projects = store.listProjects();
  const plan: PurgePlan = { missingThreads: [], workspaces: [], repositories: [], published: [], accounts: [], games: [], usageThreads: [], warnings: [] };
  for (const project of projects) {
    if (project.pendingDeletion) { plan.missingThreads.push(project); continue; }
    try {
      const channel = await services.thread(project.threadId);
      if (channel.guild_id !== project.guildId || ![10, 11, 12].includes(channel.type)) {
        plan.warnings.push(`Retained registration ${project.threadId}: Discord identity did not match.`);
      }
    } catch (error) {
      if ((error as { code?: number }).code === 10003) plan.missingThreads.push(project);
      else plan.warnings.push(`Retained registration ${project.threadId}: Discord lookup unavailable (${String((error as Error).message)}).`);
    }
  }
  // Inventory both services before selecting destructive actions. Unavailable inventories
  // must throw, rather than interpreting an outage as an empty set of protected resources.
  const sessions = await services.sessions();
  const repositories = await services.repositories();
  const registeredThreads = new Set(projects.map((project) => project.threadId));
  const protectedRepos = new Set(projects.flatMap(projectRepos));
  // Repository IDs protect old-name redirects and partially delivered renames too.
  const protectedRepoIds = new Set(projects.flatMap((project) => project.pendingRename ? [project.pendingRename.repoId] : []));
  for (const name of protectedRepos) {
    const repo = await services.repository(name);
    if (repo) protectedRepoIds.add(repo.id);
  }
  const groups = new Map<string, PurgePlan["workspaces"][number]>();
  const addWorkspace = async (directory: string, sessionId?: string) => {
    const identity = workspaceIdentity(directory);
    if (!identity || registeredThreads.has(identity.threadId)) return;
    try { await checkedRemovalPath(config.workspaceRoot, identity.directory); }
    catch { plan.warnings.push(`Retained linked workspace: ${identity.directory}`); return; }
    const group = groups.get(identity.directory) ?? { ...identity, sessionIds: [] };
    if (sessionId && !group.sessionIds.includes(sessionId)) group.sessionIds.push(sessionId);
    groups.set(identity.directory, group);
  };
  for (const guild of await entries(config.workspaceRoot)) {
    if (!/^\d+$/.test(guild.name) || !guild.isDirectory() || guild.isSymbolicLink()) continue;
    const guildRoot = await checkedRemovalPath(config.workspaceRoot, path.join(config.workspaceRoot, guild.name));
    for (const thread of await entries(guildRoot)) {
      if (/^\d+$/.test(thread.name) && (thread.isDirectory() || thread.isSymbolicLink())) await addWorkspace(path.join(guildRoot, thread.name));
    }
  }
  for (const session of sessions) await addWorkspace(session.directory, session.id);
  plan.workspaces = [...groups.values()];
  for (const repo of repositories) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(repo.name)) continue;
    if (!protectedRepos.has(repo.name) && !protectedRepoIds.has(repo.id) && await services.managedRepository(repo)) plan.repositories.push({ id: repo.id, name: repo.name });
  }
  const protectedSlugs = new Set(projects.flatMap(projectSlugs));
  for (const entry of await entries(config.publishRoot)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const slug = /^(?:\.staging-|\.backup-)(.+)-[a-f0-9]{10}$/.exec(entry.name)?.[1] ?? entry.name;
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug) || protectedSlugs.has(slug)) continue;
    plan.published.push(await checkedRemovalPath(config.publishRoot, path.join(config.publishRoot, entry.name)));
  }
  const protectedAccounts = new Set(projects.flatMap(projectAccounts));
  try { plan.accounts = (await services.accounts()).filter((name) => /^push-[a-z0-9]{6}$/.test(name) && !protectedAccounts.has(name)); }
  catch (error) { plan.warnings.push(`Push-account inventory unavailable; retained accounts: ${String((error as Error).message)}`); }
  try { const protectedGames = gameIds(projects); plan.games = (await services.games()).filter((game) => !protectedGames.has(game)); }
  catch (error) { plan.warnings.push(`Relay inventory unavailable; retained worlds: ${String((error as Error).message)}`); }
  plan.usageThreads = (await services.usageThreads()).filter((id) => !registeredThreads.has(id));
  // Validate complete registered teardown paths during preview too.
  for (const project of plan.missingThreads) await removalPaths(project);
  return plan;
}

/** Retain failing registrations/resources for retry; recheck live ownership before every orphan removal. */
export async function applyPurge(store: Store, plan: PurgePlan, services: PurgeServices): Promise<void> {
  const errors: string[] = [];
  const attempt = async (label: string, action: () => Promise<void>) => {
    try { await action(); console.log(`Purged ${label}`); }
    catch (error) { errors.push(`${label}: ${String((error as Error).message)}`); }
  };
  for (const selected of plan.missingThreads) await attempt(`project ${selected.threadId}`, async () => {
    const project = store.getProject(selected.threadId);
    if (!project) return;
    if (!project.pendingDeletion) {
      try { await services.thread(project.threadId); throw new Error("Discord thread exists; registration retained."); }
      catch (error) { if ((error as { code?: number }).code !== 10003) throw error; }
    }
    await services.removeProject(project.threadId);
  });
  for (const workspace of plan.workspaces) await attempt(`workspace ${workspace.directory}`, async () => {
    if (store.getProject(workspace.threadId)) throw new Error("Workspace is registered now; retained.");
    await checkedRemovalPath(config.workspaceRoot, workspace.directory);
    // Abort/delete orphan sessions before touching source, including sessions whose folder vanished.
    for (const id of workspace.sessionIds.length ? workspace.sessionIds : [""]) await services.removeSessions(workspace.directory, id);
    await fs.rm(await checkedRemovalPath(config.workspaceRoot, workspace.directory), { recursive: true, force: true, maxRetries: 3 });
    await fs.rmdir(path.dirname(workspace.directory)).catch((error: NodeJS.ErrnoException) => {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code ?? "")) throw error;
    });
  });
  // A guild directory left empty by orphan removal is dead weight; registered
  // workspaces keep it non-empty, so only empty numeric folders disappear.
  for (const guild of await entries(config.workspaceRoot)) {
    if (!guild.isDirectory() || guild.isSymbolicLink() || !/^\d+$/.test(guild.name)) continue;
    await fs.rmdir(path.join(config.workspaceRoot, guild.name)).catch((error: NodeJS.ErrnoException) => {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code ?? "")) throw error;
    });
  }
  for (const selected of plan.repositories) await attempt(`repository ${selected.name}`, async () => {
    const current = store.listProjects();
    if (current.flatMap(projectRepos).includes(selected.name)) throw new Error("Repository is registered now; retained.");
    for (const name of new Set(current.flatMap(projectRepos))) {
      if ((await services.repository(name))?.id === selected.id) throw new Error("Repository is referenced by a registered redirect; retained.");
    }
    const repo = await services.repository(selected.name);
    if (repo && repo.id !== selected.id) throw new Error("Repository identity changed; retained.");
    if (repo) await services.removeRepository(repo.name);
  });
  for (const directory of plan.published) await attempt(`published folder ${directory}`, async () => {
    const slug = /^(?:\.staging-|\.backup-)(.+)-[a-f0-9]{10}$/.exec(path.basename(directory))?.[1] ?? path.basename(directory);
    if (store.listProjects().flatMap(projectSlugs).includes(slug)) throw new Error("Published folder is registered now; retained.");
    await fs.rm(await checkedRemovalPath(config.publishRoot, directory), { recursive: true, force: true, maxRetries: 3 });
  });
  for (const account of plan.accounts) await attempt(`push account ${account}`, async () => {
    if (store.listProjects().flatMap(projectAccounts).includes(account)) throw new Error("Push account is registered now; retained.");
    await services.removeAccount(account);
  });
  for (const game of plan.games) await attempt(`relay world ${game}`, async () => {
    if (gameIds(store.listProjects()).has(game)) throw new Error("Relay world is registered now; retained.");
    await services.removeGame(game);
  });
  for (const id of plan.usageThreads) await attempt(`usage ${id}`, async () => {
    if (store.getProject(id)) throw new Error("Usage belongs to a registered project now; retained.");
    await services.forgetUsage(id);
  });
  await services.refreshIndex();
  if (errors.length) throw new Error(`Purge completed with retained resources; retry after resolving:\n${errors.join("\n")}`);
}
