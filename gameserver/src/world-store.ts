import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The on-disk form of one game's persisted ARENA world. Only the latest
 * authoritative world is kept: generation/epoch/seq/from/cid belong to the
 * relay session that produced them and must never be reused after a restart.
 */
export type StoredWorld = { version: 1; gameId: string; state: unknown; savedAt: number };

const LEGACY_WORLD = /^([a-z0-9][a-z0-9-]{2,63})\.json$/;
const LEGACY_DELETED = /^([a-z0-9][a-z0-9-]{2,63})\.deleted$/;
const LEGACY_TMP = /^[a-z0-9][a-z0-9-]{2,63}\.json\.\d+\.[a-f0-9]{8}\.tmp$/;

/** The relay's single database: worlds, tombstones, redirects, saves and scores. */
export function relayDatabaseFile(stateDir: string): string { return path.join(stateDir, "relay.sqlite"); }

/**
 * Durable ARENA worlds in SQLite: one row per game holding the latest
 * authoritative snapshot, deletion tombstones that outlive restarts, and
 * old-name redirects recorded by project renames. The tables share
 * `relay.sqlite` (see {@link relayDatabaseFile}) with the player store; this
 * store opens its own connection at startup, before the server listens.
 * Legacy per-game `<id>.json` snapshots and `<id>.deleted` tombstones are
 * imported once at open; each file is removed only after its row landed, and
 * re-importing is a no-op, so a crash mid-migration heals on the next start.
 */
export class WorldStore {
  private database: DatabaseSync | undefined;
  private readonly file: string;
  constructor(readonly stateDir: string) { this.file = relayDatabaseFile(stateDir); }

  private open(): DatabaseSync {
    if (this.database) return this.database;
    fs.mkdirSync(this.stateDir, { recursive: true });
    const db = new DatabaseSync(this.file);
    try {
      db.exec(`PRAGMA busy_timeout = 1000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS worlds (
          game TEXT PRIMARY KEY, state TEXT, saved_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS deleted_games (game TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS game_aliases (from_game TEXT PRIMARY KEY, to_game TEXT NOT NULL);`);
      this.importLegacyFiles(db);
      this.database = db;
      return db;
    } catch (error) { db.close(); throw error; }
  }

  private importLegacyFiles(db: DatabaseSync): void {
    let names: string[];
    try { names = fs.readdirSync(this.stateDir); } catch { return; } // no directory yet: nothing to import
    const imported: string[] = [];
    for (const name of names) {
      const tombstone = LEGACY_DELETED.exec(name)?.[1];
      if (tombstone) {
        db.prepare("INSERT OR IGNORE INTO deleted_games VALUES (?)").run(tombstone);
        imported.push(name);
        continue;
      }
      const gameId = LEGACY_WORLD.exec(name)?.[1];
      if (!gameId) {
        // Crash leftovers of the old temp-file + rename writes.
        if (LEGACY_TMP.test(name)) fs.rmSync(path.join(this.stateDir, name), { force: true });
        continue;
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.stateDir, name), "utf8")) as Partial<StoredWorld>;
        if (parsed?.version !== 1 || parsed.gameId !== gameId
          || typeof parsed.savedAt !== "number" || parsed.state === undefined) {
          console.warn(`[threadsite-gameserver] worlds skipped legacy ${name}: unexpected shape`);
          continue;
        }
        // A row can only be absent (first import) or newer (a live write after
        // a partial migration); either way the file never overwrites the row.
        db.prepare("INSERT OR IGNORE INTO worlds VALUES (?, ?, ?)").run(gameId, JSON.stringify(parsed.state), parsed.savedAt);
        imported.push(name);
      } catch (error) {
        console.warn(`[threadsite-gameserver] worlds skipped legacy ${name}: ${String((error as Error).message ?? error)}`);
      }
    }
    for (const name of imported) {
      try { fs.rmSync(path.join(this.stateDir, name), { force: true, maxRetries: 3 }); }
      catch (error) { console.warn(`[threadsite-gameserver] worlds kept legacy ${name}: ${String((error as Error).message ?? error)}`); }
    }
    this.discardLegacyPlayerDatabase();
  }

  /**
   * Historical `players.sqlite` (and its WAL sidecars) are not migrated into
   * `relay.sqlite`: a deployment upgrade starts player records fresh by
   * design, and the superseded file would otherwise linger forever. Removed
   * only after `relay.sqlite` opened, so an unreadable new database never
   * costs the old one.
   */
  private discardLegacyPlayerDatabase(): void {
    let removed = false;
    for (const name of ["players.sqlite", "players.sqlite-wal", "players.sqlite-shm"]) {
      const file = path.join(this.stateDir, name);
      if (!fs.existsSync(file)) continue;
      try { fs.rmSync(file, { force: true, maxRetries: 3 }); removed = true; }
      catch (error) { console.warn(`[threadsite-gameserver] worlds kept legacy ${name}: ${String((error as Error).message ?? error)}`); }
    }
    if (removed) console.warn("[threadsite-gameserver] discarded legacy players.sqlite; player records start fresh in relay.sqlite");
  }

  /** Every persisted world; tombstoned games are excluded by the caller. */
  load(): { worlds: StoredWorld[]; deleted: string[]; aliases: Array<{ from: string; to: string }> } {
    const db = this.open();
    const worlds = db.prepare("SELECT game, state, saved_at FROM worlds ORDER BY saved_at").all() as Array<{ game: string; state: string | null; saved_at: number }>;
    return {
      worlds: worlds.map((row) => ({ version: 1, gameId: row.game, state: row.state == null ? null : JSON.parse(row.state), savedAt: row.saved_at })),
      deleted: (db.prepare("SELECT game FROM deleted_games").all() as Array<{ game: string }>).map((row) => row.game),
      aliases: (db.prepare("SELECT from_game, to_game FROM game_aliases").all() as Array<{ from_game: string; to_game: string }>)
        .map((row) => ({ from: row.from_game, to: row.to_game })),
    };
  }

  /** Newest snapshot wins; every statement commits (FULL sync) before returning. */
  persist(gameId: string, state: unknown, savedAt: number): void {
    this.open().prepare(`INSERT INTO worlds VALUES (?, ?, ?)
      ON CONFLICT(game) DO UPDATE SET state=excluded.state, saved_at=excluded.saved_at`).run(gameId, JSON.stringify(state), savedAt);
  }

  /** Forget a game's world without blocking future joins (reset semantics). */
  reset(gameId: string): void {
    this.open().prepare("DELETE FROM worlds WHERE game = ?").run(gameId);
  }

  /** Remove the world and tombstone the game so stale clients cannot revive it. */
  delete(gameId: string): void {
    const db = this.open();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM worlds WHERE game = ?").run(gameId);
      db.prepare("INSERT OR IGNORE INTO deleted_games VALUES (?)").run(gameId);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  /**
   * Re-key a game's world to its new name and leave a redirect behind. The
   * target name is taken over completely: its leftover world (an unpurged
   * deleted project) and tombstone go, aliases already pointing at the old
   * name are re-chained to the new one, and a redirect that currently points
   * at the source collapses (renaming back to a previous name) instead of
   * looping. Callers reject live target worlds first.
   */
  rename(from: string, to: string): void {
    const db = this.open();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE game_aliases SET to_game = ? WHERE to_game = ?").run(to, from);
      db.prepare("DELETE FROM game_aliases WHERE from_game = ?").run(to);
      db.prepare("INSERT INTO game_aliases(from_game, to_game) VALUES (?, ?)").run(from, to);
      db.prepare("DELETE FROM deleted_games WHERE game = ?").run(to);
      db.prepare("DELETE FROM worlds WHERE game = ?").run(to);
      db.prepare("UPDATE worlds SET game = ? WHERE game = ?").run(to, from);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  /** Games with a persisted world row (canonical names only; aliases excluded). */
  games(): string[] {
    return (this.open().prepare("SELECT game FROM worlds").all() as Array<{ game: string }>).map((row) => row.game);
  }

  /** Whether a world row exists for the game (canonical name). */
  has(gameId: string): boolean {
    return this.open().prepare("SELECT 1 FROM worlds WHERE game = ?").get(gameId) !== undefined;
  }

  close(): void { this.database?.close(); this.database = undefined; }
}
