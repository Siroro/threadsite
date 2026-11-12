import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRuntimeConfig } from "../../opencode/runtime-config.mjs";

test("builder step budget defaults to 200 and accepts a validated environment override", () => {
  for (const value of [undefined, "", "  "]) {
    const config = applyRuntimeConfig({ agents: { sitebuilder: { steps: 120 }, titler: { steps: 1 } } }, { OPENCODE_MAX_STEPS: value });
    assert.equal(config.agents.sitebuilder.steps, 200);
    assert.equal(config.agents.titler.steps, 1);
  }
  const config = applyRuntimeConfig({ agents: { sitebuilder: { system: "Keep this prompt" } } }, { OPENCODE_MAX_STEPS: " 350 " });
  assert.equal(config.agents.sitebuilder.steps, 350);
  assert.equal(config.agents.sitebuilder.system, "Keep this prompt");
  for (const value of ["0", "-1", "1.5", "200junk", "Infinity", "1e3", "9007199254740992"]) {
    assert.throws(() => applyRuntimeConfig({}, { OPENCODE_MAX_STEPS: value }), /OPENCODE_MAX_STEPS must be a positive integer/);
  }
});
