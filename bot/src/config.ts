import path from "node:path";

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function required(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = env(name);
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

/** Milliseconds; 0 explicitly disables whatever the setting controls. */
function msEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative integer (0 disables)`);
  return value;
}

/** Fraction between 0 and 1; 0 explicitly disables whatever the setting controls. */
function fractionEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be a number between 0 and 1 (0 disables)`);
  return value;
}

const adminUserIds = new Set(env("DISCORD_ADMIN_USER_IDS").split(",").map((x) => x.trim()).filter(Boolean));
const errorReportIdsRaw = env("DISCORD_ERROR_REPORT_USER_IDS");
const errorReportUserIds = new Set((errorReportIdsRaw || [...adminUserIds].join(",")).split(",").map((x) => x.trim()).filter(Boolean));

export const config = {
  discordToken: required("DISCORD_BOT_TOKEN"),
  discordApplicationId: required("DISCORD_APPLICATION_ID"),
  discordGuildId: env("DISCORD_GUILD_ID"),
  adminUserIds,
  errorReportUserIds,
  errorDmEnabled: boolEnv("ERROR_DM_ENABLED", true),
  progressUpdateMs: intEnv("PROGRESS_UPDATE_MS", 1800),
  // A turn that emits no progress for this long is flagged as possibly wedged
  // on the live card, with /site stop as the escape hatch. Request timeouts
  // against the agent service are disabled, so this is the visible watchdog,
  // not an automatic abort. 0 disables the warning.
  turnStallWarnMs: msEnv("TURN_STALL_WARN_MS", 5 * 60 * 1000),

  opencodeUrl: env("OPENCODE_URL", "http://opencode:4096").replace(/\/$/, ""),
  opencodeUsername: env("OPENCODE_SERVER_USERNAME", "opencode"),
  opencodePassword: env("OPENCODE_SERVER_PASSWORD"),
  defaultModel: env("OPENCODE_DEFAULT_MODEL"),
  opencodeMaxSteps: (() => {
    const raw = env("OPENCODE_MAX_STEPS", "200");
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error("OPENCODE_MAX_STEPS must be a positive integer (default: 200).");
    }
    return value;
  })(),
  opencodeReconcileTimeoutMs: intEnv("OPENCODE_RECONCILE_TIMEOUT_MS", 30 * 60 * 1000),
  opencodeReconcilePollMs: intEnv("OPENCODE_RECONCILE_POLL_MS", 1500),
  // A provider retry whose next attempt is scheduled further out than this is
  // an exhausted quota (e.g. the OpenCode free tier's daily reset at midnight
  // UTC), not transient backoff: the stalled turn is aborted, the failure
  // names the reset time, and further prompts fail fast until then.
  opencodeQuotaBlockMinRetryMs: intEnv("OPENCODE_QUOTA_BLOCK_MIN_RETRY_MS", 10 * 60 * 1000),
  // Headers/body timeouts for HTTP requests to the OpenCode service. Agent
  // turns routinely outlive undici's 5-minute defaults while the turn keeps
  // running server-side, so these default to disabled (0) — the reconcile
  // window above is the real deadline.
  opencodeRequestHeadersTimeoutMs: msEnv("OPENCODE_HEADERS_TIMEOUT_MS", 0),
  opencodeRequestBodyTimeoutMs: msEnv("OPENCODE_BODY_TIMEOUT_MS", 0),

  // Session context lifecycle. Idle sessions lose their provider prompt cache
  // and carry stale conversation state, so past SESSION_IDLE_RESET_MS the next
  // message starts a fresh session (workspace/git/PROJECT_NOTES.md keep the
  // durable state). A turn that ended above SESSION_CONTEXT_COMPACT_THRESHOLD
  // of the context window compacts the session before the next turn starts.
  // Either rule can be disabled with 0.
  sessionIdleResetMs: msEnv("SESSION_IDLE_RESET_MS", 2 * 60 * 60 * 1000),
  sessionCompactThreshold: fractionEnv("SESSION_CONTEXT_COMPACT_THRESHOLD", 0.5),

  forgejoPublicUrl: env("FORGEJO_PUBLIC_URL", "http://localhost:3000").replace(/\/$/, ""),
  forgejoInternalUrl: env("FORGEJO_INTERNAL_URL", "http://forgejo:3000").replace(/\/$/, ""),
  forgejoOwner: env("FORGEJO_OWNER", "sitebot"),
  forgejoOwnerType: env("FORGEJO_OWNER_TYPE", "user") as "user" | "org",
  forgejoToken: env("FORGEJO_TOKEN"),
  forgejoTokenFile: env("FORGEJO_TOKEN_FILE", "/run/secrets/forgejo-token"),
  // Admin token, used exclusively to create the restricted per-repo push
  // accounts that /site pushkey issues. Absent = pushkey is disabled.
  forgejoAdminTokenFile: env("FORGEJO_ADMIN_TOKEN_FILE", "/run/secrets/forgejo-admin-token"),
  // How often to poll each project's Forgejo main branch for commits pushed
  // from outside the bot (push-key holders). Runs alongside webhooks as a
  // safety net for setup/delivery failures. 0 disables polling.
  externalPushPollMs: msEnv("EXTERNAL_PUSH_POLL_MS", 60 * 1000),

  // Forgejo push webhooks: the bot listens on WEBHOOK_PORT for HMAC-signed
  // push events and reacts instantly instead of polling. WEBHOOK_PUBLIC_URL is
  // how Forgejo reaches the bot (docker service DNS by default).
  webhookEnabled: boolEnv("WEBHOOK_ENABLED", true),
  webhookPort: intEnv("WEBHOOK_PORT", 8901),
  webhookPublicUrl: env("WEBHOOK_PUBLIC_URL", "http://bot:8901").replace(/\/$/, ""),

  // Graceful shutdown: on SIGTERM, stop taking new work and wait this long for
  // in-flight turns before exiting (docker stop allows 10s by default).
  shutdownDrainMs: msEnv("SHUTDOWN_DRAIN_MS", 8000),

  workspaceRoot: path.resolve(env("WORKSPACE_ROOT", "/workspace")),
  publishRoot: path.resolve(env("PUBLISH_ROOT", "/srv/sites")),
  // SQLite store (projects + settings).
  stateDbFile: path.resolve(env("STATE_DB_FILE", "/data/state.db")),
  // Append-only JSONL token/cost ledger backing /site-admin usage.
  usageLogFile: path.resolve(env("USAGE_LOG_FILE", "/data/usage-log.jsonl")),
  publicSitesBaseUrl: env("PUBLIC_SITES_BASE_URL", "http://localhost:8080").replace(/\/$/, ""),
  publicIndexEnabled: boolEnv("PUBLIC_INDEX_ENABLED", true),

  // Provider resilience: when the active model's provider hits a quota block,
  // turns are re-routed to the first healthy model in this list instead of
  // failing fast until the provider resets. Empty = fail fast (old behavior).
  opencodeFailoverModels: env("OPENCODE_FAILOVER_MODELS").split(",").map((x) => x.trim()).filter(Boolean),
  // Autopilot economy: short non-initial mutations (no images) below
  // OPENCODE_LIGHT_PROMPT_CHARS run on this cheaper model instead of the default.
  opencodeLightModel: env("OPENCODE_LIGHT_MODEL"),
  opencodeLightPromptChars: intEnv("OPENCODE_LIGHT_PROMPT_CHARS", 400),

  // Browser QA: after static validation, load the site in the preview
  // service's Playwright browser, collect console/request errors, and capture a
  // screenshot for the thread. Every browser finding is advisory: warnings
  // are saved for the next agent turn and never trigger repair or block publication.
  // The budget must stay above the preview browser's own navigation (45s) and
  // action (30s) timeouts plus a screenshot, or a slow WebGL/software-rendered
  // page loses the pass to this outer timeout instead of reporting a result.
  browserQaEnabled: boolEnv("BROWSER_QA_ENABLED", true),
  browserQaTimeoutMs: intEnv("BROWSER_QA_TIMEOUT_MS", 90_000),
  previewMcpUrl: env("PREVIEW_MCP_URL", "http://preview:8931/mcp"),

  // 3D games bundling Rapier (~2.5MB minified with inlined WASM) plus real
  // GLB/texture/audio assets need headroom well past the old 10MB.
  maxSiteBytes: intEnv("MAX_SITE_BYTES", 32 * 1024 * 1024),
  maxSiteFiles: intEnv("MAX_SITE_FILES", 500),
  maxPromptChars: intEnv("MAX_PROMPT_CHARS", 12000),

  multiplayerEnabled: boolEnv("MULTIPLAYER_ENABLED", true),
  gameserverPublicUrl: env("GAMESERVER_PUBLIC_URL", "ws://localhost:8090/ws"),
  gameserverInternalUrl: env("GAMESERVER_INTERNAL_URL", "http://gameserver:8090").replace(/\/$/, ""),
  gameserverAdminTokenFile: env("GAMESERVER_ADMIN_TOKEN_FILE", "/run/threadsite-control/cleanup-token"),
  projectCleanupIntervalMs: intEnv("PROJECT_CLEANUP_INTERVAL_MS", 60_000),

  // Git identity: the Discord requester authors each commit; the bot commits
  // and is credited as Co-authored-by. Defaulting the email to the Forgejo
  // service account address lets Forgejo link the co-author avatar.
  commitBotName: env("COMMIT_BOT_NAME", "ThreadBot"),
  commitBotEmail: env("COMMIT_BOT_EMAIL") || env("FORGEJO_BOT_EMAIL") || "threadbot@localhost",

  logFile: path.resolve(env("LOG_FILE", "/data/threadsite.log")),
  logLevel: env("LOG_LEVEL", "info"),
};
