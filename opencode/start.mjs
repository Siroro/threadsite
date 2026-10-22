import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { buildSurplusProvider } from "./surplus-adapter.mjs";
import { applyRuntimeConfig } from "./runtime-config.mjs";
import { buildV2Config } from "./v2/config.mjs";

const templatePath = "/opt/threadsite/opencode.base.json";
const outputPath = "/root/.config/opencode/opencode.json";

let config = applyRuntimeConfig(JSON.parse(await readFile(templatePath, "utf8")));
const v2 = process.env.OPENCODE_API_VERSION === "v2";
console.log(`[threadsite] Builder step limit: ${config.agent.sitebuilder.maxSteps}`);
const surplus = await buildSurplusProvider({
  env: process.env,
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
});

config.provider ||= {};
config.provider.surplus = surplus.provider;
if (v2) config = buildV2Config(config);

await mkdir("/root/.config/opencode", { recursive: true });
await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

console.log(
  `[threadsite] Surplus provider configured with ${Object.keys(surplus.provider.models).length} model id(s)` +
    (surplus.contextCap ? ` and a ${surplus.contextCap}-token context cap (auto-compaction ceiling).` : " without a context cap."),
);

const logLevel = (process.env.OPENCODE_LOG_LEVEL || "INFO")[v2 ? "toLowerCase" : "toUpperCase"]();
const child = spawn("opencode", ["--print-logs", "--log-level", logLevel, "serve", "--hostname", "0.0.0.0", "--port", "4096"], {
  stdio: "inherit",
  env: v2 ? { ...process.env,
    // Isolate v2 state so rollback never hands a v1 process a v2 database.
    XDG_DATA_HOME: `${process.env.XDG_DATA_HOME || "/opencode-data"}/v2`,
    OPENCODE_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD,
  } : process.env,
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
