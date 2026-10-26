import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import dns from "node:dns/promises";
import { asset_download, asset_import, asset_preview, asset_save } from "../dist/tools.mjs";

test("a download times out while its response body is stalled, then a later download succeeds", { timeout: 5000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-asset-timeout-"));
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const previousTimeout = process.env.ASSET_DOWNLOAD_TIMEOUT_MS;
  process.env.ASSET_DOWNLOAD_TIMEOUT_MS = "30";
  t.after(() => {
    if (previousTimeout === undefined) delete process.env.ASSET_DOWNLOAD_TIMEOUT_MS;
    else process.env.ASSET_DOWNLOAD_TIMEOUT_MS = previousTimeout;
  });
  let stream;
  let signal;
  const fetch = t.mock.method(globalThis, "fetch", async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({
      start(controller) {
        stream = controller;
        options.signal.addEventListener("abort", () => controller.error(options.signal.reason), { once: true });
        controller.enqueue(new TextEncoder().encode("partial"));
      },
    }));
  });
  const request = asset_download.execute({ url: "https://assets.example/file", destination: "file.txt" }, { directory: root });
  // Bound the regression's failure too: the original bug never aborts the body.
  const watchdog = setTimeout(() => stream?.error(new Error("body timeout was not enforced")), 1000);
  try {
    await assert.rejects(request, /asset download timeout/);
    assert.equal(signal.aborted, true);
    await assert.rejects(fs.access(path.join(root, "site/assets/file.txt")), { code: "ENOENT" });
    fetch.mock.mockImplementation(async () => new Response("complete"));
    await asset_download.execute({ url: "https://assets.example/file", destination: "file.txt" }, { directory: root });
    assert.equal(await fs.readFile(path.join(root, "site/assets/file.txt"), "utf8"), "complete");
  } finally {
    clearTimeout(watchdog);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a failed provenance write rejects its caller without blocking the next asset", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-asset-retry-"));
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  t.mock.method(globalThis, "fetch", async () => new Response("downloaded"));
  const rename = fs.rename;
  const failure = new Error("simulated metadata rename failure");
  let failNext = true;
  t.mock.method(fs, "rename", async (...args) => {
    if (failNext && args[1] === path.join(root, "ASSET_SOURCES.json")) {
      failNext = false;
      throw failure;
    }
    return rename(...args);
  });
  try {
    await fs.mkdir(path.join(root, "scratch/uploads"), { recursive: true });
    await fs.writeFile(path.join(root, "scratch/uploads/file.txt"), "uploaded");
    await assert.rejects(asset_import.execute({ source: "scratch/uploads/file.txt", destination: "file.txt" }, { directory: root }), (error) => error === failure);
    await asset_download.execute({ url: "https://assets.example/file", destination: "other.txt" }, { directory: root });
    await asset_import.execute({ source: "scratch/uploads/file.txt", destination: "file.txt" }, { directory: root });
    const records = JSON.parse(await fs.readFile(path.join(root, "ASSET_SOURCES.json"), "utf8"));
    assert.deepEqual(records.map((record) => record.file).sort(), ["site/assets/file.txt", "site/assets/other.txt"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("concurrent imports and downloads retain all provenance and replace only the matching asset", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-asset-sources-"));
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  t.mock.method(globalThis, "fetch", async () => new Response("downloaded"));
  try {
    await fs.mkdir(path.join(root, "scratch/uploads"), { recursive: true });
    await fs.writeFile(path.join(root, "scratch/uploads/file.txt"), "uploaded");
    const destinations = Array.from({ length: 16 }, (_, index) => `${index}.txt`);
    const results = await Promise.allSettled(destinations.map((destination, index) => index % 2
      ? asset_import.execute({ source: "scratch/uploads/file.txt", destination }, { directory: root })
      : asset_download.execute({ url: "https://assets.example/file", destination }, { directory: root })));
    for (const result of results) assert.equal(result.status, "fulfilled", result.reason?.message);
    const metadata = path.join(root, "ASSET_SOURCES.json");
    const records = JSON.parse(await fs.readFile(metadata, "utf8"));
    assert.deepEqual(records.map((record) => record.file).sort(), destinations.map((name) => `site/assets/${name}`).sort());
    for (const [index, destination] of destinations.entries()) {
      const bytes = await fs.readFile(path.join(root, "site/assets", destination));
      assert.equal(bytes.toString(), index % 2 ? "uploaded" : "downloaded");
      assert.equal(records.find((record) => record.file === `site/assets/${destination}`).bytes, bytes.length);
    }
    await asset_import.execute({ source: "scratch/uploads/file.txt", destination: "0.txt" }, { directory: root });
    const updated = JSON.parse(await fs.readFile(metadata, "utf8"));
    assert.equal(updated.length, records.length);
    assert.equal(updated.find((record) => record.file === "site/assets/0.txt").uploadedFrom, "scratch/uploads/file.txt");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Minimal valid 1x1 transparent PNG.
const DOT_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("asset_save installs generated content and scratch output with provenance, rejecting anything else", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-asset-save-"));
  try {
    await fs.mkdir(path.join(root, "scratch/gen"), { recursive: true });
    await fs.mkdir(path.join(root, "site/assets"), { recursive: true });
    await fs.writeFile(path.join(root, "scratch/gen/dot.png"), DOT_PNG);
    await fs.writeFile(path.join(root, "site/assets/pre-existing.txt"), "harness");
    await fs.writeFile(path.join(root, "outside.bin"), "nope");

    await asset_save.execute({ destination: "sprites/dot.png", source: "scratch/gen/dot.png", note: "procedural dot" }, { directory: root });
    assert.deepEqual(await fs.readFile(path.join(root, "site/assets/sprites/dot.png")), DOT_PNG);
    const text = await asset_save.execute({ destination: "images/logo.svg", content: '<svg xmlns="http://www.w3.org/2000/svg"/>' }, { directory: root });
    assert.match(text, /site\/assets\/images\/logo\.svg/);
    const records = JSON.parse(await fs.readFile(path.join(root, "ASSET_SOURCES.json"), "utf8"));
    assert.deepEqual(records.map((record) => [record.file, record.origin]).sort(), [
      ["site/assets/images/logo.svg", "generated"], ["site/assets/sprites/dot.png", "generated"],
    ]);
    assert.equal(records.find((record) => record.file === "site/assets/sprites/dot.png").generatedFrom, "scratch/gen/dot.png");

    for (const rejected of [
      { destination: "a.svg", content: "x", source: "scratch/gen/dot.png" },
      { destination: "a.svg" },
      { destination: "empty.svg", content: "" },
      { destination: "a.png", source: "outside.bin" },
      { destination: "a.png", source: "scratch/gen/missing.png" },
      { destination: "../escape.png", content: "x" },
    ]) {
      await assert.rejects(asset_save.execute(rejected, { directory: root }), Error, JSON.stringify(rejected));
    }
    // The site/assets/ destination prefix is accepted, like the other asset
    // tools (distinct bytes; identical bytes elsewhere is a duplicate below).
    await fs.writeFile(path.join(root, "scratch/gen/other.png"), Buffer.from("different bytes"));
    await asset_save.execute({ destination: "site/assets/nested.png", source: "scratch/gen/other.png" }, { directory: root });
    assert.ok(await fs.readFile(path.join(root, "site/assets/nested.png")));
    // Re-saving identical bytes to the same path is idempotent; the same bytes
    // under a different name is a generation bug and fails with the existing path.
    const again = await asset_save.execute({ destination: "nested.png", source: "scratch/gen/other.png" }, { directory: root });
    assert.match(again, /unchanged/);
    const recordsAfterIdempotent = JSON.parse(await fs.readFile(path.join(root, "ASSET_SOURCES.json"), "utf8"));
    await assert.rejects(
      asset_save.execute({ destination: "sprites/dot2.png", source: "scratch/gen/other.png" }, { directory: root }),
      /already installed at site\/assets\/nested\.png/,
    );
    assert.equal((JSON.parse(await fs.readFile(path.join(root, "ASSET_SOURCES.json"), "utf8"))).length,
      recordsAfterIdempotent.length, "a rejected duplicate writes no record");
    // A regenerated, genuinely different sprite at a new path still lands.
    await fs.writeFile(path.join(root, "scratch/gen/variant.png"), Buffer.from("variant bytes"));
    await asset_save.execute({ destination: "sprites/dot2.png", source: "scratch/gen/variant.png" }, { directory: root });
    assert.equal(await fs.readFile(path.join(root, "site/assets/pre-existing.txt"), "utf8"), "harness");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("asset_preview returns rendered images, SVG/glTF structure and WAV metadata, staying inside asset roots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-asset-preview-"));
  try {
    await fs.mkdir(path.join(root, "site/assets/sprites"), { recursive: true });
    await fs.mkdir(path.join(root, "site/assets/models"), { recursive: true });
    await fs.mkdir(path.join(root, "site/assets/audio"), { recursive: true });
    await fs.mkdir(path.join(root, "scratch/gen"), { recursive: true });
    await fs.writeFile(path.join(root, "site/assets/sprites/dot.png"), DOT_PNG);
    await fs.writeFile(path.join(root, "site/assets/sprites/logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>');
    await fs.writeFile(path.join(root, "package.json"), "{}");
    await fs.writeFile(path.join(root, "scratch/gen/wip.png"), DOT_PNG);

    const json = JSON.stringify({ asset: { version: "2.0" }, meshes: [{ primitives: [] }] });
    const padded = json + " ".repeat((4 - (json.length % 4)) % 4);
    const chunk = Buffer.alloc(8);
    chunk.writeUInt32LE(Buffer.byteLength(padded), 0);
    chunk.writeUInt32LE(0x4e4f534a, 4);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + Buffer.byteLength(padded), 8);
    await fs.writeFile(path.join(root, "site/assets/models/cube.glb"), Buffer.concat([header, chunk, Buffer.from(padded)]));

    const dataBytes = 8000 * 4;
    const riff = (size) => { const b = Buffer.alloc(4); b.writeUInt32LE(size); return b; };
    const fmt = Buffer.alloc(16);
    fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(8000, 4); fmt.writeUInt32LE(16000, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14);
    await fs.writeFile(path.join(root, "site/assets/audio/loop.wav"), Buffer.concat([
      Buffer.from("RIFF", "ascii"), riff(36 + dataBytes), Buffer.from("WAVE", "ascii"),
      Buffer.from("fmt ", "ascii"), riff(16), fmt, Buffer.from("data", "ascii"), riff(dataBytes), Buffer.alloc(dataBytes),
    ]));

    const raster = await asset_preview.execute({ file: "sprites/dot.png" }, { directory: root });
    assert.equal(raster[0].type, "file");
    assert.equal(raster[0].mime, "image/png");
    assert.equal(raster[0].uri, `data:image/png;base64,${DOT_PNG.toString("base64")}`);
    assert.match(raster[1].text, /sprites\/dot\.png/);

    const prefixed = await asset_preview.execute({ file: "site/assets/sprites/dot.png" }, { directory: root });
    assert.equal(prefixed[0].uri, raster[0].uri, "the destination convention and full path preview the same file");

    const wip = await asset_preview.execute({ file: "scratch/gen/wip.png" }, { directory: root });
    assert.equal(wip[0].type, "file");

    const svg = await asset_preview.execute({ file: "sprites/logo.svg" }, { directory: root });
    assert.equal(svg.length, 1);
    assert.match(svg[0].text, /SVG source/);
    assert.match(svg[0].text, /<svg/);

    const glb = await asset_preview.execute({ file: "models/cube.glb" }, { directory: root });
    assert.match(glb[0].text, /"meshes"/);

    const wav = await asset_preview.execute({ file: "audio/loop.wav" }, { directory: root });
    assert.match(wav[0].text, /8000 Hz · 16-bit · 2\.00s/);

    for (const rejected of ["package.json", "../outside.png", "missing.png", "site/assets/../secret.png"]) {
      await assert.rejects(asset_preview.execute({ file: rejected }, { directory: root }), Error, rejected);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("asset_preview sanity-checks compressed audio containers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-asset-audio-"));
  try {
    await fs.mkdir(path.join(root, "site/assets/audio"), { recursive: true });
    await fs.writeFile(path.join(root, "site/assets/audio/jump.ogg"), Buffer.concat([Buffer.from("OggS", "ascii"), Buffer.alloc(32)]));
    await fs.writeFile(path.join(root, "site/assets/audio/hit.mp3"), Buffer.concat([Buffer.from("ID3", "ascii"), Buffer.alloc(32)]));
    // A renamed text file is the failed-transcode case the check exists for.
    await fs.writeFile(path.join(root, "site/assets/audio/broken.mp3"), Buffer.from("not audio at all"));

    const ogg = await asset_preview.execute({ file: "audio/jump.ogg" }, { directory: root });
    assert.equal(ogg.length, 1);
    assert.match(ogg[0].text, /Ogg container/);

    const mp3 = await asset_preview.execute({ file: "site/assets/audio/hit.mp3" }, { directory: root });
    assert.match(mp3[0].text, /MPEG audio/);

    const broken = await asset_preview.execute({ file: "audio/broken.mp3" }, { directory: root });
    assert.match(broken[0].text, /unrecognized audio data/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
