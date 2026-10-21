import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { applyRuntimeConfig } from "../../opencode/runtime-config.mjs";

test("builder step budget defaults to 200 and accepts a validated environment override", () => {
  for (const value of [undefined, "", "  "]) {
    const config = applyRuntimeConfig({ agent: { sitebuilder: { maxSteps: 120 }, titler: { maxSteps: 1 } } }, { OPENCODE_MAX_STEPS: value });
    assert.equal(config.agent.sitebuilder.maxSteps, 200);
    assert.equal(config.agent.titler.maxSteps, 1);
  }
  const config = applyRuntimeConfig({ agent: { sitebuilder: { prompt: "Keep this prompt" } } }, { OPENCODE_MAX_STEPS: " 350 " });
  assert.equal(config.agent.sitebuilder.maxSteps, 350);
  assert.equal(config.agent.sitebuilder.prompt, "Keep this prompt");
  for (const value of ["0", "-1", "1.5", "200junk", "Infinity", "1e3", "9007199254740992"]) {
    assert.throws(() => applyRuntimeConfig({}, { OPENCODE_MAX_STEPS: value }), /OPENCODE_MAX_STEPS must be a positive integer/);
  }
});

// A cold Chromium launch plus a software-rendered (SwiftShader) WebGL canvas
// takes well over the old 10s action / 30s navigation defaults: screenshots
// failed with "Timeout 10000ms exceeded" and navigations hit the OpenCode MCP
// client's 30s request timeout as a bare -32001 before Playwright could report
// anything. These floors keep both from regressing.
const MIN_ACTION_TIMEOUT_MS = 30_000;
const MIN_NAVIGATION_TIMEOUT_MS = 45_000;

test("preview browser timeouts cover cold launches and software-rendered canvases", async () => {
  const config = JSON.parse(await fs.readFile(new URL("../browser-config.json", import.meta.url), "utf8"));
  const { action, navigation } = config.timeouts ?? {};
  assert.ok(action >= MIN_ACTION_TIMEOUT_MS,
    `browser action timeout (${action}ms) must be at least ${MIN_ACTION_TIMEOUT_MS}ms for screenshots`);
  assert.ok(navigation >= MIN_NAVIGATION_TIMEOUT_MS,
    `browser navigation timeout (${navigation}ms) must be at least ${MIN_NAVIGATION_TIMEOUT_MS}ms for cold starts`);
});

test("the browser is kept warm instead of closing when idle", async () => {
  const config = JSON.parse(await fs.readFile(new URL("../browser-config.json", import.meta.url), "utf8"));
  // start.mjs holds a session open at boot so the shared browser is already
  // launched for the first real client. Playwright's default is to close a
  // headless browser after an hour without tool calls, which would silently
  // bring the cold start back on the next turn; 0 disables that.
  assert.equal(config.timeouts?.idle, 0,
    "timeouts.idle must be 0, otherwise the warmed browser is closed after an idle hour");
  assert.equal(config.browser?.isolated, true,
    "isolated:true is what shares one browser process across clients while keeping per-client contexts");
});

test("the OpenCode MCP client waits longer than the browser's own timeouts", async () => {
  const [opencode, browser] = await Promise.all([
    fs.readFile(new URL("../../opencode/opencode.json", import.meta.url), "utf8"),
    fs.readFile(new URL("../browser-config.json", import.meta.url), "utf8"),
  ]);
  const clientTimeout = JSON.parse(opencode).mcp?.playwright?.timeout;
  const navigation = JSON.parse(browser).timeouts?.navigation;
  assert.ok(clientTimeout > navigation,
    `MCP client timeout (${clientTimeout}ms) must exceed the browser navigation timeout (${navigation}ms), `
    + "otherwise the client aborts with a bare -32001 before Playwright can report the real error");
});
