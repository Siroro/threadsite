export type ProjectStatus = "creating" | "ready" | "error";
export type ProjectKind = "site" | "game-2d" | "game-3d";

/** Per-project multiplayer wiring handed to game agents (game id + relay URL). */
export interface MultiplayerContext {
  gameId: string;
  wsUrl: string;
  protocolVersion: number;
}

/** Git author identity derived from the Discord user who requested the change. */
export interface CommitAuthor {
  name: string;
  email: string;
}

export interface ProjectRecord {
  threadId: string;
  guildId: string;
  parentChannelId: string;
  displayName: string;
  workspacePath: string;
  siteSlug: string;
  repoName: string;
  sessionId: string;
  projectKind?: ProjectKind;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  /** Short hash of the commit belonging to the last accepted turn; used by /site revert. */
  lastCommit?: string;
  /**
   * When the last agent turn ran (success or failure). A non-initial turn
   * whose session has been idle longer than SESSION_IDLE_RESET_MS starts a
   * fresh session instead of re-reading a stale, cache-cold context.
   */
  lastTurnAt?: string;
  /**
   * Context window usage observed at the end of the last successful turn.
   * When it exceeded SESSION_CONTEXT_COMPACT_THRESHOLD of the window, the
   * next turn compacts the session first, at the turn boundary, instead of
   * paying for a near-full window or a mid-turn auto-compaction.
   */
  lastTurnUsage?: { contextTokens: number; contextLimit?: number };
  /**
   * Present while a turn is in flight so a bot restart can recover it: the
   * interrupted request is continued, then validated, committed, and published.
   * Cleared on every terminal outcome.
   */
  pendingTurn?: {
    prompt: string;
    initial: boolean;
    startedAt: string;
    author?: CommitAuthor;
    /** The live status message the turn was streaming into, so recovery can resume editing it. */
    statusMessageId?: string;
  };
}

export interface PersistedSettings {
  model?: string;
  /** Model variant (reasoning effort) sent with every prompt; "auto" is stored as undefined. */
  effort?: string;
}

export interface PersistedState {
  version: 1;
  settings: PersistedSettings;
  projects: Record<string, ProjectRecord>;
}
