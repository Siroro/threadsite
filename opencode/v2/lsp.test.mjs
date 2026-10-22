import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setupLsp } from "../dist/lsp.mjs";
import { buildV2Config } from "./config.mjs";

const legacy = JSON.parse(await fs.readFile(new URL("../opencode.json", import.meta.url), "utf8"));

test("LSP never discovers server commands from generated project configuration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-lsp-config-"));
  try {
    await fs.writeFile(path.join(root, "opencode.json"), JSON.stringify({ lsp: legacy.lsp }));
    await setupLsp({ location: { directory: root }, tool: {
      transform: () => assert.fail("project configuration must not enable servers"),
    } });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// Run in the service image with THREADSITE_TEST_LANGUAGE_SERVERS=1. On Windows,
// THREADSITE_LSP_SERVER_ROOT may point to an isolated node_modules directory.
test("real language servers navigate and diagnose config-free project files within their boundary", {
  skip: process.env.THREADSITE_TEST_LANGUAGE_SERVERS !== "1", timeout: 90000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-lsp-real-"));
  const hooks = {};
  let tool;
  let disposed = 0;
  const registration = () => ({ dispose: async () => { disposed++; } });
  const options = buildV2Config(legacy, { env: {} }).plugins[0].options;
  const serverRoot = process.env.THREADSITE_LSP_SERVER_ROOT;
  if (serverRoot) {
    options.lsp.typescript.command = [process.execPath, path.join(serverRoot, "typescript-language-server/lib/cli.mjs"), "--stdio"];
    for (const id of ["html", "css", "json"]) {
      options.lsp[id].command = [process.execPath, path.join(serverRoot, `vscode-langservers-extracted/bin/vscode-${id}-language-server`), "--stdio"];
    }
  }
  let cleanup;
  try {
    await fs.mkdir(path.join(root, "site/src"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules/engine-fixture"), { recursive: true });
    await fs.writeFile(path.join(root, "node_modules/engine-fixture/package.json"), '{"name":"engine-fixture","types":"index.d.ts"}');
    await fs.writeFile(path.join(root, "node_modules/engine-fixture/index.d.ts"), 'export class Vector { length(): number; }');
    await fs.writeFile(path.join(root, "site/src/helper.ts"), 'export const answer = 42;\n');
    await fs.writeFile(path.join(root, "site/src/main.ts"), 'import { answer } from "./helper.js";\nimport { Vector } from "engine-fixture";\nconst invalid: number = "wrong";\nconst distance: number = new Vector().length();\nconsole.log(answer, invalid, distance);\n');
    await fs.writeFile(path.join(root, "site/index.html"), '<!doctype html><html><body><h1>Hello</h1></body></html>');
    await fs.writeFile(path.join(root, "site/style.css"), 'body { color: red; }');
    await fs.writeFile(path.join(root, "site/data.json"), '{"hello": 42}');
    cleanup = await setupLsp({ location: { directory: root }, options, tool: {
      transform: async (callback) => { callback({ add: (entry) => { tool = entry; } }); return registration(); },
      hook: async (name, callback) => { hooks[name] = callback; return registration(); },
    } });
    assert.ok(tool);
    const definition = await tool.execute({ operation: "goToDefinition", path: "site/src/main.ts", line: 5, character: 13 });
    assert.match(definition.content, /helper\.ts:1:/);
    const hover = await tool.execute({ operation: "hover", path: "site/src/main.ts", line: 4, character: 45 });
    assert.match(hover.content, /length.*number/s);
    const event = { tool: "write", status: "completed", input: { path: "site/src/main.ts" }, result: { content: "Written" } };
    await hooks["execute.after"](event);
    assert.match(event.result.content, /not assignable to type/);
    assert.doesNotMatch(event.result.content, /Cannot find module|Cannot find name|used before/);
    for (const file of ["site/index.html", "site/style.css", "site/data.json"]) {
      const result = await tool.execute({ operation: "documentSymbol", path: file });
      assert.doesNotMatch(result.content, /No results|not available|failed|not support/i, file);
    }
    await assert.rejects(tool.execute({ operation: "hover", path: "../outside.ts", line: 1, character: 1 }), /outside/);
    await assert.rejects(fs.access(path.join(root, "tsconfig.json")));
  } finally {
    await cleanup?.();
    await fs.rm(root, { recursive: true, force: true });
  }
  assert.equal(disposed, 2);
});
