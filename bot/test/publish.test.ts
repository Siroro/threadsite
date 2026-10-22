import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const { injectUpdateChecker, versionAssetReferences } = await import("../src/publish.js");

const hash = (content: string): string => crypto.createHash("sha256").update(content).digest("hex").slice(0, 10);

async function staging(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-publish-"));
  return path.resolve(root);
}

test("asset versioning derives every ?v= from post-rewrite content", async () => {
  const root = await staging();
  // index.html -> a.js -> b.js -> c.js: plain vendored-style modules, not
  // esbuild chunks. Writing c's version into b changes b's bytes, so b's own
  // version — and therefore a's rewritten content and URL — must be derived
  // AFTER that rewrite, not from the pristine sources.
  const writeSources = (c: string): Promise<void[]> => Promise.all([
    fs.writeFile(path.join(root, "c.js"), `export const C = "${c}";\n`),
    fs.writeFile(path.join(root, "b.js"), 'import { C } from "./c.js";\nexport const B = C;\n'),
    fs.writeFile(path.join(root, "a.js"), 'import { B } from "./b.js";\nexport const A = B;\n'),
    fs.writeFile(path.join(root, "index.html"), '<!doctype html><script type="module" src="./a.js"></script></body>\n'),
  ]);
  await writeSources("one");
  await versionAssetReferences(root);

  const bFinal = await fs.readFile(path.join(root, "b.js"), "utf8");
  const cFinal = await fs.readFile(path.join(root, "c.js"), "utf8");
  assert.match(bFinal, new RegExp(`from "./c\\.js\\?v=${hash(cFinal)}"`), "leaf version comes from its (unchanged) bytes");
  const aFinal = await fs.readFile(path.join(root, "a.js"), "utf8");
  assert.match(aFinal, new RegExp(`from "./b\\.js\\?v=${hash(bFinal)}"`), "importer's embedded version describes b's rewritten bytes");
  const html = await fs.readFile(path.join(root, "index.html"), "utf8");
  assert.match(html, new RegExp(`src="./a\\.js\\?v=${hash(aFinal)}"`), "a's URL describes its own rewritten bytes");

  // A redeploy that changes only the leaf must change every importer's URL —
  // otherwise returning visitors keep the old import chain for as long as the
  // immutable URL stays cached.
  await writeSources("two");
  await versionAssetReferences(root);
  const bSecond = await fs.readFile(path.join(root, "b.js"), "utf8");
  const aSecond = await fs.readFile(path.join(root, "a.js"), "utf8");
  const htmlSecond = await fs.readFile(path.join(root, "index.html"), "utf8");
  assert.match(aSecond, new RegExp(`from "./b\\.js\\?v=${hash(bSecond)}"`));
  assert.match(htmlSecond, new RegExp(`src="./a\\.js\\?v=${hash(aSecond)}"`));
  assert.notEqual(hash(aSecond), hash(aFinal), "a.js's URL must change when a dependency changes");
});

test("asset versioning replaces a stale authored v parameter", async () => {
  const root = await staging();
  await fs.writeFile(path.join(root, "b.js"), "export const B = 1;\n");
  await fs.writeFile(path.join(root, "a.js"), 'import { B } from "./b.js?v=authored";\nexport const A = B;\n');
  await versionAssetReferences(root);
  const a = await fs.readFile(path.join(root, "a.js"), "utf8");
  const bVersion = await fs.readFile(path.join(root, "b.js"), "utf8").then(hash);
  assert.match(a, new RegExp(`from "./b\\.js\\?v=${bVersion}"`));
  assert.doesNotMatch(a, /v=authored/);
});

test("injectUpdateChecker is idempotent across republishes", async () => {
  const root = await staging();
  await fs.writeFile(path.join(root, "index.html"), "<!doctype html><html><body><h1>hi</h1></body></html>");

  await injectUpdateChecker(root, "aaaaaaaaaaaa");
  const first = await fs.readFile(path.join(root, "index.html"), "utf8");
  assert.equal((first.match(/var DEPLOYED = "([0-9a-f]+)"/g) ?? []).length, 1);
  assert.match(first, /var DEPLOYED = "aaaaaaaaaaaa"/);

  // Republishing the already-published tree (rename recovery) stamps a new
  // deploy id: the loader must be replaced, not appended — two loaders with
  // different ids against one version file reload the page forever.
  await injectUpdateChecker(root, "bbbbbbbbbbbb");
  const second = await fs.readFile(path.join(root, "index.html"), "utf8");
  assert.equal((second.match(/var DEPLOYED = "([0-9a-f]+)"/g) ?? []).length, 1);
  assert.match(second, /var DEPLOYED = "bbbbbbbbbbbb"/);

  // A page that already carries two loaders (the older bug) is repaired.
  const loaderStart = first.indexOf("<script>\n(function () {");
  assert.ok(loaderStart >= 0, "the injected loader is present to duplicate");
  await fs.writeFile(path.join(root, "doubled.html"), first + first.slice(loaderStart));
  await injectUpdateChecker(root, "cccccccccccc");
  const repaired = await fs.readFile(path.join(root, "doubled.html"), "utf8");
  assert.equal((repaired.match(/var DEPLOYED = "([0-9a-f]+)"/g) ?? []).length, 1);
  assert.match(repaired, /var DEPLOYED = "cccccccccccc"/);
});
