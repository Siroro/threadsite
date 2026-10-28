// Opt-in live-provider integration. Uses anonymous zero-cost OpenCode models,
// fresh Compose volumes/workspaces, real Forgejo and Apache; no Discord login.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = fileURLToPath(new URL("./compose/", import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-free-e2e-"));
const project = `threadsite-free-e2e-${randomUUID().slice(0, 8)}`;
const override = path.join(root, "compose.json.yaml");
const mount = (source, target, read_only = false) => ({ type: "bind", source, target, read_only });
for (const name of ["workspaces", "sites", "state", "artifacts", "opencode-host"]) await fs.mkdir(path.join(root, name));
await fs.writeFile(path.join(root, "opencode-host", "providers.json"), JSON.stringify({ catalogs: { surplus: false } }));
const tokenFile = path.join(root, "forgejo-token");
await fs.writeFile(tokenFile, "", { mode: 0o600 });
const env = {
  DISCORD_BOT_TOKEN: "isolated-test-only", DISCORD_APPLICATION_ID: "100",
  OPENCODE_URL: "http://opencode:4096",
  OPENCODE_SERVER_PASSWORD: "isolated-test-only",
  OPENCODE_DEFAULT_MODEL: "opencode/mimo-v2.6-flash-free", OPENCODE_MAX_STEPS: "60",
  OPENCODE_FAILOVER_MODELS: "", OPENCODE_BLIP_NUDGES: "0",
  OPENCODE_RECONCILE_TIMEOUT_MS: "120000", OPENCODE_RECONCILE_POLL_MS: "500",
  WORKSPACE_ROOT: "/workspace", PUBLISH_ROOT: "/srv/sites", STATE_DB_FILE: "/data/state.db",
  USAGE_DB_FILE: "/data/usage.sqlite", LOG_FILE: "/data/e2e.jsonl", MULTIPLAYER_ENABLED: "false",
  PUBLIC_SITES_BASE_URL: "http://static-web", PREVIEW_MCP_URL: "http://preview:8931/mcp",
  FORGEJO_INTERNAL_URL: "http://forgejo:3000", FORGEJO_PUBLIC_URL: "http://forgejo:3000",
  FORGEJO_OWNER: "e2eowner", FORGEJO_TOKEN_FILE: "/run/secrets/forgejo-token", WEBHOOK_ENABLED: "false",
  BROWSER_QA_ENABLED: "true", BROWSER_QA_TIMEOUT_MS: "90000",
};
await fs.writeFile(override, `services:
  forgejo:
    ports: !reset []
    environment:
      FORGEJO__server__ROOT_URL: http://forgejo:3000/
      FORGEJO__server__DOMAIN: forgejo
  preview:
    volumes: !override ${JSON.stringify([mount(path.join(root, "workspaces"), "/workspace", true), mount(fixtures, "/app/fixtures", true), mount(path.join(root, "artifacts"), "/artifacts")])}
  opencode:
    env_file: !reset []
    environment: !override ${JSON.stringify({ XDG_DATA_HOME: "/opencode-data",
      OPENCODE_SERVER_PASSWORD: "isolated-test-only", OPENCODE_MAX_STEPS: "60", OPENCODE_LOG_LEVEL: "INFO",
      OPENCODE_WEBSEARCH_PROVIDER: "off", CONTEXT7_ENABLED: "1" })}
    volumes: !override ${JSON.stringify([mount(path.join(root, "workspaces"), "/workspace"), mount(path.join(root, "opencode-host"), "/etc/threadsite/opencode", true), { type: "volume", source: "opencode-data", target: "/opencode-data" }])}
  bot:
    env_file: !reset []
    environment: !override ${JSON.stringify(env)}
    volumes: !override ${JSON.stringify([mount(path.join(root, "workspaces"), "/workspace"), mount(path.join(root, "sites"), "/srv/sites"), mount(path.join(root, "state"), "/data"), mount(path.join(root, "artifacts"), "/artifacts"), mount(tokenFile, "/run/secrets/forgejo-token", true), mount(path.join(fixtures, "free-model-bot.mjs"), "/app/free-model-e2e.mjs", true), mount(path.join(fixtures, "free-model-checks.mjs"), "/app/free-model-checks.mjs", true)])}
    depends_on: !reset []
    command: ["node", "/app/free-model-e2e.mjs"]
  static-web:
    profiles: !reset []
    ports: !reset []
    volumes: !override ${JSON.stringify([mount(path.join(root, "sites"), "/usr/local/apache2/htdocs", true)])}
`);
const args = ["compose", "--project-name", project, "--env-file", path.join(repo, ".env.example"),
  "-f", path.join(repo, "docker-compose.yml"), "-f", override];
const compose = async (...command) => {
  const task = exec("docker", [...args, ...command], { cwd: repo, maxBuffer: 32 * 1024 * 1024, timeout: 1_800_000 });
  if (command[0] === "run") task.child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  return task;
};
console.log(`Isolated live-model test: ${project}\nArtifacts: ${root}`);
try {
  console.log("Building production bot, native v2 and preview images...");
  await compose("build", "bot", "opencode", "preview");
  console.log("Starting isolated Forgejo, OpenCode, preview and Apache...");
  await compose("up", "-d", "--wait", "--wait-timeout", "180", "forgejo", "preview", "opencode", "static-web");
  const fj = ["exec", "-T", "forgejo", "forgejo", "-w", "/var/lib/gitea", "-c", "/var/lib/gitea/custom/conf/app.ini", "admin", "user"];
  for (let attempt = 0; ; attempt++) {
    try { await compose(...fj, "list"); break; }
    catch (error) { if (attempt >= 30) throw error; await new Promise((resolve) => setTimeout(resolve, 1000)); }
  }
  await compose(...fj, "create", "--username", "e2eowner", "--email", "e2e@example.invalid", "--random-password", "--must-change-password=false");
  const token = (await compose(...fj, "generate-access-token", "--username", "e2eowner", "--token-name", "isolated-e2e", "--raw", "--scopes", "all")).stdout.trim();
  assertToken(token);
  await fs.writeFile(tokenFile, token, { mode: 0o600 });
  console.log("Running live free-model creation and revision through ProjectService...");
  await compose("run", "--rm", "--no-deps", "bot");
  await compose("run", "--rm", "--no-deps", "bot", "node", "/app/free-model-checks.mjs");
  console.log("Checking authored interactions at desktop and mobile sizes...");
  await compose("run", "--rm", "--no-deps", "preview", "node", "/app/fixtures/free-model-browser.mjs");
  console.log(`PASS live free-model integration. Evidence retained in ${root}`);
} catch (error) {
  console.error(error.stderr || error.message);
  const logs = await compose("logs", "--no-color", "--tail", "100", "opencode", "preview", "forgejo", "static-web").catch(() => undefined);
  if (logs) await fs.writeFile(path.join(root, "artifacts", "services.log"), logs.stdout);
  console.error(`FAIL: evidence retained in ${root}`);
  process.exitCode = 1;
} finally {
  if (process.exitCode && process.env.THREADSITE_E2E_KEEP_SERVICES === "1") {
    console.error(`Retaining only the isolated ${project} services for diagnosis. Compose override: ${override}`);
  } else {
    await compose("down", "--volumes", "--remove-orphans").catch((error) => { console.error(`Cleanup failed for ${project}: ${error.message}`); process.exitCode = 1; });
    await fs.unlink(tokenFile).catch(() => {});
  }
}
function assertToken(value) {
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(value)) throw new Error("Isolated Forgejo did not return a token");
}
