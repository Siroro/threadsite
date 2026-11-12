import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { test } from "node:test";
import type { Attachment } from "discord.js";
import {
  MAX_ATTACHMENTS, MAX_ATTACHMENT_TOTAL_BYTES, UPLOAD_DIR, attachmentBudget, downloadImageAttachments,
  saveUploadAttachments, uploadFileName, uploadPromptNote,
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
      attachment({ name: "huge.zip", size: MAX_ATTACHMENT_TOTAL_BYTES + 1 }),
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

test("uploads enforce actual streamed bytes and cancel oversized responses", async (t) => {
  const workspacePath = await workspace();
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }));
  let cancelled = false;
  let chunks = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    pull(controller) {
      if (chunks++ < 12) controller.enqueue(new Uint8Array(1024 * 1024));
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers: { "content-length": "1" } }));
  const saved = await saveUploadAttachments(workspacePath, [attachment({ size: 1 })]);
  assert.deepEqual(saved, []);
  assert.equal(cancelled, true);
  assert.ok(chunks < 12, "stop reading as soon as the response exceeds the budget");
  await assert.rejects(fs.access(savedPath(workspacePath, "file.bin")), { code: "ENOENT" });
});

test("uploads enforce one total byte budget across a message", async (t) => {
  const workspacePath = await workspace();
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }));
  let downloads = 0;
  t.mock.method(globalThis, "fetch", async () => {
    downloads++;
    return new Response(new Uint8Array(4 * 1024 * 1024));
  });
  const saved = await saveUploadAttachments(workspacePath, [
    attachment({ name: "one.bin", size: 1 }),
    attachment({ name: "two.bin", size: 1 }),
    attachment({ name: "three.bin", size: 1 }),
  ]);
  assert.deepEqual(saved.map((file) => file.name), ["one.bin", "two.bin"]);
  assert.equal(downloads, 2);
  assert.equal((await fs.stat(savedPath(workspacePath, "one.bin"))).size, 4 * 1024 * 1024);
  await assert.rejects(fs.access(savedPath(workspacePath, "three.bin")), { code: "ENOENT" });
});

for (const linkedDirectory of ["scratch", "scratch/uploads"]) {
  test(`uploads refuse a linked ${linkedDirectory} directory`, async (t) => {
    const root = await workspace();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const project = path.join(root, "project");
    const outside = path.join(root, "outside");
    await fs.mkdir(path.dirname(path.join(project, linkedDirectory)), { recursive: true });
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(project, linkedDirectory), process.platform === "win32" ? "junction" : "dir");
    const saved = await saveUploadAttachments(project, [attachment({ name: "escape.txt" })]);
    assert.deepEqual(saved, []);
    assert.deepEqual(await fs.readdir(outside), []);
  });
}

test("image and file downloads share the message's count and byte limits", async (t) => {
  const workspacePath = await workspace();
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }));
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(3 * 1024 * 1024)));
  const budget = attachmentBudget();
  const images = await downloadImageAttachments([attachment({ name: "reference.png", contentType: "image/png" })], budget);
  const saved = await saveUploadAttachments(workspacePath, [attachment({ name: "one.bin" }), attachment({ name: "two.bin" })], budget);
  assert.equal(images.length, 1);
  assert.equal(Buffer.from(images[0].dataUrl.split(",")[1], "base64").length, 3 * 1024 * 1024);
  assert.deepEqual(saved.map((file) => file.name), ["one.bin"]);
  assert.equal((await fs.stat(savedPath(workspacePath, "one.bin"))).size, 3 * 1024 * 1024);

  fetchMock.mock.mockImplementation(async () => new Response("small"));
  const countBudget = attachmentBudget();
  assert.equal((await downloadImageAttachments(Array.from({ length: 3 }, () => attachment({ contentType: "image/png" })), countBudget)).length, 3);
  const counted = await saveUploadAttachments(workspacePath, [attachment({ name: "allowed.bin" }), attachment({ name: "excess.bin" })], countBudget);
  assert.deepEqual(counted.map((file) => file.name), ["allowed.bin"]);
});

test("a stalled attachment body is aborted without blocking the next download", { timeout: 3000 }, async (t) => {
  const workspacePath = await workspace();
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }));
  const server = http.createServer((_request, response) => {
    response.writeHead(200);
    response.write("partial");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", () => timeout(100));
  const address = server.address() as { port: number };
  const saved = await saveUploadAttachments(workspacePath, [
    attachment({ name: "stalled.bin", url: `http://127.0.0.1:${address.port}` }),
    attachment({ name: "next.txt", url: "data:text/plain,complete" }),
  ]);
  assert.deepEqual(saved.map((file) => file.name), ["next.txt"]);
  assert.equal(await fs.readFile(savedPath(workspacePath, "next.txt"), "utf8"), "complete");
  await assert.rejects(fs.access(savedPath(workspacePath, "stalled.bin")), { code: "ENOENT" });
});

test("a message saves at most MAX_ATTACHMENTS attachments", async () => {
  const workspacePath = await workspace();
  try {
    const saved = await saveUploadAttachments(workspacePath,
      Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, index) => attachment({ name: `extra-${index}.bin` })));
    assert.equal(saved.length, MAX_ATTACHMENTS);
    assert.deepEqual(saved.map((file) => file.name), Array.from({ length: MAX_ATTACHMENTS }, (_, index) => `extra-${index}.bin`));
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
