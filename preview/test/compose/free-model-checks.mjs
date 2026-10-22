import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { OpenCodeHarness } from "./dist/opencode.js";

const hash = (content) => createHash("sha256").update(content).digest("hex");
const report = JSON.parse(await fs.readFile("/artifacts/report.json", "utf8"));
for (const project of report) {
  const compiled = await fs.readFile(`/workspace/100/${project.threadId}/site/js/main.js`);
  const response = await fetch(`http://static-web/${project.slug}/js/main.js`);
  assert.equal(response.status, 200);
  const published = await response.text();
  assert.equal(hash(published), project.deployedHash, "Publication changed after the tested turn");
  // Publication adds content-hash queries to local JS/CSS imports on its
  // staging copy. Compare the compiler bytes after undoing only those URLs.
  const original = published.replace(/((?:\bfrom|\bimport)\s*\(?\s*)(["'])(\.{1,2}\/[^"']*\.(?:m?js|css))\?v=[0-9a-f]{10}\2/gi,
    (_match, prefix, quote, url) => `${prefix}${quote}${url}${quote}`);
  project.compiledHash = hash(compiled);
  assert.equal(hash(original), project.compiledHash, "Publication must preserve compiled code apart from asset-version URLs");
}
await fs.writeFile("/artifacts/report.json", JSON.stringify(report, null, 2));
console.log("PASS publication preserves compiled code with content-version URLs");

const directory = "/workspace/100/299";
await fs.mkdir(directory, { recursive: true });
await fs.writeFile(`${directory}/AGENTS.md`, "Single-response image transport check. Inspect the attached image; do not edit or use tools.");
const harness = new OpenCodeHarness();
const session = await harness.createSession(directory, "Image transport check");
try {
  const screenshot = await fs.readFile("/artifacts/200-qa.png");
  const result = await harness.prompt(directory, session,
    "Inspect the attached screenshot. In one sentence, state the visible page heading and the integer shown in the large counter. Do not use tools or edit files.",
    "opencode/glm-5.3-flash-free", undefined, "sitebuilder", undefined,
    [{ mime: "image/png", dataUrl: `data:image/png;base64,${screenshot.toString("base64")}`, filename: "fixture.png" }]);
  await fs.writeFile("/artifacts/image-input-check.json", JSON.stringify(result, null, 2));
  assert.match(result.text, /Counter Lab/i);
  assert.match(result.text, /\b(?:0|zero)\b/i);
  assert.equal(result.usage.cost, 0);
  console.log(`PASS live image input: ${result.text}`);
} finally { await harness.deleteSessionsInDirectory(directory, session); }
