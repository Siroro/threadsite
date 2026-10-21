import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const { OpenCodeHarness } = await import("../src/opencode.js");
const { config } = await import("../src/config.js");
const { projectAgents, initialProjectInstruction } = await import("../src/templates.js");

function fixture() {
  const harness = new OpenCodeHarness();
  const stub = harness as any;
  stub.startEventStream = async () => undefined;
  stub.client.session.messages = async () => [];
  stub.client.session.todo = async () => [];
  stub.client.session.children = async () => [];
  stub.client.provider.list = async () => ({ data: { all: [{ id: "test", models: {
    vision: { capabilities: { input: { image: true } } },
    text: { attachment: true, capabilities: { input: { image: false, pdf: true } } },
  } }] } });
  return { harness, stub };
}

test("each prompt refreshes browser permissions from actual image capabilities, including model switches", async () => {
  const { harness, stub } = fixture();
  const offered: boolean[] = [];
  stub.client.session.prompt = async (body: any) => {
    offered.push(body.tools["playwright_*"]);
    return { parts: [{ type: "text", text: "done" }] };
  };
  for (const model of ["test/vision", "test/text", "test/unknown", "test/vision"]) {
    await harness.prompt("/w", "session", "work", model);
  }
  assert.deepEqual(offered, [true, false, false, true]);
  assert.equal(await harness.modelAcceptsAttachments("test", "text"), false, "PDF support must not imply vision");
});

test("force finish uses the running model and variant without aborting or granting a new turn", async () => {
  const { harness, stub } = fixture();
  const originalLimit = config.opencodeMaxSteps;
  config.opencodeMaxSteps = 10;
  let release!: (value: unknown) => void;
  const sent: any[] = [];
  let turn: any;
  stub.startEventStream = async (_directory: string, _session: string, _progress: unknown, state: unknown) => { turn = state; };
  stub.client.session.prompt = () => new Promise((resolve) => { release = resolve; });
  stub.client.session.status = async () => ({ session: { type: "busy" } });
  stub.client.session.promptAsync = async (body: unknown) => { sent.push(body); return {}; };
  try {
    const prompting = harness.prompt("/w", "session", "build", "test/text", undefined, "sitebuilder", "high");
    while (!release) await nextTick();
    stub.client.session.messages = async () => [{ info: {
      id: "latest", role: "assistant", providerID: "test", modelID: "text", variant: "high",
    } }];
    turn.childSessions.add("child");
    const finished = (session: string, i: number) => stub.handleEvent({ type: "message.part.updated", properties: { part: {
      sessionID: session, messageID: `${session}-${i}`, id: `${session}-part-${i}`, type: "step-finish", tokens: { input: 1, output: 1 },
    } } }, "/w", "session", undefined, turn);
    for (let i = 0; i < 20; i++) finished("child", i);
    for (let i = 0; i < 8; i++) { finished("session", i); finished("session", i); }
    assert.equal(sent.length, 0);
    finished("session", 8);
    for (let i = 0; i < 10 && !sent.length; i++) await nextTick();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].model, { providerID: "test", modelID: "text" });
    assert.equal(sent[0].variant, "high");
    assert.equal(sent[0].tools["playwright_*"], false);
    assert.match(sent[0].parts[0].text, /^\[THREADSITE_FORCE_FINISH\]/);
    release({ parts: [{ type: "text", text: "finished" }] });
    assert.equal((await prompting).text, "finished");
    assert.equal(stub.stepBudgets.size, 0);
  } finally { config.opencodeMaxSteps = originalLimit; }
});

test("both game dimensions get design guidance and the original collection request remains intact", async () => {
  for (const kind of ["game-2d", "game-3d"] as const) {
    const rules = await projectAgents(kind, undefined, true);
    assert.match(rules, /Do not default to a collection loop/);
    assert.match(rules, /Only make collection the main activity when the user explicitly requests it/);
    assert.match(rules, /Text-only models receive no browser MCP tools/);
    const prompt = initialProjectInstruction(kind, "Create a gem-collecting platformer");
    assert.match(prompt, /core action, challenge and player decisions/);
    assert.ok(prompt.endsWith("GAME REQUEST:\nCreate a gem-collecting platformer"));
  }
});

test("title generation is a bounded tools-free request and cleans up failed attempts", async () => {
  const { harness, stub } = fixture();
  stub.createSession = async () => "title-session";
  let aborted = 0;
  let deleted = 0;
  let requests = 0;
  stub.prompt = () => assert.fail("titles must not enter the builder reconciliation loop");
  stub.client.session.abort = async () => { aborted++; return {}; };
  stub.client.session.delete = async () => { deleted++; return {}; };
  stub.client.session.prompt = async (body: any, options: any) => {
    requests++;
    assert.deepEqual(body.tools, { "*": false });
    assert.equal(body.agent, "titler");
    assert.deepEqual(body.model, { providerID: "test", modelID: "backup" });
    assert.ok(options.signal instanceof AbortSignal);
    if (requests === 1) throw new Error("model timeout");
    return { info: { id: "title-message", role: "assistant", time: { created: Date.now() }, tokens: { input: 100, output: 5 } },
      parts: [{ type: "text", text: "Neon Drift" }] };
  };
  await assert.rejects(harness.generateTitle("/w", "Build a racing game", "test/backup"), /model timeout/);
  const result = await harness.generateTitle("/w", "Build a racing game", "test/backup");
  assert.equal(result.title, "Neon Drift");
  assert.equal(result.usage.inputTokens, 100);
  assert.equal(requests, 2);
  assert.equal(aborted, 1);
  assert.equal(deleted, 2);
});

test("preview generation is a bounded tools-free request and cleans up failed attempts", async () => {
  const { harness, stub } = fixture();
  stub.createSession = async () => "preview-session";
  let aborted = 0;
  let deleted = 0;
  let requests = 0;
  stub.prompt = () => assert.fail("previews must not enter the builder reconciliation loop");
  stub.client.session.abort = async () => { aborted++; return {}; };
  stub.client.session.delete = async () => { deleted++; return {}; };
  stub.client.session.prompt = async (body: any, options: any) => {
    requests++;
    assert.deepEqual(body.tools, { "*": false });
    assert.equal(body.agent, "presenter");
    assert.ok(options.signal instanceof AbortSignal);
    if (requests === 1) throw new Error("model timeout");
    return { info: { id: "preview-message", role: "assistant", time: { created: Date.now() }, tokens: { input: 120, output: 30 } },
      parts: [{ type: "text", text: "PITCH: A calm pond where you feed koi.\nNEW: Added the lily pads.\nPLAY: Click the water to drop food." }] };
  };
  const input = { name: "Koi Pond", kind: "2D web game", request: "a pond game" };
  await assert.rejects(harness.generatePreview("/w", input, "test/backup"), /model timeout/);
  const result = await harness.generatePreview("/w", input, "test/backup");
  assert.equal(result.pitch, "A calm pond where you feed koi.");
  assert.equal(result.added, "Added the lily pads.");
  assert.equal(result.play, "Click the water to drop food.");
  assert.equal(result.usage.inputTokens, 120);
  assert.equal(requests, 2);
  assert.equal(aborted, 1);
  assert.equal(deleted, 2);
});
