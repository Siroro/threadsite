import http from "node:http";
import assert from "node:assert/strict";
import { cases, planFor } from "./cases.mjs";

const reports = Object.fromEntries(cases.map(item => [item.id, { step: 0, screenshots: 0, hashes: [], errors: [] }]));
reports.policy = { checked: [], budgetSteps: 0, steers: 0 };
const json = (res, body, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
http.createServer(async (req, res) => {
  if (req.url === "/report") return json(res, reports);
  assert.equal(req.headers.authorization, "Bearer fixture-only", "host provider credentials must reach discovery and inference");
  if (req.url === "/v1/models") return json(res, { data: [{
    id: "compose-vision", name: "Docker vision fixture", context_length: 200000, max_completion_tokens: 4096,
    architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["tools"],
    pricing: { prompt: "0.000002", completion: "0.000006", input_cache_read: "0.0000005" },
  }, {
    id: "compose-text", name: "Docker text-only fixture", context_length: 200000, max_completion_tokens: 4096,
    architecture: { input_modalities: ["text"] }, supported_parameters: ["tools"],
  }] });
  let report;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (JSON.stringify(body.messages).includes("THREADSITE_COMPOSE_ERROR")) {
      return json(res, { error: { message: "fixture provider terminal rejection (network unavailable)", type: "fixture_failure" } }, 400);
    }
    const names = (body.tools || []).map(tool => tool.function?.name);
    let delta = { role: "assistant", content: "Docker browser check" };
    let finish = "stop";
    const policy = [...JSON.stringify(body.messages).matchAll(/THREADSITE_POLICY:(text-first|text-again|vision-after|budget)/g)].at(-1)?.[1];
    if (policy && names.includes("read")) {
      const browserTools = names.filter(name => name.startsWith("playwright_"));
      if (body.model === "compose-text") assert.deepEqual(browserTools, [], "Text model was offered browser MCP tools");
      else assert.ok(browserTools.includes("playwright_browser_navigate"), "Vision model lost browser access after a model switch");
      if (policy === "budget") {
        reports.policy.budgetSteps++;
        // Slow the fixture slightly so a real async steering request can land mid-turn.
        await new Promise(resolve => setTimeout(resolve, 100));
        const steers = body.messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes("[THREADSITE_FORCE_FINISH]"));
        reports.policy.steers = steers.length;
        assert.ok(reports.policy.budgetSteps <= 50, "Agent never received the finish-up steer within its budget");
        if (!steers.length) {
          delta = { role: "assistant", tool_calls: [{ index: 0, id: `budget_${reports.policy.budgetSteps}`, type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: "site/index.html" }) } }] };
          finish = "tool_calls";
        } else delta = { role: "assistant", content: "Force finish received; current task finished." };
      } else {
        reports.policy.checked.push(policy);
        delta = { role: "assistant", content: `Policy checked: ${policy}` };
      }
    } else if (names.includes("playwright_browser_navigate")) {
      const match = JSON.stringify(body.messages).match(/THREADSITE_COMPOSE:(20[012])/);
      assert.ok(match, "Missing fixture marker");
      const item = cases.find(item => item.id === match[1]);
      report = reports[item.id];
      const plan = planFor(item);
      const lastTool = body.messages.filter(message => message.role === "tool").at(-1);
      const output = typeof lastTool?.content === "string" ? lastTool.content : JSON.stringify(lastTool?.content || "");
      assert.doesNotMatch(output, /### Error|Tool execution failed|permission.*denied/i);
      if (report.step > 0) {
        const previous = plan[report.step - 1][0];
        if (previous.endsWith("evaluate") && plan[report.step - 1][1].function.includes("bundleHash")) {
          assert.match(output, /"interaction":\s*"passed"/);
          const hash = output.match(/"bundleHash":\s*"([a-f0-9]{64})"/);
          assert.ok(hash, "Browser must report its real bundle hash"); report.hashes.push(hash[1]);
        }
        if (previous.endsWith("take_screenshot")) {
          const lastResultIndex = body.messages.findLastIndex(message => message.role === "tool");
          const image = body.messages.slice(lastResultIndex).some(message => Array.isArray(message.content) && message.content.some(part =>
            part.type === "image_url" && /^data:image\/(png|jpeg);base64,/.test(part.image_url?.url || "")));
          assert.ok(image, "Screenshot bytes did not reach the provider"); report.screenshots++;
        }
        if (previous.endsWith("console_messages")) assert.doesNotMatch(output, /\[ERROR\]/);
      }
      if (report.step < plan.length) {
        const [name, args] = plan[report.step];
        assert.ok(names.includes(name), `Production permissions did not expose ${name}`);
        delta = { role: "assistant", tool_calls: [{ index: 0, id: `call_${item.id}_${report.step}`, type: "function",
          function: { name, arguments: JSON.stringify(args) } }] };
        finish = "tool_calls";
      } else delta = { role: "assistant", content: `Docker build and browser check passed for ${item.kind}.` };
      report.step++;
    }
    const chunk = (change, reason) => ({ id: "chatcmpl-compose", object: "chat.completion.chunk", created: 1, model: body.model,
      choices: [{ index: 0, delta: change, finish_reason: reason }] });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
    res.end(`data: ${JSON.stringify({ ...chunk({}, finish), usage: { prompt_tokens: 1000, completion_tokens: 25, total_tokens: 1025 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    if (report) report.errors.push(error.message);
    console.error(error.message);
    json(res, { error: { message: error.message, type: "fixture_failure" } }, 400);
  }
}).listen(7070, "0.0.0.0", () => console.log("Fixture provider ready"));
