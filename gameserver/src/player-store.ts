import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class StorageError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

type SaveRow = { value: string | null; bytes: number; revision: number; updatedAt: number };
type ScoreRow = { playerId: string; name: string; score: number; updatedAt: number };
type Order = "desc" | "asc";
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;
const MAX_SAVE_BYTES = 64 * 1024;
const MAX_SLOTS = 16;
const MAX_BOARDS = 16;

/** Private saves and public, client-reported best scores. The tables share
 * `relay.sqlite` with the durable world store; this store opens its own
 * connection lazily, on the first persistence request.
 * Every successful mutation is committed before the relay acknowledges it.
 */
export class PlayerStore {
  private database: DatabaseSync | undefined;
  constructor(readonly file: string, private readonly limits: { players: number; gameBytes: number }) {}

  private open(): DatabaseSync {
    if (this.database) return this.database;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    try {
      db.exec(`PRAGMA busy_timeout = 1000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS players (
          game TEXT NOT NULL, player TEXT NOT NULL, PRIMARY KEY (game, player));
        CREATE TABLE IF NOT EXISTS saves (
          game TEXT NOT NULL, player TEXT NOT NULL, slot TEXT NOT NULL,
          value TEXT, bytes INTEGER NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY (game, player, slot),
          FOREIGN KEY (game, player) REFERENCES players(game, player) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS boards (
          game TEXT NOT NULL, board TEXT NOT NULL, ordering TEXT NOT NULL,
          PRIMARY KEY (game, board));
        CREATE TABLE IF NOT EXISTS scores (
          game TEXT NOT NULL, board TEXT NOT NULL, player TEXT NOT NULL,
          name TEXT NOT NULL, score REAL NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY (game, board, player),
          FOREIGN KEY (game, player) REFERENCES players(game, player) ON DELETE CASCADE,
          FOREIGN KEY (game, board) REFERENCES boards(game, board) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS score_ranking ON scores(game, board, score, updated_at, player);
        CREATE INDEX IF NOT EXISTS score_ranking_desc ON scores(game, board, score DESC, updated_at ASC, player ASC);
        CREATE INDEX IF NOT EXISTS score_player ON scores(game, player);`);
      // Build the per-game byte counter once for existing databases. Triggers
      // and the initial snapshot are committed together, including after a crash.
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS storage_meta (key TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS game_save_bytes (game TEXT PRIMARY KEY, bytes INTEGER NOT NULL CHECK(bytes >= 0));`);
        if (!db.prepare("SELECT 1 FROM storage_meta WHERE key = 'save_bytes_v1'").get()) {
          db.exec(`INSERT INTO game_save_bytes(game, bytes) SELECT game, SUM(bytes) FROM saves GROUP BY game;
            CREATE TRIGGER save_bytes_insert AFTER INSERT ON saves BEGIN
              INSERT INTO game_save_bytes(game, bytes) VALUES (NEW.game, NEW.bytes)
                ON CONFLICT(game) DO UPDATE SET bytes = bytes + NEW.bytes;
            END;
            CREATE TRIGGER save_bytes_update AFTER UPDATE OF bytes ON saves BEGIN
              UPDATE game_save_bytes SET bytes = bytes + NEW.bytes - OLD.bytes WHERE game = NEW.game;
            END;
            CREATE TRIGGER save_bytes_delete AFTER DELETE ON saves BEGIN
              UPDATE game_save_bytes SET bytes = bytes - OLD.bytes WHERE game = OLD.game;
            END;
            INSERT INTO storage_meta(key) VALUES ('save_bytes_v1');`);
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      this.database = db;
      return db;
    } catch (error) { db.close(); throw error; }
  }

  private key(value: unknown): string {
    if (typeof value !== "string" || !KEY.test(value)) throw new StorageError("bad_key", "Use a 1-48 character alphanumeric, underscore or hyphen key.");
    return value;
  }

  private transaction<T>(action: (db: DatabaseSync) => T): T {
    const db = this.open();
    db.exec("BEGIN IMMEDIATE");
    try { const result = action(db); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  private ensurePlayer(db: DatabaseSync, game: string, player: string): void {
    if (db.prepare("SELECT 1 FROM players WHERE game = ? AND player = ?").get(game, player)) return;
    const count = db.prepare("SELECT COUNT(*) AS n FROM players WHERE game = ?").get(game) as { n: number };
    if (count.n >= this.limits.players) throw new StorageError("player_limit", "This game's persistent player limit is reached.");
    db.prepare("INSERT INTO players VALUES (?, ?)").run(game, player);
  }

  private save(db: DatabaseSync, game: string, player: string, slot: string): SaveRow | undefined {
    return db.prepare("SELECT value, bytes, revision, updated_at AS updatedAt FROM saves WHERE game = ? AND player = ? AND slot = ?").get(game, player, slot) as SaveRow | undefined;
  }

  private decoded(row: SaveRow | undefined): { value: unknown; revision: number; updatedAt: number | null } {
    return { value: row?.value == null ? null : JSON.parse(row.value), revision: row?.revision ?? 0, updatedAt: row?.updatedAt ?? null };
  }

  execute(game: string, player: string, name: string, request: Record<string, unknown>): unknown {
    switch (request.op) {
      case "save.get": {
        const slot = this.key(request.slot);
        return this.decoded(this.save(this.open(), game, player, slot));
      }
      case "save.set":
      case "save.delete": {
        const slot = this.key(request.slot);
        if (!Number.isSafeInteger(request.revision) || Number(request.revision) < 0) throw new StorageError("bad_revision", "Supply the revision returned by saves.get().");
        const value = request.op === "save.delete" ? null : JSON.stringify(request.value);
        if (value === undefined) throw new StorageError("bad_value", "A JSON save value is required.");
        const bytes = value === null ? 0 : Buffer.byteLength(value);
        if (bytes > MAX_SAVE_BYTES) throw new StorageError("save_too_large", "Save slots hold at most 64 KiB of JSON.");
        return this.transaction((db) => {
          const previous = this.save(db, game, player, slot);
          if ((previous?.revision ?? 0) !== request.revision) throw new StorageError("save_conflict", "The save changed. Read it again before deciding how to merge.");
          this.ensurePlayer(db, game, player);
          if (!previous) {
            const count = db.prepare("SELECT COUNT(*) AS n FROM saves WHERE game = ? AND player = ?").get(game, player) as { n: number };
            if (count.n >= MAX_SLOTS) throw new StorageError("slot_limit", "A player may use at most 16 save slot names, including deleted slots.");
          }
          const total = db.prepare("SELECT bytes AS n FROM game_save_bytes WHERE game = ?").get(game) as { n: number } | undefined;
          if ((total?.n ?? 0) - (previous?.bytes ?? 0) + bytes > this.limits.gameBytes) throw new StorageError("storage_full", "This game's save storage is full.");
          const revision = (previous?.revision ?? 0) + 1;
          const updatedAt = Date.now();
          db.prepare(`INSERT INTO saves VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(game, player, slot) DO UPDATE SET value=excluded.value, bytes=excluded.bytes,
            revision=excluded.revision, updated_at=excluded.updated_at`).run(game, player, slot, value, bytes, revision, updatedAt);
          return { value: value === null ? null : JSON.parse(value), revision, updatedAt };
        });
      }
      case "board.list": {
        const board = this.key(request.board);
        const limit = request.limit ?? 10;
        if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new StorageError("bad_limit", "Request between 1 and 100 leaderboard entries.");
        const db = this.open();
        const config = db.prepare("SELECT ordering FROM boards WHERE game = ? AND board = ?").get(game, board) as { ordering: Order } | undefined;
        if (!config) return { order: null, entries: [] };
        const direction = config.ordering === "asc" ? "ASC" : "DESC";
        const entries = db.prepare(`SELECT player AS playerId, name, score, updated_at AS updatedAt
          FROM scores WHERE game = ? AND board = ? ORDER BY score ${direction}, updated_at ASC, player ASC LIMIT ?`).all(game, board, Number(limit));
        return { order: config.ordering, entries };
      }
      case "board.submit": {
        const board = this.key(request.board);
        const score = request.score;
        const order = request.order ?? "desc";
        if (typeof score !== "number" || !Number.isFinite(score)) throw new StorageError("bad_score", "Scores must be finite numbers.");
        if (order !== "asc" && order !== "desc") throw new StorageError("bad_order", "Leaderboard order must be asc or desc.");
        return this.transaction((db) => {
          const config = db.prepare("SELECT ordering FROM boards WHERE game = ? AND board = ?").get(game, board) as { ordering: Order } | undefined;
          if (config && config.ordering !== order) throw new StorageError("board_order_conflict", "This board already uses a different score order. Use a new board key for new rules.");
          if (!config) {
            const count = db.prepare("SELECT COUNT(*) AS n FROM boards WHERE game = ?").get(game) as { n: number };
            if (count.n >= MAX_BOARDS) throw new StorageError("board_limit", "A game may use at most 16 leaderboard names.");
            db.prepare("INSERT INTO boards VALUES (?, ?, ?)").run(game, board, order);
          }
          this.ensurePlayer(db, game, player);
          const previous = db.prepare("SELECT player AS playerId, name, score, updated_at AS updatedAt FROM scores WHERE game = ? AND board = ? AND player = ?").get(game, board, player) as ScoreRow | undefined;
          if (previous && (order === "asc" ? score >= previous.score : score <= previous.score)) return { ...previous };
          const updatedAt = Date.now();
          db.prepare(`INSERT INTO scores VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(game, board, player) DO UPDATE SET name=excluded.name, score=excluded.score,
            updated_at=excluded.updated_at`).run(game, board, player, name, score, updatedAt);
          return { playerId: player, name, score, updatedAt };
        });
      }
      default: throw new StorageError("bad_operation", "Unknown persistence operation.");
    }
  }

  games(): string[] {
    if (!this.database && !existsSync(this.file)) return [];
    return (this.open().prepare("SELECT game FROM players UNION SELECT game FROM boards").all() as { game: string }[]).map((row) => row.game);
  }

  deleteGame(game: string): void {
    if (!this.database && !existsSync(this.file)) return;
    this.transaction((db) => {
      db.prepare("DELETE FROM players WHERE game = ?").run(game);
      db.prepare("DELETE FROM boards WHERE game = ?").run(game);
      db.prepare("DELETE FROM game_save_bytes WHERE game = ?").run(game);
    });
  }

  /** Drop a game's leaderboards (scores cascade with them); players and their private saves survive. */
  resetScores(game: string): void {
    if (!this.database && !existsSync(this.file)) return;
    this.transaction((db) => { db.prepare("DELETE FROM boards WHERE game = ?").run(game); });
  }

  close(): void { this.database?.close(); this.database = undefined; }
}
