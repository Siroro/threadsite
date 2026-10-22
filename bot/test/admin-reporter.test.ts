import test from "node:test";
import assert from "node:assert/strict";
import type { Client } from "discord.js";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
process.env.DISCORD_ERROR_REPORT_USER_IDS = "123456789012345678";
process.env.ERROR_DM_ENABLED = "1";
const { AdminReporter } = await import("../src/admin-reporter.js");

function capturingClient(): { client: Client; sent: string[] } {
  const sent: string[] = [];
  const client = {
    users: {
      fetch: async () => ({ send: async (body: string) => { sent.push(body); } }),
    },
  } as unknown as Client;
  return { client, sent };
}

test("admin incident DMs keep the error, cause and stack when context is large", async () => {
  const { client, sent } = capturingClient();
  const reporter = new AdminReporter(client);
  const context: Record<string, unknown> = {};
  // Twelve long entries: previously this pushed the error/cause/stack past the
  // 1950-character slice, so the DM arrived without the failure details.
  for (let index = 0; index < 12; index += 1) context[`key${index}`] = "x".repeat(220);
  const delivered = await reporter.notify({
    id: "inc-test", timestamp: "2026-10-22T00:00:00.000Z",
    message: "THE_ERROR_MESSAGE", details: { cause: "THE_CAUSE" }, stack: "THE_STACK", context,
  });
  assert.equal(delivered, true);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes("THE_ERROR_MESSAGE"), "error survives a large context block");
  assert.ok(sent[0].includes("THE_CAUSE"), "cause survives a large context block");
  assert.ok(sent[0].includes("THE_STACK"), "stack survives a large context block");
  assert.ok(sent[0].length <= 1950, "the DM stays within Discord's message limit");
  assert.ok(sent[0].includes("key0"), "context still leads the report");
});
