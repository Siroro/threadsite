import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";

/** Private bot/relay volume; never mounted into generated sites or the agent. */
export async function relayCleanupToken(): Promise<string> {
  const file = config.gameserverAdminTokenFile;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await fs.writeFile(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const token = (await fs.readFile(file, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid relay cleanup token file.");
  return token;
}

export async function deleteRelayGame(gameId: string): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(gameId)) throw new Error("Invalid relay game identity.");
  const response = await fetch(`${config.gameserverInternalUrl}/admin/games/${encodeURIComponent(gameId)}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${await relayCleanupToken()}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Relay game cleanup failed (${response.status}).`);
}

/**
 * Re-key a game's relay presence to its renamed project: the durable arena
 * world follows the new name, the old name keeps redirecting for connected
 * players and briefly stale published configs, and the old name's private
 * saves and scores are dropped. Redelivering a landed rename is idempotent,
 * so retrying an ambiguous failure is safe.
 */
export async function renameRelayGame(from: string, to: string): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(from) || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(to)) throw new Error("Invalid relay game identity.");
  const response = await fetch(`${config.gameserverInternalUrl}/admin/games/${encodeURIComponent(from)}/rename?to=${encodeURIComponent(to)}`, {
    method: "POST", headers: { Authorization: `Bearer ${await relayCleanupToken()}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Relay game rename failed (${response.status}).`);
}

/** What a reset removes. Scores and worlds are chosen independently. */
export interface RelayResetScope { world: boolean; scores: boolean }

function resetQuery(scope: RelayResetScope): string {
  if (scope.world && scope.scores) return "";
  return `?scope=${scope.world ? "world" : "scores"}`;
}

/**
 * Clear a game's shared relay state without deleting the project: the durable
 * arena world, its open rooms (connected players reconnect into fresh, empty
 * ones) and leaderboard scores, according to `scope`. Private save slots
 * survive; no deletion tombstone is written.
 */
export async function resetRelayGame(gameId: string, scope: RelayResetScope = { world: true, scores: true }): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(gameId)) throw new Error("Invalid relay game identity.");
  if (!scope.world && !scope.scores) throw new Error("Choose at least one thing to clear.");
  const response = await fetch(`${config.gameserverInternalUrl}/admin/games/${encodeURIComponent(gameId)}/reset${resetQuery(scope)}`, {
    method: "POST", headers: { Authorization: `Bearer ${await relayCleanupToken()}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Relay game reset failed (${response.status}).`);
}

/** Relay-wide variant of the reset; returns how many games were affected. */
export async function resetAllRelayGames(scope: RelayResetScope = { world: true, scores: true }): Promise<number> {
  if (!scope.world && !scope.scores) throw new Error("Choose at least one thing to clear.");
  const response = await fetch(`${config.gameserverInternalUrl}/admin/reset${resetQuery(scope)}`, {
    method: "POST", headers: { Authorization: `Bearer ${await relayCleanupToken()}` }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Relay-wide reset failed (${response.status}).`);
  const body = (await response.json().catch(() => undefined)) as { games?: unknown } | undefined;
  if (!body || typeof body.games !== "number") throw new Error("Unexpected relay reset payload.");
  return body.games;
}

export async function listRelayGames(): Promise<string[]> {
  const response = await fetch(`${config.gameserverInternalUrl}/admin/games`, {
    headers: { Authorization: `Bearer ${await relayCleanupToken()}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Relay inventory failed (${response.status}).`);
  const games = await response.json();
  if (!Array.isArray(games) || games.some((game) => typeof game !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(game))) throw new Error("Unexpected relay inventory payload.");
  return games;
}
