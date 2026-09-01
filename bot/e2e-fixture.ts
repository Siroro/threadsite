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
import { ensureSkillFiles, skillNames } from "./src/skills.js";
import { starterSource } from "./src/starter.js";

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

async function scaffold(kind: "site" | "game-2d" | "game-3d"): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), `threadsite-e2e-${kind}-`));
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
    await ensureMultiplayerFiles(ws, { gameId: "e2e", wsUrl: "ws://localhost:8090/ws", protocolVersion: 3 }, kind);
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
  const skill3dPath = path.join(ws3d, ".opencode", "skills", "game-3d", "SKILL.md");
  const skill3d = await fs.readFile(skill3dPath, "utf8").catch(() => "");
  check("game-3d playbook skill seeded with frontmatter", skill3d.startsWith("---\n") && skill3d.includes("name: game-3d"));
  check("game-3d gets curated skill set", skillNames("game-3d").length === 24
    && await fs.stat(path.join(ws3d, ".opencode", "skills", "threejs-gltf-loading", "references")).then(() => true, () => false));
  await fs.rm(path.join(ws3d, ".opencode"), { recursive: true, force: true });
  check("skill reseeded after deletion", (await ensureSkillFiles(ws3d, "game-3d")) === true
    && (await fs.readFile(skill3dPath, "utf8")) === skill3d);
  await fs.writeFile(skill3dPath, "tampered\n");
  check("skill restored after content drift", (await ensureSkillFiles(ws3d, "game-3d")) === true
    && (await fs.readFile(skill3dPath, "utf8")) === skill3d);
  check("skill seed idempotent", (await ensureSkillFiles(ws3d, "game-3d")) === false);

  console.log("\n== 2. net client import bundles cleanly; multiplayer game-2d ==");
  const ws2d = await scaffold("game-2d");
  const site2d = path.join(ws2d, "site");
  await fs.writeFile(path.join(site2d, "src", "main.ts"), [
    `import * as PIXI from "pixi.js";`,
    `import { NET_CONFIG } from "../net/net-config.js";`,
    `import { ThreadSiteNet } from "../net/threadsite-net.js";`,
    `const app = document.getElementById("app");`,
    `if (app) app.textContent = \`pixi \${PIXI.VERSION} relay \${NET_CONFIG.url}\`;`,
    `// Typed envelope: ps.from/ps.cid/ps.state/ps.ts all resolve from the d.ts.`,
    `void ThreadSiteNet.connect({`,
    `  ...NET_CONFIG,`,
    `  mode: "single",`,
    `  name: "e2e",`,
    `  onPlayerState: (ps) => console.log(ps.cid, ps.state, ps.ts),`,
    `  onEvent: (ev) => console.log(ev.from, ev.type, ev.seq),`,
    `});`,
    ``,
  ].join("\n"));
  const built2d = await buildSite(ws2d);
  check("game-2d builds", built2d.skipped === false && built2d.emitted === 1, JSON.stringify(built2d));
  const bundle2d = await fs.readFile(path.join(site2d, "js", "main.js"), "utf8");
  check("pixi bundled", bundle2d.includes("Application"), `${(bundle2d.length / 1024).toFixed(0)}KB`);
  check("net client bundled", bundle2d.includes("ThreadSiteNet"));
  await validateSite(site2d);
  check("game-2d validates", true);
  check("game-2d gets curated skill set", skillNames("game-2d").length === 33
    && await fs.stat(path.join(ws2d, ".opencode", "skills", "pixijs-application", "references")).then(() => true, () => false));

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
  await fs.copyFile("node_modules/three/build/three.module.min.js", path.join(siteMap, "assets/vendor/three.module.min.js"));
  await fs.copyFile("node_modules/three/build/three.core.min.js", path.join(siteMap, "assets/vendor/three.core.min.js"));
  await fs.writeFile(path.join(siteMap, "index.html"),
    `<!doctype html><html><body><main id="app"></main>` +
    `<script type="importmap">{"imports":{"three":"./assets/vendor/three.module.min.js"}}</script>` +
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
  await fs.copyFile("node_modules/three/build/three.module.min.js", path.join(siteSplit, "assets/vendor/three/three.module.js"));
  await fs.writeFile(path.join(siteSplit, "index.html"),
    `<!doctype html><html><body><main id="app"></main>` +
    `<script type="importmap">{"imports":{"three":"./assets/vendor/three/three.module.js"}}</script>` +
    `<script type="module" src="js/main.js"></script></body></html>\n`);
  const splitMessage = await expectThrow("split-library import map fails validation",
    () => validateSite(siteSplit), /Broken local reference[\s\S]*three\.core\.min\.js/);
  check("error names the missing sibling and the wrapper", /via site\/assets\/vendor\/three\/three\.module\.js/.test(splitMessage) && /three\.core\.min\.js/.test(splitMessage), splitMessage.slice(0, 300));

  // The workspace node_modules is a build-time dependency, never published:
  // import maps or imports that reach outside site/ are broken references.
  const wsOutside = await scaffold("game-3d");
  const siteOutside = path.join(wsOutside, "site");
  await buildSite(wsOutside);
  await fs.writeFile(path.join(siteOutside, "index.html"),
    `<!doctype html><html><body><main id="app"></main>` +
    `<script type="importmap">{"imports":{"three":"../node_modules/three/build/three.module.min.js"}}</script>` +
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

  const wsPixiTypes = await scaffold("game-2d");
  const sitePixiTypes = path.join(wsPixiTypes, "site");
  await fs.writeFile(path.join(sitePixiTypes, "src", "main.ts"), [
    `import { Application, Sprite, Texture, Container } from "pixi.js";`,
    ``,
    `const app = new Application();`,
    `await app.init({ width: 960, height: 540, background: "#102030" });`,
    `const host = document.getElementById("app");`,
    `if (host) host.appendChild(app.canvas);`,
    ``,
    `const world = new Container();`,
    `app.stage.addChild(world);`,
    `const sprite = new Sprite(Texture.WHITE);`,
    `sprite.anchor.set(0.5);`,
    `sprite.position.set(480, 270);`,
    `sprite.width = 64;`,
    `sprite.height = 64;`,
    `world.addChild(sprite);`,
    ``,
    `app.ticker.add((ticker) => { sprite.rotation += ticker.deltaMS * 0.001; });`,
    ``,
  ].join("\n"));
  await buildSite(wsPixiTypes);
  await validateSite(sitePixiTypes);
  check("idiomatic PixiJS code passes the real-types gate", true);

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
  await ensureMultiplayerFiles(wsNet, { gameId: "e2e", wsUrl: "ws://localhost:8090/ws", protocolVersion: 3 }, "game-3d");
  check("stale js/threadsite-net.js removed", await fs.access(path.join(siteNet, "js", "threadsite-net.js")).then(() => false, () => true));
  check("stale js/net-config.js removed", await fs.access(path.join(siteNet, "js", "net-config.js")).then(() => false, () => true));
  check("net client seeded in site/net", await fs.access(path.join(siteNet, "net", "threadsite-net.js")).then(() => true, () => false));
  check("net declarations seeded in site/net", await fs.access(path.join(siteNet, "net", "threadsite-net.d.ts")).then(() => true, () => false));
  check("net-config declarations seeded", await fs.access(path.join(siteNet, "net", "net-config.d.ts")).then(() => true, () => false));
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

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exitCode = 1;
}

void main();
