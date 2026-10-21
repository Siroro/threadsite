/**
 * Throwaway end-to-end fixture for the TypeScript pipeline:
 * scaffold -> vendor libs -> buildSite -> validateSite -> publishSite,
 * plus failure modes (broken import, misspelled export, TS outside src/,
 * element ids, stale prune, legacy project). Run with:
 *   DISCORD_BOT_TOKEN=x DISCORD_APPLICATION_ID=x PUBLISH_ROOT=<tmp> LOG_FILE=<tmp> npx tsx e2e-fixture.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildSite } from "./src/build.js";
import { validateSite, publishSite } from "./src/publish.js";
import { ensureEnginePackages } from "./src/engines.js";
import { ensureMultiplayerFiles } from "./src/multiplayer.js";
import { MULTIPLAYER_PROTOCOL_VERSION as PROTOCOL_VERSION } from "./src/templates.js";
import { ensureSkillFiles, skillNames } from "./src/skills.js";
import { starterSource } from "./src/starter.js";
import { untrackGeneratedArtifacts } from "./src/git.js";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
async function expectThrow(name: string, fn: () => Promise<unknown>, match: RegExp): Promise<string> {
  try {
    await fn();
    check(name, false, "did not throw");
    return "";
  } catch (error) {
    const message = String((error as Error).message ?? error);
    check(name, match.test(message), `message did not match ${match}: ${message.slice(0, 200)}`);
    return message;
  }
}

/** Contents of every .js file under dir, recursively — bundle assertions must
 * cover split chunks, not just the entry that pulled them in. */
async function readJsTree(dir: string): Promise<string[]> {
  const chunks: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) chunks.push(...await readJsTree(full));
    else if (entry.name.endsWith(".js")) chunks.push(await fs.readFile(full, "utf8"));
  }
  return chunks;
}

async function scaffold(kind: "site" | "game-2d" | "game-3d"): Promise<string> {  const ws = await fs.mkdtemp(path.join(os.tmpdir(), `threadsite-e2e-${kind}-`));
  const site = path.join(ws, "site");
  await fs.mkdir(path.join(site, "src"), { recursive: true });
  await fs.mkdir(path.join(site, "js"), { recursive: true });
  await fs.writeFile(path.join(site, "index.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title><link rel="stylesheet" href="css/s.css"></head>` +
    `<body><main id="app"><h1 id="title">Hi</h1></main><script type="module" src="js/main.js"></script></body></html>\n`);
  await fs.mkdir(path.join(site, "css"), { recursive: true });
  await fs.writeFile(path.join(site, "css", "s.css"), "main{font-family:sans-serif}\n");
  await fs.writeFile(path.join(site, "src", "main.ts"), starterSource(kind));
  if (kind !== "site") {
    await ensureMultiplayerFiles(ws, { gameId: "e2e", wsUrl: "ws://localhost:8090/ws", protocolVersion: PROTOCOL_VERSION }, kind);
  }
  await ensureEnginePackages(ws, kind);
  await ensureSkillFiles(ws, kind);
  return ws;
}

async function main(): Promise<void> {
  console.log("\n== 1. game-3d scaffold: vendor + build + validate + publish ==");
  const ws3d = await scaffold("game-3d");
  const site3d = path.join(ws3d, "site");
  const built3d = await buildSite(ws3d);
  check("build not skipped", built3d.skipped === false);
  check("one output emitted", built3d.emitted === 1, JSON.stringify(built3d));
  const bundle = await fs.readFile(path.join(site3d, "js", "main.js"), "utf8");
  check("bundle exists and contains three boot log", bundle.includes("[boot] three.js r"));
  // Three.js embeds multiline shader strings, so total line count remains high
  // even after minification; the generated JS itself is packed onto a long line.
  check("browser bundle is minified", (bundle.split(/\r?\n/, 1)[0]?.length ?? 0) > 1000,
    `first generated line ${(bundle.split(/\r?\n/, 1)[0]?.length ?? 0)} chars`);
  check("three tree-shaken (no WebGLRenderer)", !bundle.includes("WebGLRenderer"), `${(bundle.length / 1024).toFixed(0)}KB bundle`);
  check("MIT legal comment kept", bundle.includes("MIT") || bundle.includes("Three.js Authors"));
  const manifest3d = JSON.parse(await fs.readFile(path.join(ws3d, "build-manifest.json"), "utf8"));
  check("manifest lists js/main.js", manifest3d.outputs.includes("js/main.js"), JSON.stringify(manifest3d));
  const stats3d = await validateSite(site3d);
  check("validate passes", stats3d.files > 3, JSON.stringify(stats3d));
  const publishRoot = process.env.PUBLISH_ROOT!;
  await publishSite(site3d, "e2e-3d");
  const publishedIndex = await fs.readFile(path.join(publishRoot, "e2e-3d", "index.html"), "utf8");
  check("published index cache-busts the bundle", /js\/main\.js\?v=[0-9a-f]{10}/.test(publishedIndex), publishedIndex.slice(0, 200));
  check("published runtime excludes authored src", !(await fs.stat(path.join(publishRoot, "e2e-3d", "src")).then(() => true, () => false)));
  check("published runtime excludes unbundled net inputs", !(await fs.stat(path.join(publishRoot, "e2e-3d", "net")).then(() => true, () => false)));
  check("published runtime keeps minified bundle", await fs.stat(path.join(publishRoot, "e2e-3d", "js", "main.js")).then(() => true, () => false));

  console.log("\n== 1b. publish stamps a deploy version and injects the update checker ==");
  const readVersion = async (): Promise<{ version: string; commit?: string | null }> => JSON.parse(
    await fs.readFile(path.join(publishRoot, "e2e-3d", "threadsite-version.json"), "utf8"),
  ) as { version: string; commit?: string | null };
  const deployed = await readVersion();
  check("deploy version file stamped", /^[0-9a-f]{12}$/.test(deployed.version), JSON.stringify(deployed));
  check("repo-less workspace stamps commit null", deployed.commit == null, JSON.stringify(deployed));
  // A workspace that IS a git repo (the real Forgejo-mirror case) records HEAD,
  // so a live browser can be traced to the exact source commit.
  {
    const execFileSync = (await import("node:child_process")).execFileSync;
    const wsGit = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-e2e-git-"));
    const siteGit = path.join(wsGit, "site");
    await fs.mkdir(path.join(siteGit, "pages"), { recursive: true });
    await fs.copyFile(path.join(site3d, "index.html"), path.join(siteGit, "index.html"));
    execFileSync("git", ["init", "--quiet"], { cwd: wsGit });
    execFileSync("git", ["add", "."], { cwd: wsGit });
    execFileSync("git", ["-c", "user.email=e2e@local", "-c", "user.name=e2e", "commit", "--quiet", "-m", "init"], { cwd: wsGit });
    await publishSite(siteGit, "e2e-git");
    const stamped = JSON.parse(
      await fs.readFile(path.join(publishRoot, "e2e-git", "threadsite-version.json"), "utf8"),
    ) as { version: string; commit?: string | null };
    check("git workspace stamps its HEAD commit", /^[0-9a-f]{40}$/.test(stamped.commit ?? ""), JSON.stringify(stamped));
  }
  // Existing repositories may already track generated files. Migration removes
  // them from the index while preserving workspace copies for the live build.
  {
    const execFileSync = (await import("node:child_process")).execFileSync;
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-e2e-untrack-"));
    await fs.mkdir(path.join(workspace, "site", "src"), { recursive: true });
    await fs.mkdir(path.join(workspace, "site", "js"), { recursive: true });
    await fs.mkdir(path.join(workspace, "site", "net"), { recursive: true });
    await fs.writeFile(path.join(workspace, "site", "src", "main.ts"), "console.log('source');\n");
    await fs.writeFile(path.join(workspace, "site", "js", "main.js"), "console.log('built');\n");
    await fs.writeFile(path.join(workspace, "site", "net", "threadsite-net.js"), "export {};\n");
    await fs.writeFile(path.join(workspace, "build-manifest.json"), "{}\n");
    await fs.writeFile(path.join(workspace, ".gitignore"), "site/js/\nsite/net/\nbuild-manifest.json\n");
    execFileSync("git", ["init", "--quiet"], { cwd: workspace });
    execFileSync("git", ["add", "-f", "."], { cwd: workspace });
    execFileSync("git", ["-c", "user.email=e2e@local", "-c", "user.name=e2e", "commit", "--quiet", "-m", "old boundary"], { cwd: workspace });
    await untrackGeneratedArtifacts(workspace);
    const tracked = execFileSync("git", ["ls-files"], { cwd: workspace, encoding: "utf8" }) as string;
    check("migration untracks generated bundles/manifest; net client and source stay tracked",
      tracked.includes("site/src/main.ts") && tracked.includes("site/net/threadsite-net.js") && !tracked.includes("site/js/") && !tracked.includes("build-manifest.json"),
      tracked.replaceAll("\n", ", "));
    check("untracking preserves runtime workspace files",
      await fs.stat(path.join(workspace, "site", "js", "main.js")).then(() => true, () => false)
      && await fs.stat(path.join(workspace, "site", "net", "threadsite-net.js")).then(() => true, () => false));
  }
  check("page carries the update checker for its deploy",
    publishedIndex.includes("threadsite-version.json") && publishedIndex.includes(`var DEPLOYED = "${deployed.version}"`),
    publishedIndex.slice(-400));

  // Republishing the identical tree must not move the deploy id.
  await publishSite(site3d, "e2e-3d");
  check("unchanged tree republishes to the same deploy version", (await readVersion()).version === deployed.version);

  // A page in a subdirectory must resolve the version file against the site root.
  await fs.mkdir(path.join(site3d, "pages"), { recursive: true });
  await fs.writeFile(path.join(site3d, "pages", "credits.html"),
    `<!doctype html><html><body><a href="../index.html">home</a></body></html>\n`);
  await publishSite(site3d, "e2e-3d");
  const subpage = await fs.readFile(path.join(publishRoot, "e2e-3d", "pages", "credits.html"), "utf8");
  check("subpage checker resolves the site-root version file", subpage.includes(`var VERSION_URL = "../threadsite-version.json"`), subpage.slice(-400));

  // Any content change — here one appended CSS rule — must move the deploy id.
  await fs.appendFile(path.join(site3d, "css", "s.css"), "/* bumped */\n");
  await publishSite(site3d, "e2e-3d");
  const bumped = await readVersion();
  check("changed content bumps the deploy version", bumped.version !== deployed.version, `${deployed.version} -> ${bumped.version}`);
  const bumpedIndex = await fs.readFile(path.join(publishRoot, "e2e-3d", "index.html"), "utf8");
  check("republished page restamped with the new version", bumpedIndex.includes(`var DEPLOYED = "${bumped.version}"`));

  const skill3dPath = path.join(ws3d, ".opencode", "skills", "game-3d", "SKILL.md");
  const skill3d = await fs.readFile(skill3dPath, "utf8").catch(() => "");
  check("game-3d playbook skill seeded with frontmatter", skill3d.startsWith("---\n") && skill3d.includes("name: game-3d"));
  check("game-3d gets curated skill set", skillNames("game-3d").length === 22
    && await fs.stat(path.join(ws3d, ".opencode", "skills", "threejs-game-studio", "references")).then(() => true, () => false));
  await fs.rm(path.join(ws3d, ".opencode"), { recursive: true, force: true });
  check("skill reseeded after deletion", (await ensureSkillFiles(ws3d, "game-3d")) === true
    && (await fs.readFile(skill3dPath, "utf8")) === skill3d);
  await fs.writeFile(skill3dPath, "tampered\n");
  check("skill restored after content drift", (await ensureSkillFiles(ws3d, "game-3d")) === true
    && (await fs.readFile(skill3dPath, "utf8")) === skill3d);
  check("skill seed idempotent", (await ensureSkillFiles(ws3d, "game-3d")) === false);

  console.log("\n== 1d. 3D physics stack: Rapier compat + three-mesh-bvh ==");
  const rapierDir = path.join(ws3d, "node_modules", "@dimforge", "rapier3d-compat");
  check("Rapier compat ESM seeded", await fs.stat(path.join(rapierDir, "rapier.mjs")).then(() => true, () => false));
  check("Rapier real declarations seeded", await fs.stat(path.join(rapierDir, "rapier.d.ts")).then(() => true, () => false));
  const bvhDir = path.join(ws3d, "node_modules", "three-mesh-bvh");
  check("three-mesh-bvh ESM seeded", await fs.stat(path.join(bvhDir, "src", "index.js")).then(() => true, () => false));
  check("three-mesh-bvh declarations seeded", await fs.stat(path.join(bvhDir, "src", "index.d.ts")).then(() => true, () => false));
  // Seeded directories are freshness-checked per file: a deleted module inside
  // one must reseed, not fail the next build while looking fresh.
  await fs.rm(path.join(bvhDir, "src", "core", "MeshBVH.js"));
  check("deleted file inside a seeded dir reseeds", (await ensureEnginePackages(ws3d, "game-3d")) === true
    && await fs.stat(path.join(bvhDir, "src", "core", "MeshBVH.js")).then(() => true, () => false));
  check("3D engine seed idempotent", (await ensureEnginePackages(ws3d, "game-3d")) === false);
  // Authored code across all three packages type-checks against the real
  // declarations (validateSite's tsc gate) and bundles with the compat build's
  // WASM inlined into the minified output.
  await fs.writeFile(path.join(site3d, "src", "physics.ts"), [
    `import * as THREE from "three";`,
    `import RAPIER from "@dimforge/rapier3d-compat";`,
    `import { computeBoundsTree, acceleratedRaycast, MeshBVH } from "three-mesh-bvh";`,
    ``,
    `THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;`,
    `THREE.Mesh.prototype.raycast = acceleratedRaycast as unknown as typeof THREE.Mesh.prototype.raycast;`,
    ``,
    `export async function physicsBoot(): Promise<void> {`,
    `  await RAPIER.init();`,
    `  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });`,
    `  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 10, 0));`,
    `  world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5), body);`,
    `  for (let i = 0; i < 120; i++) world.step();`,
    `  const bvh = new MeshBVH(new THREE.BoxGeometry(2, 2, 2));`,
    `  bvh.raycast(new THREE.Ray(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, -1, 0)), THREE.DoubleSide);`,
    `  console.log("physics settled y", body.translation().y.toFixed(2));`,
    `}`,
    ``,
  ].join("\n"));
  await fs.writeFile(path.join(site3d, "src", "main.ts"), `import { physicsBoot } from "./physics.js";\nvoid physicsBoot();\n`);
  const builtPhysics = await buildSite(ws3d);
  check("physics entry builds", builtPhysics.skipped === false, JSON.stringify(builtPhysics));
  // With code splitting the engine graph lands in shared chunks, not just
  // main.js — scan every emitted JavaScript output.
  const physicsJs = (await readJsTree(path.join(site3d, "js"))).join("");
  check("rapier wasm inlined into the bundle", physicsJs.includes("AGFzbQ"), `${(physicsJs.length / 1024).toFixed(0)}KB across js/`);
  check("three-mesh-bvh bundled", physicsJs.includes("MeshBVH"));
  await validateSite(site3d);
  check("physics game-3d validates against real declarations", true);

  console.log("\n== 2. net client import bundles cleanly; multiplayer game-2d ==");
  const ws2d = await scaffold("game-2d");
  const site2d = path.join(ws2d, "site");
  check("Phaser compact ESM seeded", await fs.stat(path.join(ws2d, "node_modules", "phaser", "dist", "phaser.esm.min.js")).then(() => true, () => false));
  check("Phaser real declarations seeded", await fs.stat(path.join(ws2d, "node_modules", "phaser", "types", "phaser.d.ts")).then(() => true, () => false));
  // The runtime build could go missing while the (old probe) type file stayed;
  // the freshness check now verifies every seed file and reseeds.
  await fs.rm(path.join(ws2d, "node_modules", "phaser", "dist", "phaser.esm.min.js"));
  check("missing runtime build reseeds", (await ensureEnginePackages(ws2d, "game-2d")) === true
    && await fs.stat(path.join(ws2d, "node_modules", "phaser", "dist", "phaser.esm.min.js")).then(() => true, () => false));
  // .gitignore is ensured, never replaced: pre-existing lines survive.
  await fs.writeFile(path.join(ws2d, ".gitignore"), "*.log\nsecrets.txt\n");
  check(".gitignore preserves existing entries", (await ensureEnginePackages(ws2d, "game-2d")) === true
    && (await fs.readFile(path.join(ws2d, ".gitignore"), "utf8")).split(/\r?\n/).includes("node_modules/")
    && (await fs.readFile(path.join(ws2d, ".gitignore"), "utf8")).includes("secrets.txt"));
  check("gitignore ensure idempotent", (await ensureEnginePackages(ws2d, "game-2d")) === false);
  await fs.mkdir(path.join(ws2d, "node_modules", "pixi.js"), { recursive: true });
  await fs.writeFile(path.join(ws2d, "node_modules", "pixi.js", "package.json"), "{}\n");
  // The v2 Phaser migration is complete: the freshness pass no longer scrubs
  // legacy packages; stray node_modules entries are inert (gitignored).
  check("legacy Pixi package is inert, not scrubbed", (await ensureEnginePackages(ws2d, "game-2d")) === false
    && (await fs.stat(path.join(ws2d, "node_modules", "pixi.js")).then(() => true, () => false)));
  await fs.writeFile(path.join(site2d, "src", "main.ts"), [
    `import * as Phaser from "phaser";`,
    `import { NET_CONFIG } from "../net/net-config.js";`,
    `import { ThreadSiteNet } from "../net/threadsite-net.js";`,
    `const app = document.getElementById("app");`,
    `if (app) app.textContent = \`phaser \${Phaser.VERSION} relay \${NET_CONFIG.url}\`;`,
    `// Typed envelopes: status/peer/event/intent/remote-player fields all resolve from the d.ts.`,
    `void ThreadSiteNet.createAuthoritativeSession({`,
    `  ...NET_CONFIG,`,
    `  mode: "single",`,
    `  name: "e2e",`,
    `  onStatus: (status, detail) => console.log(status, detail),`,
    `  onPeers: (peers) => console.log(peers.length),`,
    `  world: {`,
    `    schemaVersion: 1,`,
    `    capture: () => ({ runId: "run", tick: 1, state: { enemies: [] as { id: string; hp: number }[] } }),`,
    `    restore: ({ state }) => console.log(state.enemies),`,
    `    present: ({ state }) => console.log(state.enemies),`,
    `    onAuthorityStart: () => undefined,`,
    `    onAuthorityStop: () => undefined,`,
    `  },`,
    `}).then((net) => {`,
    `  net.transforms.publish({ x: 0, y: 0, alive: true, runId: net.run.current ?? "run" });`,
    `  net.presence.set({ ready: true });`,
    `  net.events.onReliable("hit", (ev) => console.log(ev.from, ev.cid, ev.type, ev.id));`,
    `  net.events.sendReliable("hit", { dmg: 1 });`,
    `  net.intents.on("move", (intent) => console.log(intent.from, intent.runId, intent.payload));`,
    `  const remote = net.transforms.sampleAll()[0];`,
    `  if (remote) console.log(remote.peer.id, remote.transform.x, remote.sample.ageMs);`,
    `  const sync = net.entities.syncCollection("enemies", {`,
    `    getId: (enemy: { id: string; hp: number }) => enemy.id,`,
    `    create: (enemy) => ({ ...enemy }),`,
    `    update: (local, enemy) => Object.assign(local, enemy),`,
    `    remove: () => undefined,`,
    `  });`,
    `  sync.apply([{ id: "e1", hp: 1 }]);`,
    `});`,
    ``,
  ].join("\n"));
  const built2d = await buildSite(ws2d);
  check("game-2d builds", built2d.skipped === false && built2d.emitted === 1, JSON.stringify(built2d));
  const ignored = (await fs.readFile(path.join(ws2d, ".gitignore"), "utf8")).split(/\r?\n/);
  check("generated build paths are gitignored; tracked net client is not",
    [".opencode/", "node_modules/", "scratch/", "site/js/", "build-manifest.json"].every((line) => ignored.includes(line))
      && !ignored.includes("site/net/"),
    ignored.join(", "));
  const bundle2d = await fs.readFile(path.join(site2d, "js", "main.js"), "utf8");
  check("phaser bundled", bundle2d.includes("Phaser") || bundle2d.includes("Scene"), `${(bundle2d.length / 1024).toFixed(0)}KB`);
  check("net client bundled", bundle2d.includes("ThreadSiteNet"));
  await validateSite(site2d);
  check("game-2d validates", true);
  check("game-2d gets curated skill set", skillNames("game-2d").includes("phaser-4")
    && await fs.stat(path.join(ws2d, ".opencode", "skills", "phaser-4", "SKILL.md")).then(() => true, () => false));

  console.log("\n== 3. sibling modules, extensionless + .js imports, dynamic import ==");
  const wsMod = await scaffold("site");
  const siteMod = path.join(wsMod, "site");
  check("site kind seeds no skill", (await ensureSkillFiles(wsMod, "site")) === false
    && !(await fs.stat(path.join(wsMod, ".opencode")).then(() => true, () => false)));
  await fs.writeFile(path.join(siteMod, "src", "player.ts"), "export class Player { name = \"p\"; }\n");
  await fs.writeFile(path.join(siteMod, "src", "util.ts"), "export const helper = (): number => 42;\n");
  await fs.writeFile(path.join(siteMod, "src", "main.ts"), [
    `import { Player } from "./player";`,
    `import { helper } from "./util.js";`,
    `const p = new Player();`,
    `console.log(p.name, helper());`,
    `const lazy = await import("./player");`,
    `console.log(typeof lazy.Player);`,
    ``,
  ].join("\n"));
  const builtMod = await buildSite(wsMod);
  const filesMod = await fs.readdir(path.join(siteMod, "js"));
  check("multi-chunk build with dynamic import", builtMod.emitted >= 2, `${builtMod.emitted}: ${filesMod.join(", ")}`);
  check("player module inlined or chunked", filesMod.includes("main.js"));
  await validateSite(siteMod);
  check("module site validates", true);

  console.log("\n== 4. stale prune when a source disappears ==");
  await fs.writeFile(path.join(siteMod, "src", "extra.ts"), "export const extra = 1; console.log(extra);\n");
  await buildSite(wsMod);
  const withExtra = await fs.readdir(path.join(siteMod, "js"));
  check("extra entry emitted", withExtra.includes("extra.js"), withExtra.join(", "));
  await fs.rm(path.join(siteMod, "src", "extra.ts"));
  const prunedBuild = await buildSite(wsMod);
  const afterPrune = await fs.readdir(path.join(siteMod, "js"));
  check("extra.js pruned", !afterPrune.includes("extra.js") && prunedBuild.pruned >= 1, `${afterPrune.join(", ")} pruned=${prunedBuild.pruned}`);
  await validateSite(siteMod);
  check("still validates after prune", true);

  console.log("\n== 5. failure: unresolved import (code-framed bundler error) ==");
  const wsBad = await scaffold("site");
  const siteBad = path.join(wsBad, "site");
  await fs.writeFile(path.join(siteBad, "src", "main.ts"), `import { Player } from "./player";\nconsole.log(Player);\n`);
  const msg = await expectThrow("build throws TypeScript compile error", () => buildSite(wsBad), /TypeScript compile error[\s\S]*Could not resolve "\.\/player"/);
  check("error carries source line", /main\.ts:1:\d+/.test(msg), msg.slice(0, 300));

  console.log("\n== 6. failure: misspelled vendored export fails the build ==");
  const wsTypo = await scaffold("game-3d");
  const siteTypo = path.join(wsTypo, "site");
  await fs.writeFile(path.join(siteTypo, "src", "main.ts"), `import { Scenee } from "three";\nconsole.log(Scenee);\n`);
  await expectThrow("bundler catches the bad export name with location", () => buildSite(wsTypo), /TypeScript compile error[\s\S]*No matching export[\s\S]*Scenee/);

  console.log("\n== 7. failure: undefined variable + wrong DOM id ==");
  const wsUndef = await scaffold("site");
  const siteUndef = path.join(wsUndef, "site");
  await fs.writeFile(path.join(siteUndef, "src", "main.ts"), `const el = document.getElementById("nope");\nconsole.log(el, undefinedVariable);\n`);
  await buildSite(wsUndef); // esbuild does not type-check: this must bundle fine
  await expectThrow("type gate rejects undefined variable", () => validateSite(siteUndef), /JavaScript type-check error[\s\S]*(undefinedVariable|Cannot find name)/);
  const wsId = await scaffold("site");
  const siteId = path.join(wsId, "site");
  await fs.writeFile(path.join(siteId, "src", "main.ts"), `const el = document.getElementById("missing-id");\nconsole.log(el);\n`);
  await buildSite(wsId);
  await expectThrow("element id mismatch rejected", () => validateSite(siteId), /Element ID mismatch[\s\S]*missing-id/);

  console.log("\n== 8. TypeScript outside src/ and .ts script src rejected ==");
  const wsOut = await scaffold("site");
  const siteOut = path.join(wsOut, "site");
  await fs.writeFile(path.join(siteOut, "js", "stray.ts"), "export const x = 1;\n");
  await expectThrow("stray .ts under js/ rejected", () => validateSite(siteOut), /TypeScript file site\/js\/stray\.ts is outside site\/src\//);
  const wsTsRef = await scaffold("site");
  const siteTsRef = path.join(wsTsRef, "site");
  await fs.writeFile(path.join(siteTsRef, "index.html"),
    `<!doctype html><html><body><script type="module" src="src/main.ts"></script></body></html>\n`);
  await expectThrow(".ts script src rejected", () => validateSite(siteTsRef), /points at TypeScript source/);

  console.log("\n== 9. legacy plain-JS project still works untouched ==");
  const wsLegacy = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-e2e-legacy-"));
  const siteLegacy = path.join(wsLegacy, "site");
  await fs.mkdir(path.join(siteLegacy, "js"), { recursive: true });
  await fs.writeFile(path.join(siteLegacy, "index.html"),
    `<!doctype html><html><body><main id="app"></main><script type="module" src="js/main.js"></script></body></html>\n`);
  await fs.writeFile(path.join(siteLegacy, "js", "main.js"),
    `const app = document.getElementById("app");\nif (app) app.textContent = "legacy";\n`);
  const builtLegacy = await buildSite(wsLegacy);
  check("legacy build skipped", builtLegacy.skipped === true, JSON.stringify(builtLegacy));
  await validateSite(siteLegacy);
  check("legacy validates through the js gate", true);

  console.log("\n== 10. import maps: agent-vendored pair passes, split-library 404 fails, node_modules is contained ==");
  const wsMap = await scaffold("game-3d");
  const siteMap = path.join(wsMap, "site");
  await buildSite(wsMap);
  // An agent that vendors the complete three.js pair by hand under site/assets/.
  await fs.mkdir(path.join(siteMap, "assets/vendor"), { recursive: true });
  await fs.copyFile("node_modules/three/build/three.module.js", path.join(siteMap, "assets/vendor/three.module.js"));
  await fs.copyFile("node_modules/three/build/three.core.js", path.join(siteMap, "assets/vendor/three.core.js"));
  await fs.writeFile(path.join(siteMap, "index.html"),
    `<!doctype html><html><body><main id="app"></main>` +
    `<script type="importmap">{"imports":{"three":"./assets/vendor/three.module.js"}}</script>` +
    `<script type="module">import * as THREE from "three"; console.log(THREE.REVISION);</script>` +
    `<script type="module" src="js/main.js"></script></body></html>\n`);
  await validateSite(siteMap);
  check("import map onto a fully vendored pair validates", true);

  // The exact incident: an agent hand-vendors only the ESM wrapper; its
  // internal ./three.core.js import 404s at runtime, invisible to every other
  // check. The resolution pass must fail the turn naming the missing file.
  const wsSplit = await scaffold("game-3d");
  const siteSplit = path.join(wsSplit, "site");
  await buildSite(wsSplit);
  await fs.mkdir(path.join(siteSplit, "assets/vendor/three"), { recursive: true });
  await fs.copyFile("node_modules/three/build/three.module.js", path.join(siteSplit, "assets/vendor/three/three.module.js"));
  await fs.writeFile(path.join(siteSplit, "index.html"),
    `<!doctype html><html><body><main id="app"></main>` +
    `<script type="importmap">{"imports":{"three":"./assets/vendor/three/three.module.js"}}</script>` +
    `<script type="module" src="js/main.js"></script></body></html>\n`);
  const splitMessage = await expectThrow("split-library import map fails validation",
    () => validateSite(siteSplit), /Broken local reference[\s\S]*three\.core\.js/);
  check("error names the missing sibling and the wrapper", /via site\/assets\/vendor\/three\/three\.module\.js/.test(splitMessage) && /three\.core\.js/.test(splitMessage), splitMessage.slice(0, 300));

  // The workspace node_modules is a build-time dependency, never published:
  // import maps or imports that reach outside site/ are broken references.
  const wsOutside = await scaffold("game-3d");
  const siteOutside = path.join(wsOutside, "site");
  await buildSite(wsOutside);
  await fs.writeFile(path.join(siteOutside, "index.html"),
    `<!doctype html><html><body><main id="app"></main>` +
    `<script type="importmap">{"imports":{"three":"../node_modules/three/build/three.module.js"}}</script>` +
    `<script type="module" src="js/main.js"></script></body></html>\n`);
  await expectThrow("import map reaching into node_modules is rejected", () => validateSite(siteOutside), /outside the site directory[\s\S]*node_modules/);

  const wsInline = await scaffold("site");
  const siteInline = path.join(wsInline, "site");
  await buildSite(wsInline);
  await fs.writeFile(path.join(siteInline, "index.html"),
    `<!doctype html><html><body><main id="app"></main>` +
    `<script type="module">import { helper } from "./js/missing.js"; console.log(helper);</script>` +
    `<script type="module" src="js/main.js"></script></body></html>\n`);
  await expectThrow("inline module import of a missing file fails", () => validateSite(siteInline), /Broken local reference[\s\S]*missing\.js/);

  console.log("\n== 11. legacy module script with a broken import fails ==");
  const wsLegacyBroken = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-e2e-legacy-broken-"));
  const siteLegacyBroken = path.join(wsLegacyBroken, "site");
  await fs.mkdir(path.join(siteLegacyBroken, "js"), { recursive: true });
  await fs.writeFile(path.join(siteLegacyBroken, "index.html"),
    `<!doctype html><html><body><main id="app"></main><script type="module" src="js/main.js"></script></body></html>\n`);
  await fs.writeFile(path.join(siteLegacyBroken, "js", "main.js"),
    `import { helper } from "./helpers.js";\nconst app = document.getElementById("app");\nif (app) app.textContent = helper;\n`);
  await expectThrow("legacy script-src module chain checked", () => validateSite(siteLegacyBroken), /(?:Broken local reference|JavaScript type-check error)[\s\S]*helpers\.js/);

  console.log("\n== 12. real engine types: idiomatic code passes, misuse fails ==");
  const wsTypes = await scaffold("game-3d");
  const siteTypes = path.join(wsTypes, "site");
  await fs.writeFile(path.join(siteTypes, "src", "main.ts"), [
    `import * as THREE from "three";`,
    ``,
    `const canvasHost = document.getElementById("app");`,
    `const scene = new THREE.Scene();`,
    `scene.background = new THREE.Color("#102030");`,
    `const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 200);`,
    `camera.position.set(0, 2, 8);`,
    `const renderer = new THREE.WebGLRenderer({ antialias: true });`,
    `renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));`,
    `renderer.setSize(960, 540);`,
    `if (canvasHost) canvasHost.appendChild(renderer.domElement);`,
    ``,
    `const light = new THREE.DirectionalLight(0xffffff, 2.5);`,
    `light.position.set(3, 5, 2);`,
    `scene.add(light, new THREE.AmbientLight(0x334455, 0.8));`,
    ``,
    `const geometry = new THREE.BoxGeometry(1, 1, 1);`,
    `const material = new THREE.MeshStandardMaterial({ color: 0x3fa9f5, roughness: 0.4 });`,
    `const cube = new THREE.Mesh(geometry, material);`,
    `cube.position.set(0, 0.5, 0);`,
    `scene.add(cube);`,
    `material.map = new THREE.Texture();`,
    ``,
    `const clock = new THREE.Clock();`,
    `const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x223344 }));`,
    `floor.rotation.x = -Math.PI / 2;`,
    `scene.add(floor);`,
    ``,
    `function tick(): void {`,
    `  const delta = Math.min(clock.getDelta(), 0.1);`,
    `  cube.rotation.y += delta;`,
    `  renderer.render(scene, camera);`,
    `  requestAnimationFrame(tick);`,
    `}`,
    `tick();`,
    ``,
  ].join("\n"));
  await buildSite(wsTypes);
  await validateSite(siteTypes);
  check("idiomatic three.js code passes the real-types gate", true);

  const wsPhaserTypes = await scaffold("game-2d");
  const sitePhaserTypes = path.join(wsPhaserTypes, "site");
  await fs.writeFile(path.join(sitePhaserTypes, "src", "main.ts"), [
    `import * as Phaser from "phaser";`,
    ``,
    `class DemoScene extends Phaser.Scene {`,
    `  constructor() { super("demo"); }`,
    `  create(): void {`,
    `    const box = this.add.rectangle(480, 270, 64, 64, 0x3fa9f5);`,
    `    this.tweens.add({ targets: box, angle: 360, duration: 1200, repeat: -1 });`,
    `  }`,
    `}`,
    `new Phaser.Game({ type: Phaser.AUTO, parent: "app", width: 960, height: 540, scene: DemoScene });`,
    ``,
  ].join("\n"));
  await buildSite(wsPhaserTypes);
  await validateSite(sitePhaserTypes);
  check("idiomatic Phaser code passes the real-types gate", true);

  const wsMisuse = await scaffold("game-3d");
  const siteMisuse = path.join(wsMisuse, "site");
  await fs.writeFile(path.join(siteMisuse, "src", "main.ts"), [
    `import * as THREE from "three";`,
    `const v = new THREE.Vector3("not a number");`,
    `console.log(v);`,
    ``,
  ].join("\n"));
  await buildSite(wsMisuse);
  await expectThrow("wrong three.js argument type fails the gate", () => validateSite(siteMisuse), /JavaScript type-check error[\s\S]*(Vector3|TS2345|not assignable)/);

  console.log("\n== 13. net client in site/net/: typed API, d.ts resolution, stale js/ copies removed ==");
  const wsNet = await scaffold("game-3d");
  const siteNet = path.join(wsNet, "site");
  // Legacy copies in site/js/ (pre-TypeSwitch layout) must be removed by the
  // harness, with the net/ files (including declarations) taking their place.
  await fs.writeFile(path.join(siteNet, "js", "threadsite-net.js"), "// stale legacy copy\n");
  await fs.writeFile(path.join(siteNet, "js", "net-config.js"), "// stale legacy copy\n");
  await ensureMultiplayerFiles(wsNet, { gameId: "e2e", wsUrl: "ws://localhost:8090/ws", protocolVersion: PROTOCOL_VERSION }, "game-3d");
  // Current contract: the harness never silently deletes project files —
  // stale js/ copies persist and the build/import gates reject using them.
  check("stale js/threadsite-net.js left for the gates (no silent deletion)", await fs.access(path.join(siteNet, "js", "threadsite-net.js")).then(() => true, () => false));
  check("stale js/net-config.js left for the gates (no silent deletion)", await fs.access(path.join(siteNet, "js", "net-config.js")).then(() => true, () => false));
  check("net client seeded in site/net", await fs.access(path.join(siteNet, "net", "threadsite-net.js")).then(() => true, () => false));
  check("net declarations seeded in site/net", await fs.access(path.join(siteNet, "net", "threadsite-net.d.ts")).then(() => true, () => false));
  check("net-config declarations seeded", await fs.access(path.join(siteNet, "net", "net-config.d.ts")).then(() => true, () => false));
  check("NETWORKING.md gotcha guide seeded at root", await fs.access(path.join(wsNet, "NETWORKING.md")).then(() => true, () => false));
  check("AGENTS.md references the networking guide", (await fs.readFile(path.join(wsNet, "AGENTS.md"), "utf8")).includes("NETWORKING.md"));
  await buildSite(wsNet);
  await validateSite(siteNet);
  check("net files validate (d.ts exempt from the src/-only rule)", true);

  const wsNetMisuse = await scaffold("game-2d");
  const siteNetMisuse = path.join(wsNetMisuse, "site");
  await fs.writeFile(path.join(siteNetMisuse, "src", "main.ts"), [
    `import { ThreadSiteNet } from "../net/threadsite-net.js";`,
    `void ThreadSiteNet.connect({ pstateHz: "fast", name: "x" });`,
    ``,
  ].join("\n"));
  await buildSite(wsNetMisuse); // esbuild does not type-check: bundles fine
  await expectThrow("wrong option type fails the gate via the d.ts", () => validateSite(siteNetMisuse), /JavaScript type-check error[\s\S]*(pstateHz|TS2322|not assignable)/);

  const wsNetLegacyImport = await scaffold("game-2d");
  const siteNetLegacyImport = path.join(wsNetLegacyImport, "site");
  await fs.writeFile(path.join(siteNetLegacyImport, "src", "main.ts"), [
    `import { ThreadSiteNet } from "../js/threadsite-net.js";`,
    `console.log(typeof ThreadSiteNet.connect);`,
    ``,
  ].join("\n"));
  await expectThrow("import of the old js/ net path fails the build", () => buildSite(wsNetLegacyImport), /TypeScript compile error[\s\S]*Could not resolve "\.\.\/js\/threadsite-net\.js"/);

  console.log("\n== 14. live legacy game survives the harness update turn ==");
  // A real pre-TypeSwitch game: authored js/main.js, imports the net client
  // from js/, an import map in the HTML. On its next turn the harness
  // deletes js/threadsite-net.js + js/net-config.js — the game must keep
  // working in the same turn (remap to site/net/) or fail loudly into the
  // repair round-trip, never ship broken.
  const wsLive = await scaffold("game-2d");
  const siteLive = path.join(wsLive, "site");
  // Rewind the scaffold to the legacy layout the game shipped with: authored
  // JS in js/ including the net client there, no src/.
  await fs.rm(path.join(siteLive, "src"), { recursive: true, force: true });
  await fs.rm(path.join(wsLive, "build-manifest.json"), { force: true }).catch(() => undefined);
  const legacyNet = await fs.readFile(path.join(siteLive, "net", "threadsite-net.js"), "utf8");
  await fs.writeFile(path.join(siteLive, "js", "threadsite-net.js"), legacyNet);
  await fs.writeFile(path.join(siteLive, "js", "net-config.js"),
    `/** @type {{protocol: number, game: string, url: string}} */\nexport const NET_CONFIG = Object.freeze({ protocol: ${PROTOCOL_VERSION}, game: \"e2e\", url: \"ws://localhost:8090/ws\" });\n`);
  await fs.writeFile(path.join(siteLive, "js", "main.js"),
    `import { NET_CONFIG } from "./net-config.js";\nimport { ThreadSiteNet } from "./threadsite-net.js";\nconst app = document.getElementById("app");\nif (app) app.textContent = \`legacy \${NET_CONFIG.game}\`;\nconsole.log(typeof ThreadSiteNet.connect);\n`);
  await fs.writeFile(path.join(siteLive, "index.html"),
    `<!doctype html><html><body><main id="app"></main><script type="module" src="js/main.js"></script></body></html>\n`);

  // The update turn: harness restore runs (removes the old js/ net copies,
  // seeds site/net/), then the deploy-tail build+validate — exactly what
  // completeTurn does before the agent is even prompted.
  await ensureMultiplayerFiles(wsLive, { gameId: "e2e", wsUrl: "ws://localhost:8090/ws", protocolVersion: PROTOCOL_VERSION }, "game-2d");
  check("legacy game's js/net copy preserved by restore", await fs.access(path.join(siteLive, "js", "threadsite-net.js")).then(() => true, () => false));
  const liveBuilt = await buildSite(wsLive);
  check("legacy project builds skipped (no src/)", liveBuilt.skipped === true, JSON.stringify(liveBuilt));
  const liveValidateError = await validateSite(siteLive).then(() => undefined, (error: unknown) => String((error as Error).message));
  // Two acceptable outcomes: passes as-is (nothing referenced the removed
  // file), or fails loudly through either repairable channel — the tsc gate
  // (TS2307 on the now-missing module) or the module-resolution pass (Broken
  // local reference). Both match the repair regex, so the agent fixes the
  // import the same turn, and AGENTS.md's legacy section documents the new
  // path. Silently shipping a broken page is the only unacceptable outcome.
  check("legacy game either validates or fails loudly (never ships broken)",
    liveValidateError === undefined || /Broken local reference|type-check error/.test(liveValidateError),
    liveValidateError ?? "validated");
  if (liveValidateError) {
    check("failure names the removed file so repair can fix it", /threadsite-net\.js|net-config\.js/.test(liveValidateError), liveValidateError.slice(0, 200));
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exitCode = 1;
}

void main();
