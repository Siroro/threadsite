import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPreviewServer } from "../server.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-preview-"));
  const site = path.join(root, "100", "200", "site");
  await fs.mkdir(path.join(site, "src"), { recursive: true });
  await fs.writeFile(path.join(site, "index.html"), '<script type="module" src="js/main.js"></script>');
  await fs.writeFile(path.join(site, "src", "main.ts"), 'import { label } from "./label.js"; document.title = label;');
  await fs.writeFile(path.join(site, "src", "label.ts"), 'export const label: string = "first preview";');
  const server = createPreviewServer({ workspaceRoot: root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { root, site, get: (url = "") => fetch(`${origin}/100/200/${url}`), origin };
}

test("builds current TypeScript imports in memory and rebuilds on HTML reload", async (t) => {
  const { site, get } = await fixture(t);
  assert.equal((await get()).status, 200);
  const first = await (await get("js/main.js")).text();
  const chunk = first.match(/from"\.\/(chunks\/[^\"]+)"/)[1];
  assert.match(await (await get(`js/${chunk}`)).text(), /first preview/);
  await assert.rejects(fs.stat(path.join(site, "js")), { code: "ENOENT" });
  await fs.writeFile(path.join(site, "src", "label.ts"), 'export const label = "updated preview";');
  await get();
  const updated = await (await get("js/main.js")).text();
  const nextChunk = updated.match(/from"\.\/(chunks\/[^\"]+)"/)[1];
  assert.notEqual(chunk, nextChunk);
  assert.match(await (await get(`js/${nextChunk}`)).text(), /updated preview/);
  assert.equal((await get(`js/${chunk}`)).status, 404);
  assert.equal((await get("js/stale.js")).status, 404);
});

test("broken edits show build diagnostics instead of a stale compiled preview", async (t) => {
  const { site, get } = await fixture(t);
  await get();
  await fs.writeFile(path.join(site, "src", "main.ts"), 'import "./missing.js";');
  const response = await get();
  assert.equal(response.status, 500);
  assert.match(await response.text(), /Could not resolve.*missing/);
  assert.equal((await get("js/main.js")).status, 500);
});

test("serves legacy static JS, local assets and subpages with correct MIME types", async (t) => {
  const { site, get } = await fixture(t);
  await fs.rm(path.join(site, "src"), { recursive: true });
  await fs.mkdir(path.join(site, "js"));
  await fs.writeFile(path.join(site, "js", "main.js"), 'document.title = "legacy";');
  await fs.mkdir(path.join(site, "help"));
  await fs.writeFile(path.join(site, "help", "index.html"), "Help");
  assert.match(await (await get("js/main.js")).text(), /legacy/);
  const page = await get("help/");
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.equal(await page.text(), "Help");
  assert.equal(page.headers.get("cache-control"), "no-store");
});

test("nested TypeScript without an entry cannot fall back to old workspace bundles", async (t) => {
  const { site, get } = await fixture(t);
  await fs.rm(path.join(site, "src"), { recursive: true });
  await fs.mkdir(path.join(site, "src", "shared"), { recursive: true });
  await fs.writeFile(path.join(site, "src", "shared", "helper.ts"), "export const value = 1;");
  await fs.mkdir(path.join(site, "js"));
  await fs.writeFile(path.join(site, "js", "main.js"), 'console.log("stale");');
  assert.equal((await get("js/main.js")).status, 404);
});

test("does not expose workspace files, source, dotfiles or traversal paths", async (t) => {
  const { site, get, origin } = await fixture(t);
  await fs.writeFile(path.join(site, ".env"), "secret");
  await fs.writeFile(path.join(path.dirname(site), "AGENTS.md"), "workspace only");
  for (const relative of ["src/main.ts", "net/client.js", ".env", "%2e%2e%2fAGENTS.md", "assets%5c..%5c.env"]) {
    const response = await get(relative);
    assert.ok([403, 404].includes(response.status), `${relative}: ${response.status}`);
    assert.doesNotMatch(await response.text(), /secret|workspace only/);
  }
  assert.equal((await fetch(`${origin}/`)).status, 404);
});

test("rejects imports outside this project's site and engine packages", async (t) => {
  const { root, site, get } = await fixture(t);
  await fs.writeFile(path.join(root, "private.ts"), 'export const secret = "not for this project";');
  await fs.writeFile(path.join(site, "src", "main.ts"), 'import { secret } from "../../../../private.ts"; console.log(secret);');
  const response = await get();
  assert.equal(response.status, 500);
  assert.match(await response.text(), /imports must stay inside/);
});

test("resolves harness-seeded engine packages from the workspace", async (t) => {
  const { site, get } = await fixture(t);
  const pkg = path.join(path.dirname(site), "node_modules", "test-engine");
  await fs.mkdir(pkg, { recursive: true });
  await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ main: "index.js" }));
  await fs.writeFile(path.join(pkg, "index.js"), 'export const version = "seeded engine";');
  await fs.writeFile(path.join(site, "src", "main.ts"), 'import { version } from "test-engine"; console.log(version);');
  assert.equal((await get()).status, 200);
  assert.match(await (await get("js/main.js")).text(), /seeded engine/);
});

test("refuses symlinked assets and project directories", async (t) => {
  const { root, site, get, origin } = await fixture(t);
  await fs.writeFile(path.join(root, "private.txt"), "private content");
  try {
    await fs.symlink(path.join(root, "private.txt"), path.join(site, "leak.txt"));
  } catch (error) {
    if (error.code === "EPERM") { t.skip("Windows requires symlink privilege"); return; }
    throw error;
  }
  assert.equal((await get("leak.txt")).status, 500);
  await fs.symlink(path.join(root, "100", "200"), path.join(root, "100", "201"), "junction");
  assert.equal((await fetch(`${origin}/100/201/`)).status, 500);
});
