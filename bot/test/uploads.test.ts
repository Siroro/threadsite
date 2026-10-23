import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Attachment } from "discord.js";
import {
  MAX_TURN_UPLOADS, MAX_UPLOAD_BYTES, UPLOAD_DIR, saveUploadAttachments, uploadFileName, uploadPromptNote,
} from "../src/uploads.js";

const attachment = (overrides: Partial<{ name: string; size: number; contentType: string; url: string }>): Attachment =>
  ({ name: "file.bin", size: 3, contentType: "application/octet-stream", url: "data:application/octet-stream;base64,AAAA", ...overrides }) as unknown as Attachment;

async function workspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "threadsite-uploads-"));
}

const savedPath = (workspacePath: string, name: string): string => path.join(workspacePath, ...UPLOAD_DIR.split("/"), name);

test("upload names keep one safe path segment", () => {
  assert.equal(uploadFileName("../../../etc/passwd"), "passwd");
  assert.equal(uploadFileName(".env"), "env");
  assert.equal(uploadFileName(".."), "file");
  assert.equal(uploadFileName(""), "file");
  assert.equal(uploadFileName(undefined), "file");
  assert.equal(uploadFileName("Hero Sprite final.png"), "Hero-Sprite-final.png");
  assert.equal(uploadFileName("beep (1).ogg"), "beep-1-.ogg");
  assert.equal(uploadFileName(`${"a".repeat(300)}.png`).length, 100);
});

test("uploads are saved into scratch/uploads and never overwrite an existing file", async () => {
  const workspacePath = await workspace();
  try {
    const first = await saveUploadAttachments(workspacePath, [
      attachment({ name: "spritesheet.png", contentType: "image/png", url: "data:image/png;base64,iVBORw0KGgo=" }),
    ]);
    assert.equal(first.length, 1);
    assert.equal(first[0].path, "scratch/uploads/spritesheet.png");
    assert.equal(first[0].mime, "image/png");
    assert.deepEqual(await fs.readFile(savedPath(workspacePath, "spritesheet.png")), Buffer.from("iVBORw0KGgo=", "base64"));

    const second = await saveUploadAttachments(workspacePath, [attachment({ name: "spritesheet.png" })]);
    assert.equal(second[0].path, "scratch/uploads/spritesheet-2.png");
    // The first save is intact, not replaced.
    assert.deepEqual(await fs.readFile(savedPath(workspacePath, "spritesheet.png")), Buffer.from("iVBORw0KGgo=", "base64"));

    const third = await saveUploadAttachments(workspacePath, [attachment({ name: "spritesheet.png" })]);
    assert.equal(third[0].path, "scratch/uploads/spritesheet-3.png");
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test("oversized and undownloadable attachments are skipped without failing the rest", async () => {
  const workspacePath = await workspace();
  try {
    const saved = await saveUploadAttachments(workspacePath, [
      attachment({ name: "huge.zip", size: MAX_UPLOAD_BYTES + 1 }),
      attachment({ name: "gone.pdf", url: "file:///definitely-not-there" }),
      attachment({ name: "kept.txt", url: "data:text/plain;base64,aGk=" }),
    ]);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].path, "scratch/uploads/kept.txt");
    await fs.access(savedPath(workspacePath, "huge.zip")).then(() => assert.fail("oversized upload was written"), () => undefined);
    await fs.access(savedPath(workspacePath, "gone.pdf")).then(() => assert.fail("undownloadable upload was written"), () => undefined);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test("concurrent same-name uploads retain every request's bytes", async () => {
  const workspacePath = await workspace();
  try {
    const contents = Array.from({ length: 12 }, (_, index) => `attachment ${index}`);
    const results = await Promise.all(contents.map((content) => saveUploadAttachments(workspacePath, [
      attachment({ name: "shared.txt", url: `data:text/plain,${encodeURIComponent(content)}` }),
    ])));
    assert.ok(results.every((files) => files.length === 1));
    assert.equal(new Set(results.map(([file]) => file.path)).size, contents.length);
    const saved = await Promise.all(results.map(([file]) => fs.readFile(savedPath(workspacePath, file.name), "utf8")));
    assert.deepEqual(saved, contents);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test("a message saves at most MAX_TURN_UPLOADS attachments", async () => {
  const workspacePath = await workspace();
  try {
    const saved = await saveUploadAttachments(workspacePath,
      Array.from({ length: MAX_TURN_UPLOADS + 2 }, (_, index) => attachment({ name: `extra-${index}.bin` })));
    assert.equal(saved.length, MAX_TURN_UPLOADS);
    assert.deepEqual(saved.map((file) => file.name), Array.from({ length: MAX_TURN_UPLOADS }, (_, index) => `extra-${index}.bin`));
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test("the prompt note names every saved file with its size and type", () => {
  assert.equal(uploadPromptNote([]), "");
  const single = uploadPromptNote([{ name: "notes.md", path: "scratch/uploads/notes.md", bytes: 512, mime: "text/markdown" }]);
  assert.match(single, /attached 1 file;/);
  assert.match(single, /`scratch\/uploads\/notes\.md` \(512 B, text\/markdown\)/);
  assert.match(single, /asset_import/);
  const plural = uploadPromptNote([
    { name: "a.ogg", path: "scratch/uploads/a.ogg", bytes: 160_000 },
    { name: "b.pdf", path: "scratch/uploads/b.pdf", bytes: 15_000_000, mime: "application/pdf" },
  ]);
  assert.match(plural, /attached 2 files/);
  assert.match(plural, /`scratch\/uploads\/a\.ogg` \(156 KB\)/);
  assert.match(plural, /`scratch\/uploads\/b\.pdf` \(14\.3 MB, application\/pdf\)/);
});
