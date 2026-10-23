import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import dns from "node:dns/promises";
import { asset_download, asset_import } from "../dist/tools.mjs";

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
