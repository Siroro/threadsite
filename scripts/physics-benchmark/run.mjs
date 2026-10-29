import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";

const root = path.dirname(fileURLToPath(import.meta.url));
const botRequire = createRequire(new URL("../../bot/package.json", import.meta.url));
const previewRequire = createRequire(new URL("../../preview/package.json", import.meta.url));
const { build } = botRequire("esbuild");
const out = path.join(root, "dist");
const serve = process.argv.includes("--serve");
const skip = process.argv.includes("--skip-benchmark");
const repetitions = 6;
const sceneNames = ["arena", "stacks", "projectiles", "queries", "sleeping"];
const aliases = {
  "@dimforge/rapier3d-compat": path.join(path.dirname(botRequire.resolve("@dimforge/rapier3d-compat")), "rapier.mjs"),
  three: path.join(path.dirname(botRequire.resolve("three")), "three.module.js"),
};
const options = {
  absWorkingDir: root, bundle: true, format: "esm", target: "es2022",
  minify: true, legalComments: "eof", sourcemap: false, metafile: true,
  preserveSymlinks: true, logLevel: "silent", alias: aliases,
};
// Fail rather than silently labelling a future installed dependency as this comparison's pin.
for (const [name, version] of [["@dimforge/rapier3d-compat", "0.21.0"], ["three", "0.186.1"], ["esbuild", "0.28.2"]]) {
  const installed = JSON.parse(await fs.readFile(path.resolve(path.dirname(botRequire.resolve(name)), "../package.json"), "utf8"));
  if (installed.version !== version) throw new Error(`Expected ${name} ${version}; found ${installed.version}. Update comparison metadata before measuring.`);
}
await fs.mkdir(path.join(out, "engines"), { recursive: true });
const sizes = {};
for (const [name, input, output] of [["rapier", "rapier.ts", "engines/rapier.js"], ["box3d", "box3d.ts", "engines/box3d.js"], ["shared viewer", "demo.ts", "demo.js"]]) {
  const result = await build({ ...options, entryPoints: [input], outfile: path.join(out, output) });
  if (result.warnings.length) throw new Error(JSON.stringify(result.warnings));
  const bytes = await fs.readFile(path.join(out, output));
  sizes[name] = { raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length, brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length };
}
for (const engine of ["rapier", "box3d"]) sizes[`${engine} + viewer`] = Object.fromEntries(["raw", "gzip", "brotli"].map(key => [key, sizes[engine][key] + sizes["shared viewer"][key]]));
await fs.writeFile(path.join(out, "sizes.json"), JSON.stringify(sizes, null, 2));
await fs.copyFile(path.join(root, "index.html"), path.join(out, "index.html"));
await fs.copyFile(path.join(root, "../../docs/physics-comparison.md"), path.join(out, "comparison.md"));
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".md": "text/plain; charset=utf-8", ".png": "image/png" };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const target = path.resolve(out, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!target.startsWith(out + path.sep)) { response.writeHead(403).end(); return; }
    const data = await fs.readFile(target);
    response.writeHead(200, {
      "content-type": types[path.extname(target)] || "application/octet-stream", "cache-control": "no-store",
      // High-resolution timestamps for sub-millisecond steps; both WASM builds remain single threaded.
      "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp",
    }).end(data);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(serve ? 8793 : 0, "127.0.0.1", resolve); });
const url = `http://127.0.0.1:${server.address().port}`;
console.log(`Demo: ${url}`);

function median(values) { const sorted = [...values].sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2; }
function summarize(runs) {
  return sceneNames.flatMap(scene => ["rapier", "box3d"].map(engine => {
    const matching = runs.filter(run => run.engine === engine && run.scene === scene);
    return { engine, scene, stepP50: median(matching.map(run => run.step.p50)), queryP50: median(matching.map(run => run.query.p50)), tickP50: median(matching.map(run => run.tick.p50)), tickP95: median(matching.map(run => run.tick.p95)), tickMean: median(matching.map(run => run.tick.mean)), minRunP50: Math.min(...matching.map(run => run.tick.p50)), maxRunP50: Math.max(...matching.map(run => run.tick.p50)), awake: matching.map(run => run.health.awake) };
  }));
}
function report(data) {
  const lines = ["# ThreadSite local physics comparison", "", `Measured ${data.measuredAt}. ${data.environment.cpu}; ${data.environment.platform}; ${data.environment.browser}.`, "", "Single-threaded browser WASM. Six repetitions with alternating engine order and rotating scene order. Each scene gets a fresh world; each engine/repetition gets a fresh page. Warmup: 120 ticks (600 for settled props); measured: 600 ticks in 60 ten-tick batches. Rendering excluded. p50/p95 describe batch averages, aggregated as the median across repetitions; p95 is not an individual-frame tail latency.", "", "| Scene | Engine | Step p50 ms | Rays p50 ms | Tick p50 ms | Tick p95 ms | Run p50 range ms |", "| --- | --- | ---: | ---: | ---: | ---: | ---: |"];
  for (const row of data.summary) lines.push(`| ${row.scene} | ${row.engine} | ${row.stepP50.toFixed(4)} | ${row.scene === "queries" ? row.queryP50.toFixed(4) : "—"} | ${row.tickP50.toFixed(4)} | ${row.tickP95.toFixed(4)} | ${row.minRunP50.toFixed(4)}–${row.maxRunP50.toFixed(4)} |`);
  lines.push("", "| Bundle | Raw bytes | Gzip bytes | Brotli bytes |", "| --- | ---: | ---: | ---: |");
  for (const [name, size] of Object.entries(data.sizes)) lines.push(`| ${name} | ${size.raw} | ${size.gzip} | ${size.brotli} |`);
  lines.push("", "## Stack quality", "", "| Engine | Lowest top-crate center, m | Maximum horizontal drift, m |", "| --- | ---: | ---: |");
  for (const engine of ["rapier", "box3d"]) {
    const stacks = data.runs.filter(run => run.engine === engine && run.scene === "stacks");
    lines.push(`| ${engine} | ${Math.min(...stacks.map(run => run.health.stackMinTopY)).toFixed(5)} | ${Math.max(...stacks.map(run => run.health.stackMaxDrift)).toFixed(5)} |`);
  }
  lines.push("", "Local server uses COOP/COEP for timer precision; no solver threads. Observed minimum timer increment: " + data.environment.minObservedTimerDeltaMs.toFixed(6) + " ms.");
  lines.push("", "## Settings and limits", "", "- Rapier compat 0.21.0 (the repository pin); box3d.js 0.1.1 (third-party bindings); Three.js 0.186.1; esbuild 0.28.2. Both physics bundles contain embedded WASM and the same adapter surface.", "- 60 Hz, gravity −9.81 m/s², density 1, friction 0.5, restitution 0, no damping. Sleeping disabled except in settled props. Both use sensor entry/exit polling, with contact events disabled.", "- Rapier: 4 solver iterations, default CCD substep limit. Box3D: 4 substeps, continuous collision enabled. These are practical configurations, not equal computational work or a proof of equal physical accuracy.", "- Tick includes steering, projectile resets, stepping, sensor polling, 128 rays in the query workload, pose reads and numerical/ground/CCD diagnostics. Step excludes that application and binding work. Arena actors use shared velocity steering with locked rotation, not character controllers.", "- Package initialization is recorded separately (warm OS/browser cache, fetch/import/compile included); not a controlled cold-start benchmark. No network transfer, memory, mobile hardware, multiplayer determinism, vehicles or ragdolls benchmarked.", "- Gzip level 9; Brotli quality 11. Full demo totals sum the separately compressed viewer and selected engine. Engine bundles include adapters; this is not npm unpacked size.", "- Live demo timings include interactive scheduling effects. Use the CLI measurements for comparisons; the in-page button performs one quick repetition.", "", "## Behavioral checks", "", "Each engine passes falling-body ground collision, sensor entry and exit, raycasts and removal from queries before timing. Worlds are repeatedly destroyed and recreated. Every measured tick checks finite poses, bodies below ground, and projectile wall crossings. Query workloads require all downward rays to hit. Settled props must actually sleep.", "", `Validation: ${JSON.stringify(data.validation)}`, "", "## Sources", "", "- https://github.com/isaac-mason/box3d.js", "- https://github.com/erincatto/box3d", "- https://rapier.rs/docs/user_guides/javascript/character_controller/", "", "Raw timings and environment: results.json.");
  return lines.join("\n") + "\n";
}

let browser;
try {
  if (!skip) {
    const { chromium } = previewRequire("playwright");
    let channel;
    const candidates = [...(process.env.PHYSICS_BROWSER_CHANNEL ? [process.env.PHYSICS_BROWSER_CHANNEL] : []), "msedge", "chrome", undefined];
    for (const candidate of candidates.filter((item, index, all) => all.indexOf(item) === index)) {
      try { browser = await chromium.launch({ headless: true, ...(candidate ? { channel: candidate } : {}) }); channel = candidate || "bundled chromium"; break; } catch (error) { if (candidate === undefined) throw error; }
    }
    const environment = { cpu: os.cpus()[0].model.trim(), logicalProcessors: os.cpus().length, platform: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version, browser: `${channel} ${browser.version()}`, headless: true, crossOriginIsolated: true, minObservedTimerDeltaMs: null, hardwareConcurrency: null };
    const runs = [], validation = {}, initialization = [];
    const errors = [];
    for (let repetition = 0; repetition < repetitions; repetition++) {
      for (const engine of repetition % 2 ? ["box3d", "rapier"] : ["rapier", "box3d"]) {
        const page = await browser.newPage();
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(`${url}/?bench`);
        await page.waitForFunction(() => !!window.physicsBench);
        environment.hardwareConcurrency = await page.evaluate(() => navigator.hardwareConcurrency);
        environment.minObservedTimerDeltaMs = await page.evaluate(() => {
          let previous = performance.now(), minimum = Infinity;
          for (let i = 0; i < 100000; i++) { const now = performance.now(); if (now > previous) minimum = Math.min(minimum, now - previous); previous = now; }
          return minimum;
        });
        const initMs = await page.evaluate(engine => window.physicsBench.initialize(engine), engine);
        initialization.push({ engine, repetition, milliseconds: initMs });
        validation[engine] = await page.evaluate(engine => window.physicsBench.verify(engine), engine);
        for (let offset = 0; offset < sceneNames.length; offset++) {
          const name = sceneNames[(offset + repetition) % sceneNames.length];
          const result = await page.evaluate(({ engine, name }) => window.physicsBench.run(engine, name), { engine, name });
          const health = result.health;
          if (health.invalid || health.belowGround || health.throughWall) throw new Error(`${engine}/${name}: ${JSON.stringify(health)}`);
          if (name === "queries" && health.rayHits !== health.ticks * 128) throw new Error(`${engine}: missing ground ray hits`);
          if (name === "sleeping" && health.awake !== 0) throw new Error(`${engine}: settled props did not all sleep (${health.awake})`);
          runs.push({ engine, repetition, ...result });
          console.log(`${repetition + 1}/${repetitions} ${engine.padEnd(6)} ${name.padEnd(11)} tick p50 ${result.tick.p50.toFixed(4)} ms; awake ${health.awake}`);
        }
        await page.close();
      }
    }
    if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
    const data = { measuredAt: new Date().toISOString(), versions: { rapier: "0.21.0", box3dJs: "0.1.1", three: "0.186.1", esbuild: "0.28.2" }, environment, repetitions, sizes, validation, initialization, summary: summarize(runs), runs };
    await fs.writeFile(path.join(out, "results.json"), JSON.stringify(data, null, 2) + "\n");
    await fs.writeFile(path.join(out, "report.md"), report(data));
    // Check that both adapters actually render, and that changing scenes/restarting is safe.
    const demo = await browser.newPage({ viewport: { width: 1440, height: 1150 } });
    const demoErrors = []; demo.on("pageerror", error => demoErrors.push(error.message));
    await demo.goto(url); await demo.waitForFunction(() => window.demoReady);
    for (const engine of ["box3d", "rapier"]) {
      await demo.selectOption("#engine", engine);
      await demo.waitForFunction(() => window.demoReady);
      for (const name of sceneNames) {
        await demo.selectOption("#scene", name); await demo.waitForFunction(() => window.demoReady);
        await demo.waitForTimeout(250);
      }
      await demo.click("#restart"); await demo.waitForFunction(() => window.demoReady);
    }
    await demo.selectOption("#engine", "box3d"); await demo.waitForFunction(() => window.demoReady);
    await demo.selectOption("#scene", "arena"); await demo.waitForFunction(() => window.demoReady);
    await demo.waitForTimeout(1200);
    await demo.screenshot({ path: path.join(out, "demo.png"), fullPage: true });
    await demo.click("#pause");
    const pausedTicks = await demo.evaluate(() => window.physicsBench.state().ticks);
    await demo.waitForTimeout(150);
    if (await demo.evaluate(() => window.physicsBench.state().ticks) !== pausedTicks) throw new Error("Simulation advanced while paused");
    await demo.click("#pause");
    await demo.waitForFunction(ticks => window.physicsBench.state().ticks > ticks, pausedTicks);
    // Exercise the interactive comparison path too, including recovery back into the live demo.
    await demo.click("#run");
    await demo.waitForFunction(() => !document.querySelector("#run").disabled, null, { timeout: 60000 });
    const uiError = await demo.evaluate(() => window.physicsBench.state().error);
    if (uiError) throw new Error(`Interactive comparison failed: ${uiError}`);
    await demo.click("#restart"); await demo.waitForFunction(() => window.demoReady);
    await demo.waitForFunction(() => window.physicsBench.state().ticks > 0);
    if (demoErrors.length) throw new Error(`Demo errors: ${demoErrors.join("; ")}`);
    await demo.close();
    console.log(`Report: ${path.join(out, "report.md")}`);
    console.log(JSON.stringify({ summary: data.summary, sizes }, null, 2));
  }
} catch (error) {
  await browser?.close(); server.close(); throw error;
} finally { await browser?.close(); if (!serve) server.close(); }
if (serve) console.log(`Serving demo at ${url}. Ctrl+C to stop.`);
