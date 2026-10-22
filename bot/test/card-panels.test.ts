import assert from "node:assert/strict";
import { test } from "node:test";
import { textPages } from "../src/card-panels.js";

test("pagination never splits a fenced code block across pages", () => {
  const fence = "```js\n" + "code line of interest\n".repeat(30) + "```\n";
  const text = `# Report\n\n${"intro paragraph\n".repeat(20)}\n${fence}\nafter the fence\n`;
  const pages = textPages(text, 800);
  assert.ok(pages.length > 1, "the text actually paginates");
  assert.equal(pages.join(""), text, "pagination preserves every character");
  for (const [index, page] of pages.entries()) {
    assert.equal(
      (page.match(/```/g)?.length ?? 0) % 2, 0,
      `page ${index + 1} leaves code fences balanced — an unclosed fence swallows the page footer into code rendering`,
    );
  }
  // The fence itself must arrive whole on a single page.
  const fencePage = pages.find((page) => page.includes("```js"));
  assert.ok(fencePage?.includes("```") && fencePage.match(/```/g)!.length >= 2, "the fenced block is opened and closed on one page");
});

test("pagination still cuts a fence longer than one page", () => {
  const text = "```js\n" + "line\n".repeat(1200) + "```\n";
  const pages = textPages(text, 800);
  assert.ok(pages.length > 1);
  assert.equal(pages.join(""), text, "even a degenerate fence loses no characters");
});
