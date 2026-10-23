import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../../bot/package.json", import.meta.url));
const { OpenCode } = await import(pathToFileURL(require.resolve("@opencode/client")).href);

// Optional smoke test against the pinned OpenCode image, without spending LLM
// tokens. A mock OpenAI-compatible provider requests the real MCP screenshot and
// checks the next model request contains the actual image bytes.
export async function checkOpenCodeImageDelivery({ docker, network, root }) {
  console.log("Checking screenshot delivery through OpenCode...");
  let step = 0;
  let receivedImage = false;
  let requestFailure;
  const provider = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const names = (body.tools || []).map((tool) => tool.function?.name);
      const hasBrowser = names.includes("playwright_browser_navigate");
      let delta = { role: "assistant", content: "Preview test" };
      let finish = "stop";
      if (hasBrowser) {
        if (step < 2) {
          const name = step === 0 ? "playwright_browser_navigate" : "playwright_browser_take_screenshot";
          assert.ok(names.includes(name), `${name} must be offered by OpenCode`);
          delta = { role: "assistant", tool_calls: [{ index: 0, id: `call_${step}`, type: "function", function: {
            name, arguments: JSON.stringify(step === 0 ? { url: "http://127.0.0.1:8080/100/200/" } : {}),
          } }] };
          finish = "tool_calls";
        } else {
          receivedImage = body.messages.some((message) => Array.isArray(message.content) && message.content.some((part) =>
            part.type === "image_url" && /^data:image\/(png|jpeg);base64,/.test(part.image_url?.url || "")));
          assert.ok(receivedImage, "OpenCode must send actual MCP screenshot bytes to the vision model");
          delta = { role: "assistant", content: "Screenshot received by the model." };
        }
        step++;
      }
      const chunk = (change, reason) => ({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1,
        model: body.model, choices: [{ index: 0, delta: change, finish_reason: reason }] });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
      res.end(`data: ${JSON.stringify({ ...chunk({}, finish), usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      requestFailure = error;
      res.writeHead(500); res.end(error.message);
    }
  });
  await new Promise((resolve) => provider.listen(0, "0.0.0.0", resolve));
  let container;
  try {
    const config = {
      default_agent: "sitebuilder", snapshots: false,
      permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "playwright_*", resource: "*", effect: "allow" }],
      agents: { sitebuilder: { mode: "primary", system: "Call the requested browser tools, then finish.", steps: 5,
        model: "wiretest/vision-fixture" } },
      providers: { wiretest: { package: "@ai-sdk/openai-compatible", settings: {
        baseURL: `http://host.docker.internal:${provider.address().port}/v1`, apiKey: "fixture-only",
      }, models: { "vision-fixture": { name: "Vision fixture",
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] }, limit: { context: 100_000, output: 2048 } } } } },
      mcp: { servers: { playwright: { type: "remote", url: "http://preview:8931/mcp", oauth: false,
        codemode: false, timeout: { startup: 90000, catalog: 90000, execution: 90000 } } } },
    };
    const configFile = path.join(root, "wire-config.json");
    await fs.writeFile(configFile, JSON.stringify(config));
    container = await docker("run", "-d", "--rm", "--init", "--network", network,
      "-p", "127.0.0.1::4096", "--mount", `type=bind,source=${root},target=/workspace`,
      "--mount", `type=bind,source=${configFile},target=/root/.config/opencode/opencode.json,readonly`,
      process.env.PREVIEW_TEST_OPENCODE_IMAGE,
      "opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096");
    const port = (await docker("port", container, "4096/tcp")).split(":").at(-1);
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; ; attempt++) {
      try { const response = await fetch(`${base}/api/info`, { signal: AbortSignal.timeout(3000) }); if (response.ok) break; } catch {}
      if (attempt > 120) throw new Error("OpenCode did not start");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    console.log("OpenCode started; creating fixture session...");
    const client = OpenCode.make({ baseUrl: base });
    const session = await client.session.create({ location: { directory: "/workspace/100/200" },
      title: "Preview delivery test", agent: "sitebuilder", model: { providerID: "wiretest", id: "vision-fixture" } },
    { signal: AbortSignal.timeout(90_000) });
    assert.ok(session.id, JSON.stringify(session));
    console.log("Fixture session created; requesting browser screenshot...");
    await client.session.prompt({ sessionID: session.id, text: "Open the preview, take a screenshot and inspect it.", delivery: "queue" });
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(120_000) });
    const result = (await client.message.list({ sessionID: session.id, order: "desc", limit: 50 })).data;
    if (requestFailure) throw requestFailure;
    assert.ok(receivedImage, `Image never reached provider; steps=${step}; result=${JSON.stringify(result).slice(0, 3000)}`);
    assert.match(JSON.stringify(result), /Screenshot received by the model/);
    console.log("PASS: OpenCode forwards Playwright MCP screenshots as image input to the vision provider.");
  } catch (error) {
    if (container) console.error(await docker("logs", container));
    throw error;
  } finally {
    if (container) await docker("rm", "-f", container).catch(() => {});
    await new Promise((resolve) => provider.close(resolve));
  }
}
