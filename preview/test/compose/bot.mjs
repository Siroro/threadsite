import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { OpenCodeHarness } from "./dist/opencode.js";
import { buildSite } from "./dist/build.js";
import { validateSite, publishSite } from "./dist/publish.js";
import { ensureEnginePackages } from "./dist/engines.js";
import { ensureSkillFiles } from "./dist/skills.js";
import { projectAgents } from "./dist/templates.js";
import { cases, planFor } from "/fixtures/cases.mjs";

const harness = new OpenCodeHarness();
assert.match(await harness.health(), /^ok \(OpenCode 2\.[\w.-]+, v2\)$/);
for (const item of cases) {
  const workspace = `/workspace/100/${item.id}`;
  const site = path.join(workspace, "site");
  for (const dir of ["src", "css", "data", "assets"]) await fs.mkdir(path.join(site, dir), { recursive: true });
  await fs.writeFile(path.join(workspace, "AGENTS.md"), await projectAgents(item.kind));
  await fs.writeFile(path.join(site, "index.html"), "<!doctype html><html><body>Fixture starting</body></html>");
  await fs.writeFile(path.join(site, "about.html"), "<!doctype html><html><body><h1>About the Docker check</h1></body></html>");
  await fs.writeFile(path.join(site, "css", "main.css"), "body{margin:20px;background:#14213d;color:white;font:18px sans-serif}input,button{margin:10px;padding:8px}canvas{max-width:100%}");
  await fs.writeFile(path.join(site, "assets", "mark.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#33ddaa"/></svg>');
  await fs.writeFile(path.join(site, "data", "check.json"), JSON.stringify({ message: "Local data loaded" }));
  await ensureEnginePackages(workspace, item.kind);
  await ensureSkillFiles(workspace, item.kind);
  console.log(`Checking ${item.kind}: production bot harness -> OpenCode -> Playwright MCP`);
  const session = await harness.createSession(workspace, `Docker check: ${item.kind}`);
  let browserActivity = 0;
  const result = await harness.prompt(workspace, session,
    `THREADSITE_COMPOSE:${item.id} Build and test this ${item.kind} through the available tools.`,
    "surplus/compose-vision", (progress) => {
      if (/preview|browser/i.test(progress.text)) browserActivity++;
    });
  assert.match(result.text, /Docker build and browser check passed/);
  assert.ok(browserActivity > 0, "Bot must receive browser progress events");
  assert.ok(result.usage.inputTokens > 0 && result.usage.outputTokens > 0 && result.usage.cost > 0,
    "discovered model prices and provider token counts must reach bot billing");
  // The preview must never silently make the bot's final build for it.
  await assert.rejects(fs.stat(path.join(site, "js")), { code: "ENOENT" });
  const built = await buildSite(workspace);
  assert.ok(!built.skipped && built.emitted > 0);
  const stats = await validateSite(site);
  assert.ok(stats.files > 0 && stats.bytes > 0);
  const report = (await (await fetch("http://fixture:7070/report")).json())[item.id];
  assert.deepEqual(report.errors, []);
  assert.equal(report.step, planFor(item).length + 1);
  assert.equal(report.screenshots, 3, "Desktop/mobile/updated screenshot images must reach the model");
  assert.equal(report.hashes.length, 2);
  assert.notEqual(report.hashes[0], report.hashes[1], "Preview must actually rebuild edited source");
  const deployedHash = createHash("sha256").update(await fs.readFile(path.join(site, "js", "main.js"))).digest("hex");
  assert.equal(deployedHash, report.hashes[1], "Preview and real bot build must produce identical JS");
  const slug = `smoke-${item.kind}`;
  await publishSite(site, slug);
  const live = await fetch(`http://static-web/${slug}/`);
  assert.equal(live.status, 200);
  assert.match(await live.text(), /Docker browser check/);
  const script = await fetch(`http://static-web/${slug}/js/main.js`);
  assert.equal(script.status, 200);
  assert.ok((await script.text()).length > 100);
  assert.equal((await fetch(`http://static-web/${slug}/src/main.ts`)).status, 404);
  console.log(`PASS ${item.kind}: agent writes, current builds, local assets/data, form, navigation, scroll, keyboard, desktop/mobile images, clean console, identical deployment bundle, Apache publish`);
}
const failedSession = await harness.createSession("/workspace/100/200", "Docker failure check");
await assert.rejects(
  harness.prompt("/workspace/100/200", failedSession, "THREADSITE_COMPOSE_ERROR", "surplus/compose-vision"),
  /fixture provider terminal rejection/,
  "An HTTP 200 carrying a failed assistant must not be reported as a successful bot turn",
);
console.log("PASS: terminal provider errors reject the bot turn instead of publishing an empty success.");
const policySession = await harness.createSession("/workspace/100/200", "Model capability policy check");
for (const [marker, model] of [["text-first", "compose-text"], ["vision-after", "compose-vision"], ["text-again", "compose-text"]]) {
  const result = await harness.prompt("/workspace/100/200", policySession, `THREADSITE_POLICY:${marker}`, `surplus/${model}`);
  assert.match(result.text, new RegExp(`Policy checked: ${marker}`));
}
console.log("PASS: real provider requests contain no browser MCP tools for text models, and vision access returns on a model switch.");
const budgetSession = await harness.createSession("/workspace/100/200", "Force finish budget check");
const budgetResult = await harness.prompt("/workspace/100/200", budgetSession, "THREADSITE_POLICY:budget", "surplus/compose-text");
assert.match(budgetResult.text, /Force finish received/);
const policyReport = (await (await fetch("http://fixture:7070/report")).json()).policy;
assert.deepEqual(policyReport.checked, ["text-first", "vision-after", "text-again"]);
assert.equal(policyReport.steers, 1);
assert.ok(policyReport.budgetSteps >= 45 && policyReport.budgetSteps <= 50, JSON.stringify(policyReport));
console.log("PASS: a real running agent receives one force finish steer near its configured step limit and completes its original request.");
console.log("PASS: Docker Compose integration completed with production bot, OpenCode, preview and Apache images.");
