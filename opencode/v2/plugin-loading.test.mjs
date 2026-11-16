import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Exercise the real local-directory resolver: importing plugin.mjs directly
// misses packaging failures where the native service silently skips the plugin.
test("the native CLI activates the runtime from a local plugin directory", {
  skip: !process.env.OPENCODE_V2_BINARY, timeout: 40000,
}, async (t) => {
  for (const asUrl of [false, true]) await t.test(asUrl ? "file URL" : "absolute path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-plugin-loading-"));
    const plugin = asUrl ? pathToFileURL(import.meta.dirname).href : import.meta.dirname;
    const configFile = path.join(root, "opencode.json");
    await fs.writeFile(configFile, JSON.stringify({ plugins: [{ package: plugin }], mcp: { servers: {} } }));
    let child;
    try {
      child = spawn(process.env.OPENCODE_V2_BINARY, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
        cwd: root, stdio: ["ignore", "pipe", "pipe"], env: {
          ...process.env, OPENCODE_PASSWORD: "plugin-test-only", OPENCODE_CONFIG: configFile,
          OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_TEST_HOME: root,
          XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
        },
      });
      let output = "";
      let spawnError;
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("error", (error) => { spawnError = error; });
      const deadline = Date.now() + 15000;
      const headers = { Authorization: `Basic ${Buffer.from("opencode:plugin-test-only").toString("base64")}` };
      let runtime;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        assert.equal(child.exitCode, null, "the native service must stay running");
        const address = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (address) {
          const query = new URLSearchParams({ "location[directory]": root });
          const response = await fetch(`${address}/api/plugin?${query}`, { headers, signal: AbortSignal.timeout(3000) });
          assert.equal(response.status, 200);
          const { data } = await response.json();
          runtime = data.find((entry) => entry.id === "threadsite.v2");
          if (runtime?.state.status === "active") break;
          assert.notEqual(runtime?.state.status, "failed", JSON.stringify(runtime));
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(runtime?.state.status, "active", "the native directory resolver must load and set up the runtime");
      assert.equal(runtime.source.type, "local");
      assert.equal(runtime.features.server, true);
    } finally {
      if (child && child.exitCode === null && child.pid) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
