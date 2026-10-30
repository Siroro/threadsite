export type ProjectStatus = "creating" | "ready" | "error";
export type ProjectKind = "site" | "game-2d" | "game-3d";
/** Multiplayer architecture chosen at /makegam: shared arena, invite-code rooms, or none. */
export type MultiplayerMode = "arena" | "rooms" | "singleplayer";
export type CollaborationMode = "open" | "contributors" | "approval";
/** Who may clear a game's shared relay state (arena world, rooms, scores). */
export type WipePolicy = "owner" | "anyone";
export interface CollaborationSettings {
  mode: CollaborationMode;
  userIds: string[];
  revision: number;
  /** Owner & server admins only (default), or anyone in the thread. */
  wipePolicy?: WipePolicy;
}
export interface ApprovalAttachment { name: string; mime: string; dataUrl: string }
export interface ProjectApproval {
  id: string;
  requesterId: string;
  author: CommitAuthor;
  prompt: string;
  createdAt: string;
  attachmentCount: number;
  attachments: ApprovalAttachment[];
}

/** Per-project multiplayer wiring handed to game agents (game id + relay URL). */
export interface MultiplayerContext {
  gameId: string;
  wsUrl: string;
  protocolVersion: number;
  /** Connectivity shape the agent should build: one game-wide arena, or invite-code rooms. */
  mode: Exclude<MultiplayerMode, "singleplayer">;
}

/** Git author identity derived from the Discord user who requested the change. */
export interface CommitAuthor {
  name: string;
  email: string;
}

export interface QueuedRequest {
  prompt: string;
  /** Modal requests have no separate user message; retain their words in the turn's details. */
  displayPrompt?: string;
  statusMessageId: string;
  author?: CommitAuthor;
  /** Discord user who sent the request, so a pending agent question can ping them. */
  requesterId?: string;
  images?: Array<{ mime: string; filename?: string; dataUrl: string }>;
  /**
   * Non-image attachments saved into the workspace at message receipt (bytes
   * on disk under scratch/uploads; the prompt names the paths). Metadata only —
   * used for queue display, not delivery.
   */
  files?: Array<{ name: string; path: string; bytes: number; mime?: string }>;
}

/** The kinds of user contribution counted on the pinned project card. */
export type ContributionKind = "turns" | "steers" | "answers";

/** One user's lifetime contributions to a project thread. */
export interface ContributionTally {
  turns: number;
  steers: number;
  answers: number;
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
  /** Durable deletion intent: block new work and retry teardown after failures/restarts. */
  pendingDeletion?: { requestedAt: string; reason: string; lastError?: string; agentsDeleted?: boolean };
  /** Full original request, retained for the repository README and project card. */
  initialPrompt?: string;
  /** Discord user who started the thread, linked as the founder on the pinned project card. */
  starterId?: string;
  /** Display name of the project requester, for README attribution alongside starterId. */
  starterName?: string;
  /** Human thread owner; for bot-created threads this is the project requester. */
  ownerId?: string;
  /** Missing settings mean anyone can edit, including on existing projects. */
  collaboration?: CollaborationSettings;
  /**
   * Site-admin model override for this thread (provider/model-id): every turn
   * the thread runs — prompts, repair, recovery, compaction fallbacks, image
   * gating — uses it instead of the bot-wide model. Unset follows the bot-wide
   * model.
   */
  modelOverride?: string;
  /** Lifetime per-user contributions (requested turns, live steers, delivered answers), shown on the pinned card. */
  contributors?: Record<string, ContributionTally>;
  /** The pinned project-card message; edited in place after every turn outcome. */
  infoMessageId?: string;
  /** Play message that owns the last screenshot; fetch it to refresh signed CDN thumbnail URLs. */
  previewMessageId?: string;
  /** Saved presentation of the last published turn; keeps pinned descriptions tied to the live version. */
  lastCardMessageId?: string;
  lastError?: string;
  /** Confirmed advisory browser findings carried into the next turn. `deliveredAt`
   * marks a record whose feedback already rode one instruction; it is replaced by
   * the next QA pass and never re-read by later turns. */
  browserQaFindings?: { checkedAt: string; findings: string[]; deliveredAt?: string };
  /** Short hash of the commit belonging to the last accepted turn; used by /site revert. */
  lastCommit?: string;
  /** Pre-turn commit; metadata-only rename commits belong to the same undo boundary. */
  lastTurnBaseCommit?: string;
  /** Stable game identity for global leaderboards and optional multiplayer; survives renames. */
  multiplayerGameId?: string;
  /** Multiplayer architecture chosen at /makegam. */
  multiplayerMode?: MultiplayerMode;
  siteAliases?: string[];
  pendingThreadName?: string;
  /** A user rename the agent has not been told about yet; prepended to the next turn's instructions. */
  renameNote?: { from: string; to: string };
  /** Naming survives initial-build failures, bot restarts and Discord/Forgejo outages. */
  pendingNaming?: { request: string; name?: string };
  /** Durable rename intent, resumed before further work if delivery is interrupted. */
  pendingRename?: {
    displayName: string;
    siteSlug: string;
    repoName: string;
    fromSiteSlug: string;
    fromRepoName: string;
    /** Display name before this rename; the next-turn note quotes it. */
    fromDisplayName?: string;
    repoId: number;
    /** Rename metadata/public URLs while retaining failed-turn source edits. */
    preserveWorktree?: boolean;
    /** User-initiated rename: the next agent turn is told about it. */
    notifyAgent?: boolean;
  };
  /**
   * Full hash of the commit the bot last saw on the repo's main branch, set on
   * every bot push and adoption. The external-push poller compares against it,
   * so a mismatch means someone pushed with a repo push key.
   */
  lastSeenCommit?: string;
  /**
   * Repository-scoped push credentials issued with /site pushkey. The account
   * is a restricted Forgejo user with Write on exactly this project's repo.
   */
  pushKey?: {
    username: string;
    password: string;
    createdAt: string;
  };
  /** Allocated push accounts, including failed issuance/rotation awaiting cleanup. */
  pushAccountNames?: string[];
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
    id: string;
    prompt: string;
    initial: boolean;
    startedAt: string;
    author?: CommitAuthor;
    /** Discord user who requested the turn, so a pending agent question can ping them. */
    requesterId?: string;
    /** The live status message the turn was streaming into, so recovery can resume editing it. */
    statusMessageId?: string;
    beforeCommit?: string;
    images?: QueuedRequest["images"];
  };
  /**
   * Prompts accumulated for the thread's next turn while a turn runs or waits
   * (update coalescing), each with its status message id. Mirrored into the
   * store so a restart can re-run messages that were acknowledged in the
   * thread but never started; consumed entries are atomically handed to pendingTurn.
   */
  pendingQueue?: QueuedRequest[];
}

