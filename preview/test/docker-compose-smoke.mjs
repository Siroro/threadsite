import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const tests = fileURLToPath(new URL("./compose/", import.meta.url));
const pixelsOnly = process.argv.includes("--pixels-only");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-compose-"));
const project = `threadsite-smoke-${randomUUID().slice(0, 8)}`;
const override = path.join(root, "compose.override.yaml");
const mount = (source, target, read_only = false) => ({ type: "bind", source, target, read_only });
const workspace = path.join(root, "workspaces");
const sites = path.join(root, "sites");
const state = path.join(root, "state");
for (const dir of [workspace, sites, state]) await fs.mkdir(dir);
const opencodeEnv = {
  XDG_DATA_HOME: "/opencode-data", OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: "fixture-only",
  SURPLUS_API_KEY: "fixture-only", SURPLUS_BASE_URL: "http://fixture:7070/v1", SURPLUS_MODELS: "compose-vision,compose-text",
  OPENCODE_MAX_STEPS: "50",
  OPENCODE_LOG_LEVEL: "INFO", OPENCODE_ENABLE_EXA: "0",
};
const botEnv = {
  DISCORD_BOT_TOKEN: "fixture-only", DISCORD_APPLICATION_ID: "100", OPENCODE_URL: "http://opencode:4096",
  OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: "fixture-only", WORKSPACE_ROOT: "/workspace",
  PUBLISH_ROOT: "/srv/sites", STATE_DB_FILE: "/data/state.db", LOG_FILE: "/data/smoke.jsonl",
  PUBLIC_SITES_BASE_URL: "http://static-web", MULTIPLAYER_ENABLED: "false",
  OPENCODE_MAX_STEPS: "50",
};
await fs.writeFile(override, `services:
  fixture:
    image: node:24-bookworm-slim
    command: ["node", "/fixtures/provider.mjs"]
    volumes: ${JSON.stringify([mount(tests, "/fixtures", true)])}
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:7070/report').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 2s
      timeout: 5s
      retries: 20
  preview:
    volumes: !override ${JSON.stringify([mount(workspace, "/workspace", true), mount(tests, "/app/fixtures", true)])}
  opencode:
    environment: !override ${JSON.stringify(opencodeEnv)}
    volumes: !override ${JSON.stringify([mount(workspace, "/workspace"), { type: "volume", source: "opencode-data", target: "/opencode-data" }])}
    depends_on:
      fixture:
        condition: service_healthy
  bot:
    env_file: !reset []
    environment: !override ${JSON.stringify(botEnv)}
    volumes: !override ${JSON.stringify([mount(workspace, "/workspace"), mount(sites, "/srv/sites"), mount(state, "/data"), mount(tests, "/fixtures", true), mount(path.join(tests, "bot.mjs"), "/app/compose-smoke.mjs", true)])}
    depends_on: !reset []
    command: ["node", "/app/compose-smoke.mjs"]
  static-web:
    profiles: !reset []
    ports: !reset []
    volumes: !override ${JSON.stringify([mount(sites, "/usr/local/apache2/htdocs", true)])}
`);
const args = ["compose", "--project-name", project, "--env-file", path.join(repo, ".env.example"),
  "-f", path.join(repo, "docker-compose.yml"), "-f", override];
const compose = async (...command) => {
  const task = exec("docker", [...args, ...command], {
    cwd: repo, maxBuffer: 16 * 1024 * 1024, timeout: 600_000,
  });
  if (command[0] === "run") {
    let pending = "";
    task.child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      for (const line of lines) if (/^(?:PASS|Checking )/.test(line)) console.log(line);
    });
  }
  return task;
};
try {
  console.log("Building production images through Docker Compose...");
  await compose("build", ...(pixelsOnly ? ["bot", "preview"] : ["bot", "opencode", "preview"]));
  if (pixelsOnly) {
    await compose("run", "--rm", "--no-deps", "bot", "node", "/fixtures/pixel-seed.mjs");
  } else {
    console.log("Starting isolated Compose services with production networking, mounts and resource limits...");
    await compose("up", "-d", "--wait", "--wait-timeout", "180", "fixture", "preview", "opencode", "static-web");
    console.log("Running production bot modules against the real services (fixture model, no Discord login or paid inference)...");
    await compose("run", "--rm", "--no-deps", "bot");
  }
  console.log("Checking Excalibur native rendering at desktop/phone sizes and standard/HiDPI densities...");
  await compose("run", "--rm", "--no-deps", "preview", "node", "/app/fixtures/pixel-perfect.mjs");
} catch (error) {
  console.error(error.stdout || "");
  console.error(error.stderr || error.message);
  const logs = await compose("logs", "--tail", "50", "fixture", "preview", "opencode").catch(() => undefined);
  if (logs) console.error(logs.stdout);
  process.exitCode = 1;
} finally {
  await compose("down", "--volumes", "--remove-orphans").catch((error) => {
    console.error("Could not clean up fixture Compose project:", project, error.message); process.exitCode = 1;
  });
  // This directory was created above solely for this test's mounts and config.
  await fs.rm(root, { recursive: true, force: true });
}
