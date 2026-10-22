// Run inside the isolated preview service after compose/bot.mjs has authored
// and published its Excalibur fixture. Use the production browser options.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { createPreviewServer } from "../server.mjs";

const config = JSON.parse(await fs.readFile("/app/browser-config.json", "utf8"));
// A separate fixture container avoids launching a second Chromium alongside
// MCP's warm browser under the production process limit.
const server = createPreviewServer({ workspaceRoot: "/workspace" });
await new Promise((resolve) => server.listen(8080, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch(config.browser.launchOptions);
  for (const deviceScaleFactor of [1, 1.25, 2]) {
    const context = await browser.newContext({
      ...config.browser.contextOptions, deviceScaleFactor,
    });
    // Match the production preview's local-origin boundary.
    await context.route("**/*", (route) => new URL(route.request().url()).origin === "http://127.0.0.1:8080"
      ? route.continue() : route.abort());
    try {
      const page = await context.newPage();
      await page.goto("http://127.0.0.1:8080/100/201/", { waitUntil: "networkidle" });
      await page.waitForFunction(() => window.smokeReady === true);
      for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await page.waitForFunction(() => {
          const canvas = document.querySelector("#game canvas");
          if (!canvas) return false;
          const bounds = canvas.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0
            && Math.abs(canvas.width - bounds.width * devicePixelRatio) <= 1
            && Math.abs(canvas.height - bounds.height * devicePixelRatio) <= 1;
        });
        const size = await page.locator("#game canvas").evaluate((canvas) => ({
          width: canvas.width, height: canvas.height,
          cssWidth: canvas.getBoundingClientRect().width,
          hostWidth: canvas.parentElement.getBoundingClientRect().width,
        }));
        assert.ok(Math.abs(size.cssWidth - size.hostWidth) <= 1, "Canvas must follow the host after resize");
        assert.equal(size.height, 200 * deviceScaleFactor);
        const screenshot = await page.locator("#game canvas").screenshot();
        assert.equal(screenshot.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
        const captured = { width: screenshot.readUInt32BE(16), height: screenshot.readUInt32BE(20) };
        const dimensions = JSON.stringify({ deviceScaleFactor, viewport, size, captured });
        // Locator screenshots round outward around fractional CSS origins
        // (e.g. text above the canvas can place it at y=302.4). That adds at
        // most one CSS pixel to the capture, without scaling the framebuffer.
        const clipRounding = Math.ceil(deviceScaleFactor);
        assert.ok(Math.abs(captured.width - size.width) <= clipRounding, `Screenshot width must match the native framebuffer: ${dimensions}`);
        assert.ok(Math.abs(captured.height - size.height) <= clipRounding, `Screenshot height must match the native framebuffer: ${dimensions}`);
      }
      console.log(`PASS Excalibur native canvas resolution at ${deviceScaleFactor}x density, desktop and phone sizes`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
