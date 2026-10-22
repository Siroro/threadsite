import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { createPreviewServer } from "../server.mjs";

const report = JSON.parse(await fs.readFile("/artifacts/report.json", "utf8"));
const config = JSON.parse(await fs.readFile("/app/browser-config.json", "utf8"));
const server = createPreviewServer({ workspaceRoot: "/workspace" });
await new Promise((resolve) => server.listen(8080, "127.0.0.1", resolve));
const browser = await chromium.launch(config.browser.launchOptions);
try {
  for (const project of report) {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ ...config.browser.contextOptions, viewport });
      await context.route("**/*", (route) => new URL(route.request().url()).origin === "http://127.0.0.1:8080" ? route.continue() : route.abort());
      try {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:8080/100/${project.threadId}/`, { waitUntil: "networkidle" });
        const script = await page.request.get(`http://127.0.0.1:8080/100/${project.threadId}/js/main.js`);
        assert.equal(createHash("sha256").update(await script.body()).digest("hex"), project.compiledHash,
          "Preview must use the production compiler output before publication's asset-version URL rewriting");
        const before = project.kind === "game-3d" ? await page.locator("canvas").first().screenshot() : undefined;
        await page.locator("#increment").click();
        assert.equal((await page.locator("#count").innerText()).trim(), "1");
        await page.locator("#increment").click();
        assert.equal((await page.locator("#count").innerText()).trim(), "2");
        if (project.kind === "site") {
          await page.locator("#reset").click();
          assert.equal((await page.locator("#count").innerText()).trim(), "0");
        } else {
          await page.keyboard.press("ArrowRight");
          assert.equal((await page.locator("#count").innerText()).trim(), "3");
          assert.ok(await page.locator("canvas").count());
          assert.equal(await page.locator("canvas").first().evaluate((canvas) => !!canvas.getContext("webgl2")), true);
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const after = await page.locator("canvas").first().screenshot();
          assert.ok(after.length > 1000, "The game should render a visible 3D scene");
          assert.notDeepEqual(after, before, "Rotating the cube must change the rendered pixels");
        }
        assert.deepEqual(errors, []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No horizontal overflow");
        await page.screenshot({ path: `/artifacts/${project.threadId}-${viewport.width}.png` });
        console.log(`PASS ${project.kind} browser interaction, clean runtime and layout at ${viewport.width}px`);
      } finally { await context.close(); }
    }
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
