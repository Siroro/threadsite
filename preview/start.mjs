import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPreviewServer } from "./server.mjs";

// The only ThreadSite-specific code is the static TypeScript preview server.
// Microsoft Playwright MCP owns browser sessions, interactions and image results.
const server = createPreviewServer({ workspaceRoot: process.env.WORKSPACE_ROOT || "/workspace" });
await new Promise((resolve) => server.listen(8080, "127.0.0.1", resolve));
const child = spawn(process.execPath, [
  fileURLToPath(new URL("./cli.js", import.meta.resolve("@playwright/mcp"))),
  "--config", fileURLToPath(new URL("./browser-config.json", import.meta.url)),
  "--port", "8931", "--host", "0.0.0.0", "--allowed-hosts", "preview:8931,localhost:8931,127.0.0.1:8931",
], { stdio: "inherit", cwd: "/tmp" });

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error(error); server.close(); process.exitCode = 1; });
child.on("exit", (code) => { server.close(); process.exit(code ?? 1); });
