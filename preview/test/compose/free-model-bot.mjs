import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { OpenCode } from "@opencode/client";
import { OpenCodeHarness } from "./dist/opencode.js";
import { ProjectService } from "./dist/project.js";
import { ForgejoClient } from "./dist/forgejo.js";
import { Store } from "./dist/store.js";
import { UsageLog } from "./dist/usage.js";
import { config } from "./dist/config.js";

const client = OpenCode.make({ baseUrl: config.opencodeUrl,
  headers: { Authorization: `Basic ${Buffer.from(`opencode:${config.opencodePassword}`).toString("base64")}` } });
const catalog = (await client.model.list()).data;
await fs.writeFile("/artifacts/catalog.json", JSON.stringify(catalog, null, 2));
const free = catalog.filter((model) => model.providerID === "opencode" && model.enabled
  && model.capabilities.tools && model.cost.length > 0 && model.cost.every((tier) =>
    tier.input === 0 && tier.output === 0 && (!tier.cache || Object.values(tier.cache).every((cost) => cost === 0))));
console.log(`Free catalog: ${JSON.stringify(free.map((m) => ({ id: m.id, input: m.capabilities.input, cost: m.cost })))}`);
assert.ok(free.length >= 2, "Need two currently available, zero-cost, tool-capable models");
const chosen = ["mimo-v2.6-flash-free", "glm-5.3-flash-free"].map((id) => free.find((model) => model.id === id));
assert.ok(chosen.every(Boolean), "Expected free test models are unavailable; choose replacements explicitly");
const harness = new OpenCodeHarness();
assert.match(await harness.health(), /^ok/);
const forgejo = new ForgejoClient();
const store = await Store.open(config.stateDbFile);
const ledger = new UsageLog(config.usageLogFile);
const service = new ProjectService(store, harness, forgejo, ledger, async (project, title) => {
  // Simulate the Discord acknowledgement without logging in or sending messages.
  console.log(`Thread name acknowledged ${project.threadId}: ${title}`);
});
const report = [];
const answered = new Set();
async function assertRemoteHead(project) {
  // Forgejo's post-receive queue updates its branch inventory after Git accepts
  // a push. Observe convergence after creation/rename rather than racing it.
  let remote;
  for (let attempt = 0; attempt < 40; attempt++) {
    remote = await forgejo.mainCommitSha(project.repoName);
    if (remote === project.lastSeenCommit) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Forgejo branch inventory did not converge: ${project.repoName}, expected ${project.lastSeenCommit}, got ${remote}`);
}
const timer = setTimeout(async () => {
  console.error("Live test exceeded 20 minutes; stopping isolated sessions");
  for (const project of store.listProjects()) if (project.sessionId) await harness.abortTurn(project.workspacePath, project.sessionId).catch(() => {});
}, 20 * 60 * 1000);
try {
  for (const [index, model] of chosen.entries()) {
    const threadId = String(200 + index);
    const kind = index === 0 ? "site" : "game-3d";
    const modelID = `opencode/${model.id}`;
    await store.setModel(modelID);
    const tools = [];
    let lastNarration = "";
    let steered = false;
    let steeringDelivered = false;
    const progress = async (update) => {
      if (update.tool) {
        tools.push(update.tool);
        if (update.tool.status !== "running") console.log(`Tool ${threadId}: ${update.tool.name} ${update.tool.status}`);
        if (index === 0 && !steered && update.tool.name === "write" && update.tool.status === "completed") {
          steered = true;
          const delivered = await harness.steer(`/workspace/100/${threadId}`, store.getProject(threadId).sessionId,
            "Integration verification for the current task: before finishing, perform the required Context7 calls, use Playwright to navigate the current preview, click Add one twice, verify count 2, take a screenshot and close the browser. Do not start another task or add optional features.");
          await fs.writeFile(`/artifacts/${threadId}-steering.json`, JSON.stringify({ delivered }));
          steeringDelivered = delivered;
          assert.equal(delivered, true);
        }
      }
      if (update.phase) console.log(`Phase ${threadId}: ${update.phase}`);
      if (update.kind === "thought" && update.text.slice(0, 350) !== lastNarration) {
        lastNarration = update.text.slice(0, 350);
        console.log(`Agent ${threadId}: ${lastNarration}`);
      }
      if (update.question && !update.question.resolved && !answered.has(update.question.requestID)) {
        answered.add(update.question.requestID);
        await harness.replyToQuestion(`/workspace/100/${threadId}`, update.question.requestID,
          update.question.questions.map((q) => [q.options[0]?.label || "Blue"]));
      }
    };
    console.log(`Checking ${kind} using ${modelID} (vision=${model.capabilities.input.includes("image")})`);
    const request = index === 0
      ? `Build a small static website called Counter Lab. Put a visible heading Counter Lab, a button with id="increment" labelled Add one, and an output with id="count" initially showing 0. Each click increments by exactly 1. Responsive navy/teal design; no network assets. Use concise source and simple styling; this is a functional integration fixture. Before implementing, ask one question using the question tool with Blue and Green options (the test harness will answer Blue). Demonstrate live TypeScript diagnostics by writing site/src/lsp-probe.ts containing export const probe: number = "wrong"; observe the error, then fix it to export const probe: number = 1;. Use lsp hover on probe (line 1, character 14 if there is no header comment). Use Context7 resolve-library-id and query-docs once each for TypeScript DOM click events, unless unavailable. Delegate a READ-ONLY inspection of just lsp-probe.ts to general: request one sentence, at most two tool calls, no additional exploration. Write DESCRIPTION.md and CHANGELOG.md, complete a three-item todo plan, run the prescribed compiler check and finish with a brief report. Batch independent operations; avoid optional refinements.`
      : `Build a tiny singleplayer Three.js game called Orbit Lab. Show a visible coloured 3D cube, ground, lights, camera and the heading Orbit Lab. A button id="increment" labelled Rotate advances the cube by exactly 45 degrees and increments output id="count" from 0 by 1. Also support ArrowRight. Make the first frame visible immediately. Add concise instructions and responsive layout. No external assets/network, no physics dependency or multiplayer. Use lsp hover on a Three.js symbol to inspect the installed types. Use Context7 resolve-library-id and query-docs for Three.js geometry if available, at most three calls total. Write DESCRIPTION.md and CHANGELOG.md, run the prescribed compiler check and finish. Keep the scope small.`;
    const result = await service.createProject({ threadId, guildId: "100", parentChannelId: "100", displayName: index === 0 ? "Counter Lab" : "Orbit Lab",
      projectKind: kind, multiplayerMode: "singleplayer", initialPrompt: request, renameable: index === 0,
      initiator: { name: "Integration Test", email: "integration@example.invalid" } }, progress);
    const { screenshot, ...summary } = result;
    await fs.writeFile(`/artifacts/${threadId}-result.json`, JSON.stringify(summary, null, 2));
    assert.equal(result.validationError, undefined, result.validationError);
    assert.equal(result.deliveryError, undefined, result.deliveryError);
    assert.ok(result.commit && result.files > 0, "The agent's source must be committed and published");
    assert.ok(result.usage.inputTokens > 0 && result.usage.outputTokens > 0);
    assert.equal(result.usage.cost, 0, "Only free inference is authorized");
    await assertRemoteHead(result.project);
    const live = await fetch(`http://static-web/${result.project.siteSlug}/`);
    assert.equal(live.status, 200);
    assert.match(await live.text(), /id=["']increment["']/);
    assert.equal((await fetch(`http://static-web/${result.project.siteSlug}/src/main.ts`)).status, 404);
    if (screenshot) await fs.writeFile(`/artifacts/${threadId}-qa.png`, screenshot);
    let project = store.getProject(threadId);
    const messages = await harness.listMessages(project.workspacePath, project.sessionId);
    await fs.writeFile(`/artifacts/${threadId}-messages.json`, JSON.stringify(messages, null, 2));
    const completed = messages.flatMap((message) => message.parts ?? []).filter((part) => part.type === "tool" && part.state?.status === "completed");
    const names = completed.map((part) => part.tool);
    assert.ok(names.includes("lsp"), "The real model must successfully use LSP");
    if (index === 0) {
      assert.ok(steered && steeringDelivered, "The live turn must accept a non-resuming steering update");
      for (const name of ["question", "subagent", "context7_resolve-library-id", "context7_query-docs"]) assert.ok(names.includes(name), `Missing completed ${name}`);
      assert.match(JSON.stringify(messages), /LSP errors detected/);
      assert.match(await fs.readFile(path.join(project.workspacePath, "site/src/lsp-probe.ts"), "utf8"), /number\s*=\s*1/);
      assert.ok(answered.size > 0);
      console.log(`Checking same-session revision using ${modelID}`);
      const revised = await service.mutate(threadId, 'Add a Reset button id="reset" that resets #count to 0. Keep Add one incrementing by exactly 1. Update CHANGELOG.md, check the compiler and finish.', false, progress);
      assert.equal(revised.validationError, undefined);
      assert.equal(revised.deliveryError, undefined);
      assert.ok(revised.commit && revised.commit !== result.commit);
      assert.equal(revised.project.sessionId, project.sessionId);
      assert.equal(revised.usage.cost, 0);
      project = store.getProject(threadId);
      assert.equal((await ledger.threadTotal(threadId)).turns, 2);
    }
    assert.equal(project.pendingTurn, undefined);
    assert.equal(project.pendingNaming, undefined);
    assert.ok(!project.repoName.startsWith("site-"));
    assert.ok(result.description?.pitch && result.description?.play && result.changelog?.body, "Project documents must be read back");
    const deployedScript = await fetch(`http://static-web/${project.siteSlug}/js/main.js`);
    assert.equal(deployedScript.status, 200);
    const deployedHash = createHash("sha256").update(await deployedScript.text()).digest("hex");
    report.push({ threadId, kind, model: modelID, slug: project.siteSlug, sessionId: project.sessionId, deployedHash,
      commit: project.lastCommit, tools: [...new Set(names)], vision: model.capabilities.input.includes("image"), usage: await ledger.threadTotal(threadId) });
    await fs.writeFile("/artifacts/report.json", JSON.stringify(report, null, 2));
    console.log(`PASS ${kind}: real model, tool loop, typecheck, Git push, atomic publication, documents and durable usage`);
  }
} finally {
  clearTimeout(timer);
  store.close();
}
