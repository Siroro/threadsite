import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  readProjectTitle, readProjectDescription, readProjectChangelog,
  readProjectReadmeSection, readProjectCardDocument, setProjectTitle,
  parseProjectDescription, parseProjectChangelog,
} from "../src/project-docs.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-docs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const outside = path.join(root, "private.md");
  await fs.writeFile(outside, "# Private title\n\nPrivate pitch\n\n## Secret entry\n\nPrivate details\n");
  return { workspace, outside };
}

for (const kind of ["hardlink", "symlink"] as const) {
  test(`project document readers refuse ${kind}s to private files`, async (t) => {
    const { workspace, outside } = await fixture(t);
    for (const name of ["DESCRIPTION.md", "CHANGELOG.md", "README.agent.md"]) {
      const target = path.join(workspace, name);
      if (kind === "hardlink") await fs.link(outside, target);
      else {
        try { await fs.symlink(outside, target, "file"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
          t.skip("File symlinks require Windows developer mode or elevated privileges.");
          return;
        }
      }
    }
    assert.equal(await readProjectTitle(workspace), undefined);
    assert.equal(await readProjectDescription(workspace), undefined);
    assert.equal(await readProjectChangelog(workspace), undefined);
    assert.equal(await readProjectReadmeSection(workspace), undefined);
    assert.equal(await readProjectCardDocument(workspace, "description"), undefined);
    assert.equal(await readProjectCardDocument(workspace, "changelog"), undefined);
  });
}

test("renaming a hardlinked description cannot modify the linked file", async (t) => {
  const { workspace, outside } = await fixture(t);
  const before = await fs.readFile(outside, "utf8");
  await fs.link(outside, path.join(workspace, "DESCRIPTION.md"));
  assert.equal(await setProjectTitle(workspace, "New title"), false);
  assert.equal(await fs.readFile(outside, "utf8"), before);
});

test("renaming a project preserves literal replacement tokens and its description", async (t) => {
  const { workspace } = await fixture(t);
  await fs.writeFile(path.join(workspace, "DESCRIPTION.md"), "# Old title\n\nA public pitch.\n\n## How to play\nUse arrows.\n");
  const title = "Cash $& $$ $' $`";
  assert.equal(await setProjectTitle(workspace, title), true);
  assert.equal(await readProjectTitle(workspace), title);
  assert.deepEqual(await readProjectDescription(workspace), { pitch: "A public pitch.", play: "Use arrows." });
  assert.equal(await setProjectTitle(workspace, title), false);
});

test("regular and missing project documents remain readable", async (t) => {
  const { workspace } = await fixture(t);
  assert.equal(await readProjectTitle(workspace), undefined);
  assert.equal(await readProjectChangelog(workspace), undefined);
  await fs.writeFile(path.join(workspace, "CHANGELOG.md"), "# Changelog\n\n## New mode\nRacing added.\n");
  await fs.writeFile(path.join(workspace, "README.agent.md"), "<!-- placeholder -->\n## Controls\nArrows.\n");
  assert.deepEqual(await readProjectChangelog(workspace), { title: "New mode", body: "Racing added." });
  assert.equal(await readProjectReadmeSection(workspace), "## Controls\nArrows.");
  assert.equal(await readProjectCardDocument(workspace, "changelog"), "# Changelog\n\n## New mode\nRacing added.");
});

for (const [heading, newline] of [["#", "\n"], ["# \t ", "\r\n"]]) {
  test(`an empty ${JSON.stringify(heading)} title cannot consume the description during rename`, async (t) => {
    const { workspace } = await fixture(t);
    const body = `${newline}${newline}A public pitch.${newline}${newline}## How to play${newline}Use arrows.${newline}`;
    const target = path.join(workspace, "DESCRIPTION.md");
    await fs.writeFile(target, `${heading}${body}`);
    assert.equal(await readProjectTitle(workspace), undefined);
    assert.deepEqual(await readProjectDescription(workspace), { pitch: "A public pitch.", play: "Use arrows." });
    assert.equal(await setProjectTitle(workspace, "New title"), true);
    assert.equal(await fs.readFile(target, "utf8"), `# New title${body}`);
  });
}

test("bare markdown section markers never turn the following body line into a heading", () => {
  assert.deepEqual(parseProjectChangelog("# Changelog\n\n##\n\nAdded checkpoints.\n"), { body: "Added checkpoints." });
  assert.deepEqual(parseProjectDescription("# Name\n\nPitch.\n\n##\nControls\nKeep this paragraph.\n"), {
    pitch: "Pitch.\n\n##\nControls\nKeep this paragraph.",
  });
});
