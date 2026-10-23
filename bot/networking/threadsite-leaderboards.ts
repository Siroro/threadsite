// Score-only client: no rooms, peers, world state, gameplay loop or reconnection.
import { getPlayerIdentity } from "./threadsite-player.js";

export interface LeaderboardScore { playerId: string; name: string; score: number; updatedAt: number }
export interface Leaderboard { order: "asc" | "desc" | null; entries: LeaderboardScore[] }
export interface LeaderboardOptions {
  game: string;
  url: string;
  /** Ask the player before submitting. Change it with setName(). */
  name?: string;
  timeoutMs?: number;
}
export class LeaderboardError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = "LeaderboardError"; }
}

/** Global personal bests for one game, independent of its multiplayer mode. */
export class ThreadSiteLeaderboards {
  private readonly identity;
  private readonly url: string;
  private name = "";
  private sequence = 0;
  private publicPlayerId: string | null = null;
  constructor(private readonly options: LeaderboardOptions) {
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(options.game)) throw new LeaderboardError("Invalid game ID.", "bad_config");
    let url: URL;
    try { url = new URL(options.url); } catch { throw new LeaderboardError("A leaderboard service URL is required.", "bad_config"); }
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password) throw new LeaderboardError("Use a ws:// or wss:// service URL without credentials.", "bad_config");
    if (typeof location !== "undefined" && location.protocol === "https:" && url.protocol === "ws:") url.protocol = "wss:";
    this.url = url.href;
    this.identity = getPlayerIdentity(options.game);
    if (options.name !== undefined) this.setName(options.name);
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new LeaderboardError("timeoutMs must be positive.", "bad_config");
  }
  get identityPersistent(): boolean { return this.identity.persistent; }
  /** Available after a successful request; never an authentication credential. */
  get playerId(): string | null { return this.publicPlayerId; }
  setName(name: string): void {
    this.name = String(name).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32);
  }
  async submit(board: string, score: number, options: { order?: "asc" | "desc" } = {}): Promise<LeaderboardScore> {
    if (!this.name) throw new LeaderboardError("Ask the player for a name before submitting a score.", "name_required");
    if (!Number.isFinite(score)) throw new LeaderboardError("Scores must be finite numbers.", "bad_score");
    if (options.order !== undefined && options.order !== "asc" && options.order !== "desc") throw new LeaderboardError("Order must be asc or desc.", "bad_order");
    return this.request(board, { op: "board.submit", score, order: options.order ?? "desc" });
  }
  async list(board: string, options: { limit?: number } = {}): Promise<Leaderboard> {
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new LeaderboardError("Request between 1 and 100 entries.", "bad_limit");
    return this.request(board, { op: "board.list", limit });
  }
  private request<T>(board: string, fields: Record<string, unknown>): Promise<T> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(board)) return Promise.reject(new LeaderboardError("Invalid board key.", "bad_key"));
    if (!this.identity.token) return Promise.reject(new LeaderboardError("Secure player identity is unavailable.", "identity_unavailable"));
    if (typeof navigator !== "undefined" && navigator.onLine === false) return Promise.reject(new LeaderboardError("Global rankings are unavailable offline.", "offline"));
    return new Promise<T>((resolve, reject) => {
      let socket: WebSocket;
      try { socket = new WebSocket(this.url); }
      catch { reject(new LeaderboardError("Could not connect to global rankings.", "unavailable")); return; }
      const id = `board.${++this.sequence}`;
      let sent = false;
      let settled = false;
      const finish = (error?: LeaderboardError, value?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
        socket.close();
        if (error) reject(error); else resolve(value!);
      };
      const unavailable = () => new LeaderboardError("Global rankings are unavailable. Check the board before retrying a submission.", sent && fields.op === "board.submit" ? "submission_uncertain" : "unavailable");
      const timer = setTimeout(() => finish(unavailable()), this.options.timeoutMs ?? 10_000);
      socket.onopen = () => {
        try {
          socket.send(JSON.stringify({ ...fields, t: "leaderboard", v: 1, id, board,
            game: this.options.game, name: this.name, playerToken: this.identity.token }));
          sent = true;
        } catch { finish(unavailable()); }
      };
      socket.onerror = socket.onclose = () => finish(unavailable());
      socket.onmessage = (event) => {
        try {
          const reply = JSON.parse(String(event.data));
          if (reply.t !== "leaderboard-result" || reply.id !== id) { finish(new LeaderboardError("Invalid leaderboard response.", "bad_response")); return; }
          if (!reply.ok) { finish(new LeaderboardError(reply.message || "Leaderboard request failed.", reply.code || "unavailable")); return; }
          this.publicPlayerId = reply.playerId;
          finish(undefined, reply.result as T);
        } catch { finish(new LeaderboardError("Invalid leaderboard response.", "bad_response")); }
      };
    });
  }
}
