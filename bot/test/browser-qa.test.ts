import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DISCORD_BOT_TOKEN ||= "test";
process.env.DISCORD_APPLICATION_ID ||= "test";
const { parseConsoleEntries, parseNetworkFailures, parseRenderSanity, renderSanityProblem } = await import("../src/browser-qa.js");

test("console errors and page errors parse from the tool's plain-text output", () => {
  const text = [
    "Total messages: 3 (Errors: 2, Warnings: 1)",
    'Returning 2 messages for level "error"',
    "",
    "[ERROR] Uncaught TypeError: start is not a function @ http://127.0.0.1:8080/100/200/js/main.js:14",
    "Error: render failed",
    "    at draw (http://127.0.0.1:8080/100/200/js/chunks/draw-abc.js:3:9)",
  ].join("\n");
  const entries = parseConsoleEntries(text);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].type, "ERROR");
  assert.match(entries[0].text, /start is not a function/);
  assert.equal(entries[1].type, "PAGEERROR");
  assert.match(entries[1].text, /render failed/);
  assert.match(entries[1].text, /draw-abc\.js/);
});

test("network failures parse from numbered request lines and stay origin-scoped", () => {
  const text = [
    "1. [GET] http://127.0.0.1:8080/100/200/ => [200] OK",
    "2. [GET] http://127.0.0.1:8080/100/200/js/main.js => [404] Not Found",
    "3. [GET] http://127.0.0.1:8080/100/200/api/state => [FAILED] net::ERR_FAILED",
    "4. [GET] https://example.com/font.woff2 => [500] Server Error",
  ].join("\n");
  const failures = parseNetworkFailures(text);
  assert.equal(failures.length, 2);
  assert.deepEqual(failures[0], {
    url: "http://127.0.0.1:8080/100/200/js/main.js",
    status: 404,
  });
  assert.equal(failures[1].error, "net::ERR_FAILED");
});

test("a blank render is a hard error while text or a canvas passes", () => {
  assert.equal(renderSanityProblem({ textLength: 0, canvases: 0, visibleElements: 1, title: "App" }), "preview rendered a blank page — no visible text or canvas (title: \"App\")");
  assert.equal(renderSanityProblem({ textLength: 120, canvases: 0, visibleElements: 8 }), undefined);
  assert.equal(renderSanityProblem({ textLength: 0, canvases: 1, visibleElements: 1 }), undefined);
  assert.equal(renderSanityProblem({ textLength: 0, canvases: 0, visibleElements: 1, mediaElements: 1 }), undefined);
  // A layout shell with several visible wrappers is not necessarily blank.
  assert.equal(renderSanityProblem({ textLength: 0, canvases: 0, visibleElements: 4 }), undefined);
  assert.equal(renderSanityProblem(undefined), undefined);
});

test("the render probe's JSON parses and malformed output is ignored", () => {
  assert.deepEqual(
    parseRenderSanity('{"textLength": 0, "canvases": 2, "visibleElements": 1, "title": "Game"}'),
    { textLength: 0, canvases: 2, visibleElements: 1, title: "Game" },
  );
  assert.equal(parseRenderSanity("undefined"), undefined);
  assert.equal(parseRenderSanity('{"textLength": 0}'), undefined);
});
