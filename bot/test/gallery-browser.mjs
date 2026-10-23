// Real Chromium checks against an isolated gallery. Uses preview's existing
// Playwright dependency; never reads live projects or changes published sites.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { chromium } from "../../preview/node_modules/playwright/index.mjs";
import { renderGallery } from "../src/gallery.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-gallery-browser-"));
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const file = path.resolve(root, `.${pathname.endsWith("/") ? `${pathname}index.html` : pathname}`);
    if (!file.startsWith(path.resolve(root) + path.sep)) { res.writeHead(403); res.end(); return; }
    const bytes = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": file.endsWith(".svg") ? "image/svg+xml" : "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const projects = [];
const names = ["Circuit Breaker", "Orbit Garden", "Soft Focus", "Pixel Pantry", "The Quiet Atlas", "Moonbase After Hours", "Little Field Notes", "Static Bloom", "Afterglow Arcade", "Paper Planets", "Pocket Weather", "The Last Lighthouse", "Marble Theory", "Signal / Noise", "Fern & Form", "Mosslight"];
const pitches = ["Take the long way home. A neon-lit racer with tight corners and no brakes.", "A tiny solar system. A very big playground. Build your own orbit.", "A slower corner of the internet, for seeing things a little differently.", "Tiny ingredients. Big kitchen energy. Cook up a little pixel chaos.", "A field guide to places that only exist in your imagination.", "The shift is over. The fun is just getting started."];
function artwork(index) {
  const palette = [["#171337", "#f983cd", "#826aff"], ["#102f36", "#d4eb9b", "#5abbb4"], ["#c4b18a", "#f8efd3", "#526553"], ["#32214e", "#e6a96c", "#8e6b9f"], ["#254637", "#dbdb91", "#81a587"], ["#13273e", "#83b7ee", "#e2d4a5"]][index % 6];
  const [bg, accent, secondary] = palette;
  const grid = Array.from({ length: 15 }, (_, i) => `<path d="M${i * 80 - 160} 450 400 160M0 ${220 + i * 20}h800" stroke="${secondary}" opacity=".18"/>`).join("");
  const orbit = `<ellipse cx="405" cy="225" rx="240" ry="100" fill="none" stroke="${secondary}" opacity=".5" transform="rotate(-22 405 225)"/><ellipse cx="405" cy="225" rx="160" ry="67" fill="none" stroke="${accent}" opacity=".3" transform="rotate(35 405 225)"/><circle cx="405" cy="225" r="65" fill="url(#planet)"/><circle cx="600" cy="130" r="17" fill="${accent}"/><circle cx="260" cy="315" r="11" fill="${secondary}"/>`;
  const race = `${grid}<path d="M-80 450 365 220h90L880 450" fill="#ffffff07" stroke="${accent}" stroke-width="2"/><path d="M325 390h150l-30-62h-90Z" fill="#181a32" stroke="${accent}" stroke-width="2"/><path d="M340 375h120m-100-40h80" stroke="${accent}" stroke-width="6"/><circle cx="600" cy="120" r="48" fill="${accent}" opacity=".8"/><path d="M0 210h800" stroke="${secondary}" opacity=".4"/>`;
  const paper = `<rect x="180" y="70" width="440" height="320" rx="5" fill="${accent}" transform="rotate(-5 400 220)"/><rect x="195" y="70" width="420" height="320" rx="5" fill="#efe9d8"/><rect x="226" y="102" width="358" height="177" fill="${secondary}"/><path d="m230 279 90-110 70 60 73-90 120 140" fill="${bg}"/><circle cx="501" cy="143" r="25" fill="${accent}"/><path d="M227 308h180m-180 22h300m-300 15h245" stroke="${secondary}" stroke-width="5" opacity=".6"/>`;
  const pixels = Array.from({ length: 22 }, (_, i) => `<rect x="${150 + i % 7 * 73}" y="${72 + Math.floor(i / 7) * 80}" width="52" height="52" rx="${i % 2 ? 8 : 0}" fill="${i % 3 ? accent : secondary}" opacity="${i % 5 ? .65 : 1}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450"><defs><radialGradient id="planet" cx=".3" cy=".3"><stop stop-color="${accent}"/><stop offset="1" stop-color="${secondary}"/></radialGradient><radialGradient id="light"><stop stop-color="${secondary}" stop-opacity=".3"/><stop offset="1" stop-color="${bg}" stop-opacity="0"/></radialGradient></defs><rect width="800" height="450" fill="${bg}"/><ellipse cx="400" cy="200" rx="360" ry="280" fill="url(#light)"/>${index % 4 === 0 ? race : index % 4 === 1 ? orbit : index % 4 === 2 ? paper : pixels}<text x="30" y="420" fill="${accent}" font-family="monospace" font-size="11" letter-spacing="3" opacity=".6">THREADSITE / SAMPLE PROJECT ${String(index + 1).padStart(2, "0")}</text></svg>`;
}

for (const [index, name] of names.entries()) {
  const id = (index + 1).toString(16).padStart(20, "0");
  const kind = index % 4 === 2 ? "site" : index % 3 === 1 ? "game-3d" : "game-2d";
  const image = index === 15 ? null : `${origin}/cover-${index}.svg`;
  if (image) await fs.writeFile(path.join(root, `cover-${index}.svg`), artwork(index));
  await fs.mkdir(path.join(root, "projects", id), { recursive: true });
  await fs.writeFile(path.join(root, "projects", id, "index.html"), `<title>Sample ${index + 1}</title><h1>Sample project ${index + 1}</h1>`);
  projects.push({ id, name, kind, mode: kind === "site" ? null : ["arena", "rooms", "singleplayer"][index % 3], url: `${origin}/projects/${id}/`, source: `${origin}/source/${id}`, image,
    pitch: pitches[index % pitches.length], play: kind === "site" ? "Explore the collection and follow your curiosity." : "Move with WASD or the arrow keys. Use Space to interact. On a phone, use the on-screen controls.",
    changeTitle: "A little more to explore", change: "New paths, better controls and a few delightful details.", createdAt: new Date(Date.UTC(2026, 9, 1 + index)).toISOString(), updatedAt: new Date(Date.UTC(2026, 9, 23 - index)).toISOString() });
}
await fs.writeFile(path.join(root, "index.html"), await renderGallery(projects));
let browser;
const errors = [];
try {
  browser = await chromium.launch({ headless: true, ...(process.env.GALLERY_BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.GALLERY_BROWSER_EXECUTABLE_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(origin);
  await page.locator("#result-count").waitFor();
  await page.waitForFunction(() => !document.querySelector(".discovery-tools").hidden);
  assert.equal(await page.locator(".project-card").count(), 12);
  await page.locator("#sort-order").selectOption("az");
  assert.equal(await page.locator(".project-card").first().getAttribute("data-project-id"), projects.toSorted((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true }))[0].id);
  await page.locator("#sort-order").selectOption("newest");
  assert.equal(await page.locator(".project-card").first().getAttribute("data-project-id"), projects.at(-1).id);
  await page.locator("#sort-order").selectOption("updated");
  await page.locator("[data-action=more]").click();
  assert.equal(await page.locator(".project-card").count(), 16);
  assert.equal(new URL(page.url()).searchParams.get("page"), "2");
  await page.locator("#gallery-search").fill("racer neon");
  assert.ok(await page.locator(".project-card").count() > 0);
  assert.ok(await page.locator(".project-card").count() < 16);
  await page.locator("#gallery-search").fill("no-project-could-possibly-match");
  assert.equal(await page.locator(".project-card").count(), 0);
  assert.equal(await page.locator("#empty-state").isVisible(), true);
  await page.locator(".results-toolbar [data-action=reset]").click();
  await page.locator('[data-type="game-3d"]').click();
  await page.locator("#mode-filter").selectOption("rooms");
  const matches = projects.filter((p) => p.kind === "game-3d" && p.mode === "rooms");
  assert.equal(await page.locator(".project-card").count(), matches.length);
  await page.locator('[data-action="surprise"]:visible').click();
  assert.equal(await page.locator("#project-dialog").isVisible(), true);
  assert.ok(matches.some((p) => p.id === new URL(page.url()).searchParams.get("project")));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !new URL(location.href).searchParams.has("project"));
  await page.goBack();
  assert.equal(await page.locator("#mode-filter").inputValue(), "rooms");
  await page.goBack();
  assert.equal(await page.locator("#mode-filter").inputValue(), "all");
  await page.locator('[data-nav="all"]').click();
  const firstId = await page.locator(".project-card").first().getAttribute("data-project-id");
  await page.locator(`.project-card [data-save="${firstId}"]`).click();
  await page.locator('[data-collection="saved"]').click();
  assert.equal(await page.locator(".project-card").count(), 1);
  await page.reload();
  assert.equal(await page.locator(".project-card").count(), 1);
  const secondTab = await context.newPage(); await secondTab.goto(page.url());
  await page.locator(`.project-card [data-save="${firstId}"]`).click();
  await secondTab.waitForFunction(() => document.querySelectorAll(".project-card").length === 0);
  await secondTab.close();
  await page.locator('[data-nav="all"]').click();
  const popupPromise = page.waitForEvent("popup");
  await page.locator(".project-card [data-open]").first().click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  assert.ok(popup.url().startsWith(`${origin}/projects/`));
  await popup.close();
  await page.locator('[data-collection="recent"]').click();
  assert.equal(await page.locator(".project-card").count(), 1);
  await page.locator("[data-details]").first().click();
  assert.equal(await page.locator("#project-dialog").isVisible(), true);
  assert.equal(await page.locator("#detail-play").textContent(), projects.find((p) => p.id === new URL(page.url()).searchParams.get("project")).play);
  await page.reload();
  assert.equal(await page.locator("#project-dialog").isVisible(), true);
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.querySelector("#project-dialog").contains(document.activeElement)), true);
  // Clipboard access is deliberately mocked so QA never touches the user's clipboard.
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { window.copiedGalleryLink = text; } } }));
  await page.locator('[data-action="share-project"]').click();
  assert.equal(new URL(await page.evaluate(() => window.copiedGalleryLink)).searchParams.get("project"), firstId);
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("blocked"); } } }));
  await page.locator('[data-action="share-project"]').click();
  assert.equal(await page.locator("#share-dialog").isVisible(), true);
  assert.equal(new URL(await page.locator("#share-link").inputValue()).searchParams.get("project"), firstId);
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
  await page.locator('[data-nav="all"]').click();
  await page.locator('[data-view="list"]').click();
  await page.reload();
  assert.equal(await page.locator("#project-grid").getAttribute("data-view"), "list");
  await page.locator('[data-action="theme"]').click();
  await page.reload();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.keyboard.press("/");
  assert.equal(await page.locator("#gallery-search").evaluate((input) => document.activeElement === input), true);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no overflow at ${width}px`);
  }
  await page.locator('[data-action="theme"]').click();
  await page.locator('[data-view="grid"]').click();
  await page.setViewportSize({ width: 1440, height: 1250 });
  await page.evaluate(() => document.activeElement?.blur());
  if (process.env.GALLERY_SCREENSHOT_DIR) {
    await fs.mkdir(process.env.GALLERY_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.GALLERY_SCREENSHOT_DIR, "threadsite-gallery-desktop.png") });
    await page.locator("[data-details]").first().click();
    await page.screenshot({ path: path.join(process.env.GALLERY_SCREENSHOT_DIR, "threadsite-gallery-details.png") });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: path.join(process.env.GALLERY_SCREENSHOT_DIR, "threadsite-gallery-mobile.png") });
  }

  const blocked = await browser.newContext();
  await blocked.addInitScript(() => Object.defineProperty(window, "localStorage", { get() { throw new Error("storage denied"); } }));
  const blockedPage = await blocked.newPage(); await blockedPage.goto(origin);
  await blockedPage.locator(".project-card [data-save]").first().click();
  await blockedPage.locator('[data-collection="saved"]').click();
  assert.equal(await blockedPage.locator(".project-card").count(), 1);
  assert.equal(await blockedPage.locator("#toast").isVisible(), true);
  await blockedPage.reload();
  assert.equal(await blockedPage.locator(".project-card").count(), 0);
  await blocked.close();
  const noJs = await browser.newContext({ javaScriptEnabled: false });
  const plain = await noJs.newPage(); await plain.goto(origin);
  assert.equal(await plain.locator(".project-card").count(), 16);
  assert.equal(await plain.locator(".discovery-tools").isVisible(), false);
  assert.equal(await plain.locator(".project-card [data-open]").first().isVisible(), true);
  await noJs.close();
  const attack = '</script><img src=x onerror="window.galleryInjected=true">';
  await fs.writeFile(path.join(root, "hostile.html"), await renderGallery([{ ...projects[0], name: attack, pitch: attack, play: attack }]));
  await page.goto(`${origin}/hostile.html`);
  await page.locator("[data-details]").first().click();
  assert.equal(await page.locator("#detail-title").textContent(), attack);
  assert.equal(await page.evaluate(() => window.galleryInjected), undefined);
  assert.deepEqual(errors, []);
  console.log("PASS: gallery search, filters, sorting/layout, pagination, saved/recent collections, storage recovery, native links, deep links/history, sharing, keyboard/dialogs, responsive layout, no-JS fallback and hostile content.");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith("threadsite-gallery-browser-"));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
