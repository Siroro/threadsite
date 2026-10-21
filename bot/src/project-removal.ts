import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { ProjectRecord } from "./types.js";

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
  const slugs = projectSlugs(project);
  for (const slug of slugs) {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) throw new Error(`Invalid site slug: ${slug}`);
    paths.push(await checkedRemovalPath(config.publishRoot, path.join(config.publishRoot, slug)));
  }
  // Include only this project's atomic-publish leftovers, never a prefix
  // match that could consume another project's longer slug.
  for (const name of await fs.readdir(config.publishRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []; throw error;
  })) {
    if (slugs.some((slug) => new RegExp(`^\\.(?:staging|backup)-${slug}-[a-f0-9]{10}$`).test(name))) {
      paths.push(await checkedRemovalPath(config.publishRoot, path.join(config.publishRoot, name)));
    }
  }
  return paths;
}

export function projectSlugs(project: ProjectRecord): string[] {
  return [...new Set([project.siteSlug, ...(project.siteAliases ?? []),
    ...(project.pendingRename ? [project.pendingRename.siteSlug, project.pendingRename.fromSiteSlug] : [])])];
}

export function projectRepos(project: ProjectRecord): string[] {
  const repos = [...new Set([project.repoName,
    ...(project.pendingRename ? [project.pendingRename.repoName, project.pendingRename.fromRepoName] : [])])];
  if (repos.some((repo) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(repo))) throw new Error("Invalid project repository name.");
  return repos;
}

export function projectAccounts(project: ProjectRecord): string[] {
  const accounts = [...new Set([...(project.pushAccountNames ?? []), ...(project.pushKey ? [project.pushKey.username] : [])])];
  if (accounts.some((name) => !/^push-[a-zA-Z0-9_-]+$/.test(name))) throw new Error("Invalid project push account name.");
  return accounts;
}

export function assertExclusiveResources(project: ProjectRecord, all: ProjectRecord[]): void {
  const slugs = projectSlugs(project);
  const repos = projectRepos(project);
  const game = project.multiplayerGameId ?? (project.projectKind?.startsWith("game-") ? project.siteSlug : undefined);
  for (const other of all.filter((item) => item.threadId !== project.threadId)) {
    if (projectRepos(other).some((repo) => repos.includes(repo)) || projectSlugs(other).some((slug) => slugs.includes(slug))
      || path.resolve(other.workspacePath) === path.resolve(project.workspacePath)
      || (project.sessionId && other.sessionId === project.sessionId)
      || projectAccounts(project).some((account) => projectAccounts(other).includes(account))
      || (game && game === (other.multiplayerGameId ?? (other.projectKind?.startsWith("game-") ? other.siteSlug : undefined)))) {
      throw new Error(`Another project shares resources with ${project.threadId}; refusing removal.`);
    }
  }
}
