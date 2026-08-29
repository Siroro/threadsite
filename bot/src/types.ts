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
}

export interface PersistedSettings {
  model?: string;
}

export interface PersistedState {
  version: 1;
  settings: PersistedSettings;
  projects: Record<string, ProjectRecord>;
}
