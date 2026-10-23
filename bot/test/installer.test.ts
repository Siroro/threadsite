import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";

const exec = promisify(execFile);
const bash = process.platform === "win32" ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe") : "bash";
const applicationId = "123456789012345678";
const token = "installer.test.bot-token";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-installer-"));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith("threadsite-installer-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  for (const file of ["scripts/caddy-quickstart.sh", "scripts/setup.sh", ".env.example", "caddy/vhosts/forgejo.caddy.example", "caddy/vhosts/games.caddy.example"]) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), (await fs.readFile(new URL(`../../${file}`, import.meta.url), "utf8")).replaceAll("\r\n", "\n"));
  }
  await fs.writeFile(path.join(root, "docker-compose.yml"), "services: {}\n");
  await fs.mkdir(path.join(root, "bin"));
  await fs.mkdir(path.join(root, "model-check/dist"), { recursive: true });
  await fs.writeFile(path.join(root, "model-check/package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(root, "model-check/dist/opencode.js"), `export class OpenCodeHarness {
    async listSelectableModels() { return JSON.parse(process.env.TEST_MODELS ?? '["opencode/hy3-free","openai/coder","surplus/coder"]'); }
  }`);
  await fs.writeFile(path.join(root, "scripts/bootstrap-forgejo.sh"), `#!/usr/bin/env bash
set -eu
printf 'bootstrap\n' >> calls.log
printf 'fixture-service-token' > secrets/forgejo-token
printf 'fixture-admin-token' > secrets/forgejo-admin-token
`);
  await fs.writeFile(path.join(root, "bin/docker"), `#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> calls.log
case "$*" in
  'compose run '*)
    set -a; source .env; set +a
    cd model-check
    exec node --input-type=module - ;;
  'compose logs --no-color bot')
    [[ "\${TEST_READY:-1}" == 0 ]] || printf '[threadsite] INFO discord.ready {}\n'
    exit 0 ;;
  'compose up '*) [[ "\${TEST_START_FAIL:-0}" != 1 ]] || exit 17 ;;
esac
exit 0
`, { mode: 0o755 });
  await fs.writeFile(path.join(root, "bin/curl"), `#!/usr/bin/env bash
set -eu
cat > auth.log
printf '%s\n' "\${!#}" >> requests.log
[[ "\${TEST_BAD_TOKEN:-0}" != 1 ]] || exit 22
case "\${!#}" in
  *oauth2/applications/@me)
    printf '{"id":"${applicationId}","flags":%s,"interactions_endpoint_url":"%s"}\n' "\${TEST_FLAGS:-524288}" "\${TEST_ENDPOINT:-}" ;;
  *guilds/*) [[ "\${TEST_NOT_INVITED:-0}" != 1 ]] || exit 22; printf '{}' ;;
  *users/@me/guilds)
    if [[ "\${TEST_NOT_INVITED:-0}" == 1 ]]; then printf '[]'; else printf '[{"id":"223456789012345678"}]'; fi ;;
  *) exit 9 ;;
esac
`, { mode: 0o755 });
  const baseEnv = { ...process.env, DISCORD_BOT_TOKEN: "", DISCORD_APPLICATION_ID: "", DISCORD_GUILD_ID: "", DISCORD_ADMIN_USER_IDS: "", OPENCODE_DEFAULT_MODEL: "", THREADSITE_API_KEY: "", OPENCODE_API_KEY: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "", GOOGLE_GENERATIVE_AI_API_KEY: "" };
  const run = (args: string[] = [], env: NodeJS.ProcessEnv = {}) => exec(bash, ["-c", 'export PATH="$PWD/bin:$PATH"; bash ./scripts/caddy-quickstart.sh --non-interactive "$@"', "test", ...args], {
    cwd: root, env: { ...baseEnv, ...env },
    timeout: 45_000,
  });
  const read = (file: string) => fs.readFile(path.join(root, file), "utf8");
  const calls = async () => read("calls.log").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  const setting = async (name: string) => (await exec(bash, ["-c", 'source .env; printf "%s" "\${!1}"', "test", name], { cwd: root })).stdout;
  const args = ["--domain", "example.com", "--discord-token", token];
  return { root, run, read, calls, setting, args, baseEnv };
}

test("installer configures public services, discovers the app, and waits for Discord after bootstrap and model checks", async (t) => {
  const f = await fixture(t);
  const { stdout, stderr } = await f.run([...f.args, "--guild-id", "223456789012345678"]);
  assert.equal(await f.setting("DISCORD_APPLICATION_ID"), applicationId);
  assert.equal(await f.setting("DISCORD_BOT_TOKEN"), token);
  assert.equal(await f.setting("PUBLIC_SITES_BASE_URL"), "https://sites.example.com");
  assert.equal(await f.setting("FORGEJO_PUBLIC_URL"), "https://git.example.com");
  assert.equal(await f.setting("GAMESERVER_PUBLIC_URL"), "wss://sites.example.com/ws");
  assert.equal(await f.setting("GAMESERVER_ALLOWED_ORIGINS"), "https://sites.example.com");
  assert.match(await f.setting("OPENCODE_SERVER_PASSWORD"), /^[a-f0-9]{64}$/);
  const calls = await f.calls();
  assert.ok(calls.indexOf("compose build") < calls.indexOf("bootstrap"));
  assert.ok(calls.indexOf("bootstrap") < calls.indexOf("compose run"));
  assert.ok(calls.indexOf("compose run") < calls.indexOf("compose up -d --force-recreate"));
  assert.ok(calls.indexOf("compose up -d --force-recreate") < calls.indexOf("compose logs"));
  assert.ok((await f.read("requests.log")).includes("guilds/223456789012345678"));
  assert.ok((await f.read("auth.log")).includes(`Authorization: Bot ${token}`));
  assert.ok(!stdout.includes(token) && !stderr.includes(token) && !calls.includes(token));
  const invite = new URL(stdout.match(/https:\/\/discord.com\/oauth2\/authorize\?\S+/)![0]);
  const permissions = BigInt(invite.searchParams.get("permissions")!);
  assert.equal(permissions & 8n, 0n, "invite must not request Administrator");
  assert.ok(permissions & (1n << 35n), "invite permits creating project threads");
  assert.ok(permissions & (1n << 51n), "invite permits pinning project cards");
  assert.equal(invite.searchParams.get("guild_id"), "223456789012345678");
});

test("custom sites and Git hostnames work without a games hostname", async (t) => {
  const f = await fixture(t);
  await f.run(["--sites-domain", "lab.siroro.co.uk", "--git-domain", "git.siroro.co.uk", "--discord-token", token]);
  assert.equal(await f.setting("PUBLIC_SITES_BASE_URL"), "https://lab.siroro.co.uk");
  assert.equal(await f.setting("FORGEJO_PUBLIC_URL"), "https://git.siroro.co.uk");
  assert.equal(await f.setting("GAMESERVER_PUBLIC_URL"), "wss://lab.siroro.co.uk/ws");
  await assert.rejects(fs.access(path.join(f.root, "caddy/vhosts/games.caddy")), { code: "ENOENT" });
  await f.run();
  assert.equal(await f.setting("GAMESERVER_PUBLIC_URL"), "wss://lab.siroro.co.uk/ws");
});

test("a separate games hostname is retained on reruns and can be switched back to the sites hostname", async (t) => {
  const f = await fixture(t);
  await f.run([...f.args, "--games-domain", "games.example.com"]);
  assert.equal(await f.setting("GAMESERVER_PUBLIC_URL"), "wss://games.example.com/ws");
  await fs.access(path.join(f.root, "caddy/vhosts/games.caddy"));
  await f.run();
  assert.equal(await f.setting("GAMESERVER_PUBLIC_URL"), "wss://games.example.com/ws");
  await f.run(["--games-on-sites"]);
  assert.equal(await f.setting("GAMESERVER_PUBLIC_URL"), "wss://sites.example.com/ws");
  await assert.rejects(fs.access(path.join(f.root, "caddy/vhosts/games.caddy")), { code: "ENOENT" });
});

test("missing, invalid and mismatched Discord inputs never write credentials or start services", async (t) => {
  const cases = [
    { args: ["--domain", "example.com"] },
    { args: ["--discord-token"] },
    { args: ["--domain", "bad..domain", "--discord-token", token] },
    { args: ["--domain", "example.com\ninjected.example.com", "--discord-token", token] },
    { args: ["--domain", "example.com", "--discord-token", token], env: { TEST_BAD_TOKEN: "1" } },
    { args: ["--domain", "example.com", "--discord-token", token], env: { TEST_FLAGS: "0" } },
    { args: ["--domain", "example.com", "--discord-token", token], env: { TEST_ENDPOINT: "https://example.invalid/interactions" } },
    { args: ["--domain", "example.com", "--discord-token", token, "--app-id", "923456789012345678"] },
    { args: ["--domain", "example.com", "--discord-token", token, "--guild-id", "223456789012345678"], env: { TEST_NOT_INVITED: "1" } },
    { args: ["--domain", "example.com", "--discord-token", token], env: { TEST_NOT_INVITED: "1" } },
    { args: ["--domain", "example.com", "--discord-token", token, "--model", "openai/coder"] },
    { args: ["--domain", "example.com", "--discord-token", token, "--model", "openai/coder", "--api-key", "invalid\\key"] },
  ];
  for (const value of cases) {
    const f = await fixture(t);
    await assert.rejects(f.run(value.args, value.env));
    assert.ok(!(await f.calls()).includes("compose up"));
    await assert.rejects(fs.access(path.join(f.root, ".env")), { code: "ENOENT" });
  }
});

test("provider keys survive shell metacharacters without execution, logging or lost settings on rerun", async (t) => {
  const f = await fixture(t);
  const key = 'sk-$dollar & | # `quote` "$(touch SHOULD_NOT_EXIST)"';
  await fs.writeFile(path.join(f.root, "provider-key"), key);
  await f.run([...f.args, "--model", "openai/coder", "--api-key-file", "provider-key"]);
  assert.equal(await f.setting("OPENAI_API_KEY"), key);
  const password = await f.setting("OPENCODE_SERVER_PASSWORD");
  await fs.appendFile(path.join(f.root, ".env"), "UNRELATED_SETTING='keep me'\n");
  await fs.writeFile(path.join(f.root, "data/workspaces/keep"), "saved project");
  await fs.writeFile(path.join(f.root, "secrets/keep"), "existing private file");
  const result = await f.run();
  assert.equal(await f.setting("OPENAI_API_KEY"), key);
  assert.equal(await f.setting("OPENCODE_SERVER_PASSWORD"), password);
  assert.equal(await f.setting("UNRELATED_SETTING"), "keep me");
  assert.equal(await f.read("data/workspaces/keep"), "saved project");
  assert.equal(await f.read("secrets/keep"), "existing private file");
  assert.ok(!result.stdout.includes(key) && !(await f.calls()).includes(key));
  await assert.rejects(fs.access(path.join(f.root, "SHOULD_NOT_EXIST")), { code: "ENOENT" });
  if (process.platform !== "win32") assert.equal((await fs.stat(path.join(f.root, ".env"))).mode & 0o777, 0o600);
});

test("Surplus key updates retain private model definitions and context caps", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "opencode/host"), { recursive: true });
  const original = { contextCaps: { surplus: 64000 }, providers: { surplus: { models: { coder: { limit: { context: 64000 } } }, settings: { baseURL: "https://provider.example.invalid/v1" } } } };
  await fs.writeFile(path.join(f.root, "opencode/host/providers.json"), JSON.stringify(original));
  await f.run([...f.args, "--model", "surplus/coder", "--api-key", "private-provider-key"]);
  const saved = JSON.parse(await f.read("opencode/host/providers.json"));
  assert.equal(saved.providers.surplus.settings.apiKey, "private-provider-key");
  delete saved.providers.surplus.settings.apiKey;
  assert.deepEqual(saved, original);
});

test("unavailable models and startup failures fail the install and leave saved configuration for retry", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run(f.args, { TEST_MODELS: "[]" }));
  assert.ok(!(await f.calls()).includes("compose up -d --force-recreate"));
  assert.equal(await f.setting("DISCORD_BOT_TOKEN"), token);
  await assert.rejects(f.run([], { TEST_START_FAIL: "1" }), (error: any) => error.code === 17);
  await assert.rejects(f.run(["--wait-seconds", "1"], { TEST_READY: "0" }));
  await f.run();
});

test("infrastructure-only installation is explicit and never checks Discord or starts the bot", async (t) => {
  const f = await fixture(t);
  await f.run(["--skip-bot", "--sites-domain", "localhost"]);
  await assert.rejects(fs.access(path.join(f.root, "requests.log")), { code: "ENOENT" });
  const calls = await f.calls();
  assert.ok(calls.includes("compose up -d --wait"));
  assert.ok(!calls.includes("compose run") && !calls.includes("compose up -d --force-recreate"));
});

test("a downloaded installer reuses an existing checkout without Git resets and reads token files before changing directories", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, ".git"));
  await fs.mkdir(path.join(f.root, "downloads/nested"), { recursive: true });
  await fs.copyFile(path.join(f.root, "scripts/caddy-quickstart.sh"), path.join(f.root, "downloads/nested/install.sh"));
  await fs.writeFile(path.join(f.root, "downloads/nested/token"), token);
  await fs.writeFile(path.join(f.root, "bin/git"), '#!/usr/bin/env bash\nexit 99\n', { mode: 0o755 });
  await exec(bash, ["-c", 'export PATH="$PWD/bin:$PATH"; export THREADSITE_DIR="$PWD"; cd downloads/nested; bash install.sh --non-interactive --domain example.com --discord-token-file token'], { cwd: f.root, env: f.baseEnv, timeout: 45_000 });
  assert.equal(await f.setting("DISCORD_BOT_TOKEN"), token);
  assert.ok((await f.calls()).includes("compose up -d --force-recreate"));
});

test("Forgejo bootstrap can refresh credentials without restarting the bot until the installer is ready", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "scripts/bootstrap-forgejo.sh"), (await fs.readFile(new URL("../../scripts/bootstrap-forgejo.sh", import.meta.url), "utf8")).replaceAll("\r\n", "\n"));
  await fs.rename(path.join(f.root, "bin/docker"), path.join(f.root, "bin/docker-original"));
  await fs.writeFile(path.join(f.root, "bin/docker"), `#!/usr/bin/env bash
case "$*" in
  *'admin user list') printf 'ID Username\n1 forgeadmin\n2 sitebot\n'; exit 0 ;;
  *'generate-access-token'*) printf 'fixture-refreshed-token'; exit 0 ;;
esac
exec "$PWD/bin/docker-original" "$@"
`, { mode: 0o755 });
  const run = (args: string[]) => exec(bash, ["-c", 'export PATH="$PWD/bin:$PATH"; bash scripts/setup.sh >/dev/null; bash scripts/bootstrap-forgejo.sh "$@"', "test", ...args], { cwd: f.root, env: f.baseEnv });
  await run(["--no-restart-bot"]);
  assert.equal(await f.read("secrets/forgejo-token"), "fixture-refreshed-token\n");
  assert.equal(await f.read("secrets/forgejo-admin-token"), "fixture-refreshed-token\n");
  assert.ok(!(await f.calls()).includes("compose restart bot"));
  await run([]);
  assert.equal((await f.calls()).match(/compose restart bot/g)?.length, 1);
});

test("piped installation reads prompts from the terminal and hides the token", { skip: process.platform === "win32", timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  // Simulate a missing dependency. The package-manager stub proves that the
  // answer reaches the installer without changing the test host's packages.
  await fs.writeFile(path.join(f.root, "shell-env"), `command() {
    if [[ "$*" == '-v jq' && ! -f "$PWD/jq-installed" ]]; then return 1; fi
    builtin command "$@"
  }\n`);
  await fs.writeFile(path.join(f.root, "bin/apt-get"), '#!/usr/bin/env bash\nprintf installed > jq-installed\n', { mode: 0o755 });
  await fs.writeFile(path.join(f.root, "bin/sudo"), '#!/usr/bin/env bash\nexec "$@"\n', { mode: 0o755 });
  const command = 'export PATH="$PWD/bin:$PATH"; cat scripts/caddy-quickstart.sh | bash -s -- --domain example.com';
  const child = spawn("script", ["-qefc", command, "/dev/null"], { cwd: f.root, env: { ...f.baseEnv, BASH_ENV: path.join(f.root, "shell-env") }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { child.kill(); });
  const responses = [
    ["Install missing tools (jq)", "y"],
    ["Discord bot token (", token],
    ["Discord server ID (", "223456789012345678"],
    ["Extra admin user IDs,", ""],
    ["Builder model (", ""],
    ["API key for opencode (", ""],
  ];
  let output = "";
  let index = 0;
  const accept = (chunk: Buffer) => {
    output += chunk.toString();
    if (index < responses.length && output.includes(responses[index][0])) {
      const answer = responses[index++][1];
      // Allow read -s to disable echo after printing its prompt.
      setTimeout(() => child.stdin.write(`${answer}\n`), 30);
    }
  };
  child.stdout.on("data", accept);
  child.stderr.on("data", accept);
  const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  assert.equal(code, 0, output);
  assert.equal(index, responses.length);
  assert.ok(!output.includes(token), "terminal must not echo the bot token");
  assert.equal(await f.setting("DISCORD_BOT_TOKEN"), token);
  assert.equal(await f.setting("DISCORD_GUILD_ID"), "223456789012345678");
  assert.equal(await f.read("jq-installed"), "installed");
  assert.ok((await f.calls()).includes("compose logs --no-color bot"));
});
