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

function gamePath(gameId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(gameId)) throw new Error("Invalid relay game identity.");
  return `/admin/games/${encodeURIComponent(gameId)}`;
}

async function relayRequest(route: string, method: "GET" | "POST" | "DELETE", operation: string, timeoutMs = 15_000): Promise<Response> {
  const response = await fetch(`${config.gameserverInternalUrl}${route}`, {
    method, headers: { Authorization: `Bearer ${await relayCleanupToken()}` }, signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${operation} failed (${response.status}).`);
  return response;
}

export async function deleteRelayGame(gameId: string): Promise<void> {
  await relayRequest(gamePath(gameId), "DELETE", "Relay game cleanup");
}

/**
 * Re-key a game's relay presence to its renamed project: the durable arena
 * world follows the new name, the old name keeps redirecting for connected
 * players and briefly stale published configs, and the old name's private
 * saves and scores are dropped. Redelivering a landed rename is idempotent,
 * so retrying an ambiguous failure is safe.
 */
export async function renameRelayGame(from: string, to: string): Promise<void> {
  const source = gamePath(from);
  gamePath(to);
  await relayRequest(`${source}/rename?to=${encodeURIComponent(to)}`, "POST", "Relay game rename");
}

/** What a reset removes. Scores and worlds are chosen independently. */
export type RelayResetScope = { world: true; scores: boolean } | { world: false; scores: true };

function resetQuery(scope: RelayResetScope): string {
  if (typeof scope?.world !== "boolean" || typeof scope?.scores !== "boolean") throw new Error("Invalid relay reset scope.");
  if (!scope.world && !scope.scores) throw new Error("Choose at least one thing to clear.");
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
  await relayRequest(`${gamePath(gameId)}/reset${resetQuery(scope)}`, "POST", "Relay game reset");
}

/** Relay-wide variant of the reset; returns how many games were affected. */
export async function resetAllRelayGames(scope: RelayResetScope = { world: true, scores: true }): Promise<number> {
  const response = await relayRequest(`/admin/reset${resetQuery(scope)}`, "POST", "Relay-wide reset", 30_000);
  const body = (await response.json().catch(() => undefined)) as { games?: unknown } | undefined;
  if (!body || typeof body.games !== "number" || !Number.isSafeInteger(body.games) || body.games < 0) throw new Error("Unexpected relay reset payload.");
  return body.games;
}

export async function listRelayGames(): Promise<string[]> {
  const response = await relayRequest("/admin/games", "GET", "Relay inventory");
  const games = await response.json();
  if (!Array.isArray(games) || games.some((game) => typeof game !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(game))) throw new Error("Unexpected relay inventory payload.");
  return games;
}
