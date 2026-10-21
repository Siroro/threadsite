import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

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
      $schema: "https://opencode.ai/config.json", model: "wiretest/vision-fixture", small_model: "wiretest/vision-fixture",
      permission: { "*": "deny", "playwright_*": "allow" },
      agent: { sitebuilder: { mode: "primary", prompt: "Call the requested browser tools, then finish.", steps: 5 } },
      provider: { wiretest: { npm: "@ai-sdk/openai-compatible", options: {
        baseURL: `http://host.docker.internal:${provider.address().port}/v1`, apiKey: "fixture-only",
      }, models: { "vision-fixture": { name: "Vision fixture", attachment: true,
        modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 100_000, output: 2048 } } } } },
      mcp: { playwright: { type: "remote", url: "http://preview:8931/mcp", oauth: false, timeout: 90000 } },
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
      try { const response = await fetch(`${base}/global/health`, { signal: AbortSignal.timeout(3000) }); if (response.ok) break; } catch {}
      if (attempt > 120) throw new Error("OpenCode did not start");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    console.log("OpenCode started; creating fixture session...");
    const directory = "?directory=%2Fworkspace%2F100%2F200";
    const session = await (await fetch(`${base}/session${directory}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Preview delivery test" }),
      signal: AbortSignal.timeout(90_000),
    })).json();
    assert.ok(session.id, JSON.stringify(session));
    console.log("Fixture session created; requesting browser screenshot...");
    const response = await fetch(`${base}/session/${session.id}/message${directory}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ agent: "sitebuilder", model: { providerID: "wiretest", modelID: "vision-fixture" },
        parts: [{ type: "text", text: "Open the preview, take a screenshot and inspect it." }] }),
    });
    const result = await response.json();
    if (requestFailure) throw requestFailure;
    assert.ok(receivedImage, `Image never reached provider; steps=${step}; result=${JSON.stringify(result).slice(0, 3000)}`);
    assert.match(JSON.stringify(result), /Screenshot received by the model/);
    console.log("PASS: real OpenCode 1.18.27 forwards Playwright MCP screenshots as image input to an OpenAI-compatible vision provider.");
  } catch (error) {
    if (container) console.error(await docker("logs", container));
    throw error;
  } finally {
    if (container) await docker("rm", "-f", container).catch(() => {});
    await new Promise((resolve) => provider.close(resolve));
  }
}
