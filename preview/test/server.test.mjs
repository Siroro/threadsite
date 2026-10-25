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

test("deleting the workspace revokes cached main and scratch browser bundles", async (t) => {
  const { site, get } = await fixture(t);
  await scratch(site, "car", 'document.title="private scratch";');
  await get(); await get("__scratch/car/");
  await fs.rm(path.dirname(site), { recursive: true, force: true });
  for (const resource of ["js/main.js", "__scratch/car/js/main.js"]) {
    const response = await get(resource);
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /private scratch|first preview/);
  }
});

async function scratch(site, name, source) {
  const dir = path.join(path.dirname(site), "scratch", name);
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), `<h1>${name}</h1><script type="module" src="js/main.js"></script>`);
  await fs.writeFile(path.join(dir, "src", "main.ts"), source);
  return dir;
}

test("scratch builds only its component graph and serves shared assets even when the game is broken", async (t) => {
  const { site, get } = await fixture(t);
  await fs.writeFile(path.join(site, "src", "main.ts"), 'import "./broken-scene.js";');
  await fs.mkdir(path.join(site, "src", "components"));
  await fs.writeFile(path.join(site, "src", "components", "car.ts"), 'export const car = "isolated car factory";');
  await fs.mkdir(path.join(site, "assets"));
  await fs.writeFile(path.join(site, "assets", "paint.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const pkg = path.join(path.dirname(site), "node_modules", "test-engine");
  await fs.mkdir(pkg, { recursive: true });
  await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ main: "index.js" }));
  await fs.writeFile(path.join(pkg, "index.js"), 'export const engine = "installed engine";');
  const dir = await scratch(site, "car", 'import { car } from "../../../site/src/components/car.js"; import { engine } from "test-engine"; document.title = car + engine;');
  assert.equal((await get()).status, 500);
  assert.equal((await get("__scratch/car/")).status, 200);
  const code = await (await get("__scratch/car/js/main.js")).text();
  assert.match(code, /isolated car factory/);
  assert.match(code, /installed engine/);
  const image = await get("__scratch/car/__site/assets/paint.svg");
  assert.equal(image.status, 200);
  assert.match(image.headers.get("content-type"), /svg/);
  assert.equal((await get("__scratch/car/src/main.ts")).status, 404);
  await assert.rejects(fs.stat(path.join(dir, "js")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(site, "js")), { code: "ENOENT" });
});

test("scratch snapshots, errors and reloads stay independent from other views and the main preview", async (t) => {
  const { site, get } = await fixture(t);
  const car = await scratch(site, "car", 'document.title = "first car";');
  await scratch(site, "hud", 'document.title = "hud component";');
  assert.equal((await get()).status, 200);
  await get("__scratch/car/");
  await get("__scratch/hud/");
  await fs.writeFile(path.join(car, "src", "main.ts"), 'document.title = "second car";');
  await get("__scratch/car/");
  assert.match(await (await get("__scratch/car/js/main.js")).text(), /second car/);
  assert.match(await (await get("__scratch/hud/js/main.js")).text(), /hud component/);
  await fs.writeFile(path.join(car, "src", "main.ts"), 'const broken = ;');
  assert.equal((await get("__scratch/car/")).status, 500);
  assert.equal((await get("__scratch/car/js/main.js")).status, 500);
  assert.equal((await get()).status, 200);
  assert.equal((await get("__scratch/hud/")).status, 200);
  const redirect = await get("__scratch/hud");
  assert.equal(redirect.url.endsWith("/__scratch/hud/"), true);
});

test("scratch rejects root files, other views/projects, symlinks and source exposure", async (t) => {
  const { root, site, get } = await fixture(t);
  const dir = await scratch(site, "car", 'document.title = "car";');
  const other = await scratch(site, "other", 'export const value = "private view";');
  const otherProject = path.join(root, "999", "888", "site", "src");
  await fs.mkdir(otherProject, { recursive: true });
  await fs.writeFile(path.join(otherProject, "main.ts"), 'export const value = "PRIVATE_MARKER";');
  await fs.writeFile(path.join(path.dirname(site), "private.ts"), 'export const value = "PRIVATE_MARKER";');
  for (const file of ["../../../private.ts", "../../other/src/main.ts", "../../../../../999/888/site/src/main.ts"]) {
    await fs.writeFile(path.join(dir, "src", "main.ts"), `import { value } from "${file}"; console.log(value);`);
    assert.equal((await get("__scratch/car/")).status, 500);
  }
  for (const url of ["__scratch/", "__scratch/bad.name/", "__scratch/car/.env", "__scratch/car/__site/src/main.ts",
    "__scratch/car/__site/js/main.js", "__scratch/car/__site/AGENTS.md", "__scratch/car/node_modules/three/index.js",
    "__scratch/car/%2e%2e%2fprivate.ts"]) {
    const response = await get(url);
    assert.ok([403, 404].includes(response.status), `${url}: ${response.status}`);
    assert.doesNotMatch(await response.text(), /PRIVATE_MARKER/);
  }
  await fs.writeFile(path.join(site, "src", "main.ts"), 'import "../../scratch/other/src/main.ts";');
  assert.equal((await get()).status, 500, "the deployed site cannot import experiments");
  await fs.writeFile(path.join(dir, "src", "main.ts"), 'document.title = "car";');
  await fs.symlink(other, path.join(path.dirname(other), "linked"), "junction");
  assert.equal((await get("__scratch/linked/")).status, 500);
  await fs.mkdir(path.join(site, "assets"));
  await fs.writeFile(path.join(root, "private.txt"), "PRIVATE_MARKER");
  try {
    await fs.symlink(path.join(root, "private.txt"), path.join(site, "assets", "leak.txt"));
  } catch (error) {
    if (error.code === "EPERM") return;
    throw error;
  }
  assert.equal((await get("__scratch/car/__site/assets/leak.txt")).status, 500);
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

test("concurrent projects queue their builds instead of failing as busy", async (t) => {
  // Several threads can preview at the same time. The old cap of two in-flight
  // builds returned "Preview is busy" for the rest, which reached the agent as
  // a blank page whose entire content was that error string.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-concurrent-"));
  const projects = Array.from({ length: 6 }, (_, index) => `90${index}/200`);
  for (const [index, project] of projects.entries()) {
    const site = path.join(root, ...project.split("/"), "site");
    await fs.mkdir(path.join(site, "src"), { recursive: true });
    await fs.writeFile(path.join(site, "index.html"), '<script type="module" src="js/main.js"></script>');
    await fs.writeFile(path.join(site, "src", "main.ts"), `document.title = "project ${index}";`);
  }
  const server = createPreviewServer({ workspaceRoot: root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const responses = await Promise.all(projects.map((project) => fetch(`${origin}/${project}/`)));
  assert.deepEqual(responses.map((response) => response.status), projects.map(() => 200));
  const bodies = await Promise.all(responses.map((response) => response.text()));
  for (const body of bodies) assert.doesNotMatch(body, /Preview is busy/);
});

async function viewerFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-viewer-"));
  const site = path.join(root, "100", "200", "site");
  const dist = path.join(root, "bundle");
  await fs.mkdir(path.join(site, "src"), { recursive: true });
  await fs.mkdir(path.join(dist, "draco"), { recursive: true });
  await fs.writeFile(path.join(site, "index.html"), "<p>game</p>");
  await fs.writeFile(path.join(dist, "viewer.html"), "<!doctype html><title>viewer-stub</title>");
  await fs.writeFile(path.join(dist, "app.js"), "console.log('viewer')");
  await fs.writeFile(path.join(dist, "draco", "draco_decoder.wasm"), "wasm-bytes");
  const server = createPreviewServer({ workspaceRoot: root, viewerDist: dist });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { root, site, dist, origin };
}

test("the asset viewer serves its page from the bundle and its manifest from the project", async (t) => {
  const { site, origin } = await viewerFixture(t);
  await fs.mkdir(path.join(site, "assets", "sprites"), { recursive: true });
  await fs.mkdir(path.join(site, "assets", "models"), { recursive: true });
  await fs.writeFile(path.join(site, "assets", "sprites", "hero.png"), Buffer.from([1, 2, 3]));
  await fs.writeFile(path.join(site, "assets", "models", "cube.glb"), Buffer.from([4, 5]));
  await fs.writeFile(path.join(site, "assets", "jump.wav"), Buffer.from([6]));
  await fs.writeFile(path.join(site, "assets", ".hidden.png"), Buffer.from([7]));
  await fs.writeFile(path.join(site, "assets", "readme.txt"), Buffer.from([8, 9]));

  const manifest = await (await fetch(`${origin}/100/200/__assets/manifest.json`)).json();
  assert.equal(manifest.project, "100/200");
  assert.deepEqual(manifest.files, [
    { path: "jump.wav", bytes: 1, kind: "audio" },
    { path: "models/cube.glb", bytes: 2, kind: "model" },
    { path: "readme.txt", bytes: 2, kind: "data" },
    { path: "sprites/hero.png", bytes: 3, kind: "image" },
  ]);
  assert.equal(manifest.truncated, false);

  const page = await fetch(`${origin}/100/200/__assets/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(await page.text(), /viewer-stub/);
  assert.equal((await fetch(`${origin}/100/200/__assets/index.html`)).status, 200);
  const redirect = await fetch(`${origin}/100/200/__assets`, { redirect: "follow" });
  assert.equal(redirect.url.endsWith("/__assets/"), true);
  assert.equal((await fetch(`${origin}/100/200/__assets/other.txt`)).status, 404);
  assert.equal((await fetch(`${origin}/100/999/__assets/`)).status, 404, "unknown projects have no viewer");
});

test("the asset viewer explains a missing bundle instead of failing silently", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-viewer-missing-"));
  const site = path.join(root, "100", "200", "site");
  await fs.mkdir(site, { recursive: true });
  const server = createPreviewServer({ workspaceRoot: root, viewerDist: path.join(root, "absent") });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const manifest = await (await fetch(`${origin}/100/200/__assets/manifest.json`)).json();
  assert.deepEqual(manifest.files, []);
  const page = await fetch(`${origin}/100/200/__assets/`);
  assert.equal(page.status, 500);
  assert.match(await page.text(), /build-viewer/);
  assert.equal((await fetch(`${origin}/__viewer/app.js`)).status, 404);
});

test("/__viewer serves only built bundle files with their real types", async (t) => {
  const { origin } = await viewerFixture(t);
  const app = await fetch(`${origin}/__viewer/app.js`);
  assert.equal(app.status, 200);
  assert.match(app.headers.get("content-type"), /javascript/);
  const wasm = await fetch(`${origin}/__viewer/draco/draco_decoder.wasm`);
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get("content-type"), "application/wasm");
  assert.equal((await fetch(`${origin}/__viewer/missing.js`)).status, 404);
  for (const traversal of ["__viewer/../server.mjs", "__viewer/..%2Fserver.mjs"]) {
    const response = await fetch(`${origin}/${traversal}`);
    assert.equal(response.status, 404, traversal);
  }
});

test("the asset manifest stops at 1,000 files and reports truncation", async (t) => {
  const { site, origin } = await viewerFixture(t);
  const assets = path.join(site, "assets");
  await fs.mkdir(assets, { recursive: true });
  for (let index = 0; index < 1005; index++) await fs.writeFile(path.join(assets, `a${String(index).padStart(4, "0")}.png`), "x");
  const manifest = await (await fetch(`${origin}/100/200/__assets/manifest.json`)).json();
  assert.equal(manifest.files.length, 1000);
  assert.equal(manifest.truncated, true);
});
