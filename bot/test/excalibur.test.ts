import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { testRootSetup } from "./fixtures/root.js";
import { ensureEnginePackages } from "../src/engines.js";
import { ensureSkillFiles, skillNames } from "../src/skills.js";
import { starterSource } from "../src/starter.js";

const root = testRootSetup("excalibur");
const { buildSite } = await import("../src/build.js");
const { validateSite, publishSite } = await import("../src/publish.js");

async function scaffold(name: string): Promise<string> {
  const workspace = path.join(root, name);
  await fs.mkdir(path.join(workspace, "site", "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "site", "index.html"),
    '<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}canvas{display:block}</style></head><body><canvas id="game"></canvas><script type="module" src="js/main.js"></script></body></html>');
  await ensureEnginePackages(workspace, "game-2d");
  return workspace;
}

test("2D engine seeding installs only Excalibur, repairs nested declarations", async () => {
  const workspace = await scaffold("seed");
  const engine = path.join(workspace, "node_modules", "excalibur");
  const manifest = JSON.parse(await fs.readFile(path.join(engine, "package.json"), "utf8"));
  assert.equal(manifest.version, "0.32.0");
  await fs.access(path.join(engine, manifest.main));
  await fs.access(path.join(engine, manifest.types));
  await assert.rejects(fs.access(path.join(engine, "build", "dist", "excalibur.js")), { code: "ENOENT" });
  assert.equal(await ensureEnginePackages(workspace, "game-2d"), false);

  const nested = path.join(engine, "build", "dist", "Math", "vector.d.ts");
  await fs.rm(nested);
  assert.equal(await ensureEnginePackages(workspace, "game-2d"), true);
  assert.match(await fs.readFile(nested, "utf8"), /class Vector/);


});

test("skill refresh removes wrong-kind skills while retaining custom skills", async () => {
  const workspace = path.join(root, "skills");
  const skills = path.join(workspace, ".opencode", "skills");
  for (const name of ["threejs-game-studio", "my-art-direction"]) {
    const dir = path.join(skills, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), `custom ${name}`);
  }
  assert.equal(await ensureSkillFiles(workspace, "game-2d"), true);
  assert.ok(skillNames("game-2d").includes("excalibur"));
  for (const name of ["threejs-game-studio"]) {
    await assert.rejects(fs.access(path.join(skills, name)), { code: "ENOENT" });
  }
  await fs.access(path.join(skills, "excalibur", "SKILL.md"));
  assert.equal(await fs.readFile(path.join(skills, "my-art-direction", "SKILL.md"), "utf8"), "custom my-art-direction");
  assert.equal(await ensureSkillFiles(workspace, "game-2d"), false);
  await fs.writeFile(path.join(skills, "excalibur", "SKILL.md"), "drift");
  assert.equal(await ensureSkillFiles(workspace, "game-2d"), true);
  assert.equal(await ensureSkillFiles(workspace, "site"), true);
  assert.deepEqual(await fs.readdir(skills), ["my-art-direction"]);
});

test("Excalibur starter and skill example build, type-check and publish as static bundles", async () => {
  const workspace = await scaffold("build");
  const site = path.join(workspace, "site");
  const source = path.join(site, "src", "main.ts");
  await fs.writeFile(source, starterSource("game-2d"));
  assert.equal((await buildSite(workspace)).skipped, false);
  await validateSite(site);

  // Exercise the actual example given to builders, including inherited APIs
  // reached through Excalibur's nested declaration graph.
  const skill = await fs.readFile(path.join(process.cwd(), "assets", "skills", "excalibur", "SKILL.md"), "utf8");
  const example = /```ts\r?\n([\s\S]*?)```/.exec(skill)?.[1];
  assert.ok(example, "Excalibur skill must provide a runnable example");
  await fs.writeFile(source, example);
  await buildSite(workspace);
  await validateSite(site);
  await publishSite(site, "excalibur-check");
  const published = path.join(root, "published", "excalibur-check");
  assert.ok((await fs.stat(path.join(published, "js", "main.js"))).size > 1000);
  await assert.rejects(fs.access(path.join(published, "src")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(published, "node_modules")), { code: "ENOENT" });

  await fs.writeFile(source, 'import * as ex from "excalibur"; console.log(new ex.Actor({ width: "wide" }));');
  await buildSite(workspace);
  await assert.rejects(validateSite(site), /type-check error:[\s\S]*not assignable to type 'number'/);
});

test("publication requires TypeScript sources for the generated JavaScript directory", async () => {
  const workspace = await scaffold("source-required");
  const site = path.join(workspace, "site");
  await fs.rm(path.join(site, "src"), { recursive: true });
  await fs.mkdir(path.join(site, "js"));
  await fs.writeFile(path.join(site, "js", "main.js"), 'console.log("unchecked");');
  await assert.rejects(validateSite(site), /site\/js\/ requires TypeScript source under site\/src\//);
});
