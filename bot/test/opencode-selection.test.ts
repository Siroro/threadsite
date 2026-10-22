import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const script = `
  const { config } = await import("./src/config.ts");
  const { OpenCodeHarness, LegacyOpenCodeHarness, OpenCodeV2Harness } = await import("./src/opencode.ts");
  console.log(JSON.stringify({ version: config.opencodeApiVersion,
    v2: OpenCodeHarness === OpenCodeV2Harness, v1: OpenCodeHarness === LegacyOpenCodeHarness }));
`;

test("the application defaults to native v2 and retains explicit v1 selection", async () => {
  for (const [setting, expected] of [[undefined, "v2"], ["", "v2"], ["v2", "v2"], ["v1", "v1"]] as const) {
    const env = { ...process.env, DISCORD_BOT_TOKEN: "test", DISCORD_APPLICATION_ID: "test" };
    delete env.OPENCODE_API_VERSION;
    if (setting !== undefined) env.OPENCODE_API_VERSION = setting;
    const result = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: new URL("../", import.meta.url), env,
    });
    assert.deepEqual(JSON.parse(result.stdout), { version: expected, v2: expected === "v2", v1: expected === "v1" });
  }
});
