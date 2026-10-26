import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { applyProviderConfig, readProviderConfig, scrubProviderCredentials } from "./provider-config.mjs";
import { applyRuntimeConfig } from "./runtime-config.mjs";
import { buildV2Config } from "./v2/config.mjs";

const templatePath = "/opt/threadsite/opencode.base.json";
const outputPath = "/root/.config/opencode/opencode.json";

let config = applyRuntimeConfig(JSON.parse(await readFile(templatePath, "utf8")));
console.log(`[threadsite] Builder step limit: ${config.agents.sitebuilder.steps}`);
const defaults = JSON.parse(await readFile(new URL("./providers.json", import.meta.url), "utf8"));
const host = await readProviderConfig("/etc/threadsite/opencode/providers.json");
config.providers = { ...defaults.providers, ...config.providers };
config = await applyProviderConfig(config, host, {
  defaultCatalogs: defaults.catalogs,
  defaultContextCaps: defaults.contextCaps,
  env: process.env,
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
});
// The written config must contain references only; the literals travel in the
// server environment, which spawned tool shells never inherit.
const serverCredentials = scrubProviderCredentials(config);

config = buildV2Config(config);

await mkdir("/root/.config/opencode", { recursive: true });
await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

const logLevel = (process.env.OPENCODE_LOG_LEVEL || "INFO").toLowerCase();
const child = spawn("opencode", ["--print-logs", "--log-level", logLevel, "serve", "--hostname", "0.0.0.0", "--port", "4096"], {
  stdio: "inherit",
  env: { ...process.env,
    ...serverCredentials,
    XDG_DATA_HOME: `${process.env.XDG_DATA_HOME || "/opencode-data"}/v2`,
    OPENCODE_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD,
  },
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
