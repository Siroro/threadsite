export interface LeaderboardScore {
    playerId: string;
    name: string;
    score: number;
    updatedAt: number;
}
export interface Leaderboard {
    order: "asc" | "desc" | null;
    entries: LeaderboardScore[];
}
export interface LeaderboardOptions {
    game: string;
    url: string;
    /** Ask the player before submitting. Change it with setName(). */
    name?: string;
    timeoutMs?: number;
}
export declare class LeaderboardError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
/** Global personal bests for one game, independent of its multiplayer mode. */
export declare class ThreadSiteLeaderboards {
    private readonly options;
    private readonly identity;
    private readonly url;
    private name;
    private sequence;
    private publicPlayerId;
    constructor(options: LeaderboardOptions);
    get identityPersistent(): boolean;
    /** Available after a successful request; never an authentication credential. */
    get playerId(): string | null;
    setName(name: string): void;
    submit(board: string, score: number, options?: {
        order?: "asc" | "desc";
    }): Promise<LeaderboardScore>;
    list(board: string, options?: {
        limit?: number;
    }): Promise<Leaderboard>;
    private request;
}
