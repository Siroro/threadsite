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

  opencodeUrl: env("OPENCODE_URL", "http://opencode:4096").replace(/\/$/, ""),
  opencodeUsername: env("OPENCODE_SERVER_USERNAME", "opencode"),
  opencodePassword: env("OPENCODE_SERVER_PASSWORD"),
  defaultModel: env("OPENCODE_DEFAULT_MODEL"),
  opencodeReconcileTimeoutMs: intEnv("OPENCODE_RECONCILE_TIMEOUT_MS", 30 * 60 * 1000),
  opencodeReconcilePollMs: intEnv("OPENCODE_RECONCILE_POLL_MS", 1500),

  forgejoPublicUrl: env("FORGEJO_PUBLIC_URL", "http://localhost:3000").replace(/\/$/, ""),
  forgejoInternalUrl: env("FORGEJO_INTERNAL_URL", "http://forgejo:3000").replace(/\/$/, ""),
  forgejoOwner: env("FORGEJO_OWNER", "sitebot"),
  forgejoOwnerType: env("FORGEJO_OWNER_TYPE", "user") as "user" | "org",
  forgejoToken: env("FORGEJO_TOKEN"),
  forgejoTokenFile: env("FORGEJO_TOKEN_FILE", "/run/secrets/forgejo-token"),

  workspaceRoot: path.resolve(env("WORKSPACE_ROOT", "/workspace")),
  publishRoot: path.resolve(env("PUBLISH_ROOT", "/srv/sites")),
  stateFile: path.resolve(env("STATE_FILE", "/data/state.json")),
  publicSitesBaseUrl: env("PUBLIC_SITES_BASE_URL", "http://localhost:8080").replace(/\/$/, ""),
  publicIndexEnabled: boolEnv("PUBLIC_INDEX_ENABLED", true),

  maxSiteBytes: intEnv("MAX_SITE_BYTES", 10 * 1024 * 1024),
  maxSiteFiles: intEnv("MAX_SITE_FILES", 500),
  maxPromptChars: intEnv("MAX_PROMPT_CHARS", 12000),

  multiplayerEnabled: boolEnv("MULTIPLAYER_ENABLED", true),
  gameserverPublicUrl: env("GAMESERVER_PUBLIC_URL", "ws://localhost:8090/ws"),
  gameserverInternalUrl: env("GAMESERVER_INTERNAL_URL", "http://gameserver:8090").replace(/\/$/, ""),

  // Git identity: the Discord requester authors each commit; the bot commits
  // and is credited as Co-authored-by. Defaulting the email to the Forgejo
  // service account address lets Forgejo link the co-author avatar.
  commitBotName: env("COMMIT_BOT_NAME", "ThreadBot"),
  commitBotEmail: env("COMMIT_BOT_EMAIL") || env("FORGEJO_BOT_EMAIL") || "threadbot@localhost",

  logFile: path.resolve(env("LOG_FILE", "/data/threadsite.log")),
  logLevel: env("LOG_LEVEL", "info"),
};
