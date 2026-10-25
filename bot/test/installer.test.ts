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

async function runInteractive(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, responses: [string, string][], command = 'export PATH="$PWD/bin:$PATH"; cat scripts/caddy-quickstart.sh | bash', env: NodeJS.ProcessEnv = {}) {
  const child = spawn("script", ["-qefc", command, "/dev/null"], { cwd: f.root, env: { ...f.baseEnv, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { child.kill(); });
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
  return output;
}

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
  const responses: [string, string][] = [
    ["Install missing tools (jq)", "y"],
    ["Games hostname (", ""],
    ["Discord bot token (", token],
    ["Discord server ID (", "223456789012345678"],
    ["Extra admin user IDs,", ""],
    ["Builder model (", ""],
    ["API key for opencode (", ""],
  ];
  const output = await runInteractive(t, f, responses, 'export PATH="$PWD/bin:$PATH"; cat scripts/caddy-quickstart.sh | bash -s -- --domain example.com', { BASH_ENV: path.join(f.root, "shell-env") });
  assert.ok(!output.includes(token), "terminal must not echo the bot token");
  assert.equal(await f.setting("DISCORD_BOT_TOKEN"), token);
  assert.equal(await f.setting("DISCORD_GUILD_ID"), "223456789012345678");
  assert.equal(await f.read("jq-installed"), "installed");
  assert.ok((await f.calls()).includes("compose logs --no-color bot"));
});

test("interactive setup needs no flags for custom hostnames, optional games hosting and private provider credentials", { skip: process.platform === "win32", timeout: 45_000 }, async (t) => {
  for (const gamesHost of ["", "games.example.net"]) {
    const f = await fixture(t);
    const key = "private-interactive-provider-key";
    const command = gamesHost
      ? 'export PATH="$PWD/bin:$PATH"; cat scripts/caddy-quickstart.sh | bash'
      : 'export PATH="$PWD/bin:$PATH"; bash scripts/caddy-quickstart.sh';
    const output = await runInteractive(t, f, [
      ["Sites hostname (", "lab.example.co.uk"],
      ["Git hostname (", "git.example.co.uk"],
      ["Games hostname (", gamesHost],
      ["Discord bot token (", token],
      ["Discord server ID (", "223456789012345678"],
      ["Extra admin user IDs,", "323456789012345678"],
      ["Builder model (", "openai/coder"],
      ["API key for openai (", key],
    ], command);
    assert.equal(await f.setting("PUBLIC_SITES_BASE_URL"), "https://lab.example.co.uk");
    assert.equal(await f.setting("FORGEJO_PUBLIC_URL"), "https://git.example.co.uk");
    assert.equal(await f.setting("GAMESERVER_PUBLIC_URL"), `wss://${gamesHost || "lab.example.co.uk"}/ws`);
    assert.equal(await f.setting("DISCORD_ADMIN_USER_IDS"), "323456789012345678");
    assert.equal(await f.setting("OPENCODE_DEFAULT_MODEL"), "openai/coder");
    assert.equal(await f.setting("OPENAI_API_KEY"), key);
    assert.ok(!output.includes(token) && !output.includes(key));
    assert.ok((await f.calls()).includes("compose logs --no-color bot"));
  }
});

test("interactive reruns retain saved settings and allow switching games back to the sites hostname", { skip: process.platform === "win32", timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  await f.run([...f.args, "--games-domain", "games.example.com"]);
  await runInteractive(t, f, [
    ["Sites hostname (", ""],
    ["Git hostname (", ""],
    ["Games hostname (", "-"],
    ["Discord server ID (", ""],
    ["Extra admin user IDs,", ""],
    ["Builder model (", ""],
    ["API key for opencode (", ""],
  ]);
  assert.equal(await f.setting("DISCORD_BOT_TOKEN"), token);
  assert.equal(await f.setting("PUBLIC_SITES_BASE_URL"), "https://sites.example.com");
  assert.equal(await f.setting("FORGEJO_PUBLIC_URL"), "https://git.example.com");
  assert.equal(await f.setting("GAMESERVER_PUBLIC_URL"), "wss://sites.example.com/ws");
  await assert.rejects(fs.access(path.join(f.root, "caddy/vhosts/games.caddy")), { code: "ENOENT" });
});
