import { tool } from "../v2/tool-definition.js";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { queueSourceRecord } from "../lib/asset-sources.js";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export default tool({
  description: "Safely download any public HTTP(S) file into site/assets. Use websearch first, prefer trustworthy/reusable sources, and provide source/license notes when known. Private/local network targets are blocked; destination and size limits still apply.",
  args: {
    url: tool.schema.string().url().describe("Direct public HTTP(S) URL of the file to download"),
    destination: tool.schema.string().min(1).max(180).describe("Path below site/assets, for example images/hero.webp or audio/click.ogg"),
    source_page: tool.schema.string().url().optional().describe("Human-facing page where the asset/source was discovered"),
    license_note: tool.schema.string().max(300).optional().describe("Known license or attribution note. Do not guess if unknown."),
  },
  async execute(args, context) {
    const root = path.resolve(context.directory);
    const assetRoot = path.join(root, "site", "assets");
    const destination = normalizeDestination(args.destination);
    const output = path.resolve(assetRoot, destination);
    if (!output.startsWith(`${assetRoot}${path.sep}`)) throw new Error("Destination escaped site/assets");

    const maxBytes = positiveInt(process.env.ASSET_MAX_BYTES, DEFAULT_MAX_BYTES);
    const timeoutMs = positiveInt(process.env.ASSET_DOWNLOAD_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const allowHttp = /^(1|true|yes|on)$/i.test(process.env.ASSET_ALLOW_HTTP || "");

    const result = await fetchPublicAsset(args.url, { maxBytes, timeoutMs, allowHttp });

    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, result.bytes, { mode: 0o644 });
    const sha256 = crypto.createHash("sha256").update(result.bytes).digest("hex");

    const sourceRecord = {
      file: path.relative(root, output).replaceAll(path.sep, "/"),
      requestedUrl: args.url,
      finalUrl: result.finalUrl,
      sourcePage: args.source_page || undefined,
      licenseNote: args.license_note || "unspecified — verify before redistribution if required",
      contentType: result.contentType || undefined,
      bytes: result.bytes.length,
      sha256,
      downloadedAt: new Date().toISOString(),
    };
    await queueSourceRecord(root, sourceRecord);

    return `Saved ${sourceRecord.file} (${result.bytes.length} bytes, ${result.contentType || "unknown type"}). Source metadata was recorded in ASSET_SOURCES.json.`;
  },
});

function normalizeDestination(input: string): string {
  let value = input.trim().replaceAll("\\", "/");
  value = value.replace(/^\.?\/?site\/assets\//i, "").replace(/^\/?assets\//i, "");
  if (!value || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error("Destination must be a normal relative path below site/assets with no dot/path-traversal segments");
  }
  return value;
}

async function fetchPublicAsset(
  input: string,
  options: { maxBytes: number; timeoutMs: number; allowHttp: boolean },
): Promise<{ bytes: Buffer; contentType: string; finalUrl: string }> {
  let current = new URL(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    await assertPublicUrl(current, options.allowHttp);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("asset download timeout")), options.timeoutMs);
    try {
      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          // Asset CDNs such as static.poly.pizza return 403 to non-browser user
          // agents, so present as a browser with the fetcher token appended.
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 ThreadSite-AssetFetcher/2.0",
          Accept: "*/*",
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`Redirect ${response.status} had no Location header`);
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) throw new Error(`Asset server returned HTTP ${response.status}`);

      const contentLength = Number.parseInt(response.headers.get("content-length") || "0", 10);
      if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
        throw new Error(`Asset is ${contentLength} bytes, above ASSET_MAX_BYTES=${options.maxBytes}`);
      }
      if (!response.body) throw new Error("Asset response had no body");

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > options.maxBytes) {
          await reader.cancel("asset too large").catch(() => undefined);
          throw new Error(`Asset exceeded ASSET_MAX_BYTES=${options.maxBytes}`);
        }
        chunks.push(value);
      }
      return {
        bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
        contentType: (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase(),
        finalUrl: current.toString(),
      };
    } finally {
      // fetch resolves at headers; the same deadline must cover a slow or
      // stalled response body before the tool can release the turn.
      clearTimeout(timer);
    }
  }
  throw new Error("Too many redirects while downloading asset");
}

async function assertPublicUrl(url: URL, allowHttp: boolean): Promise<void> {
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new Error(allowHttp ? "Only http/https asset URLs are allowed" : "Only HTTPS asset URLs are allowed (set ASSET_ALLOW_HTTP=true to permit HTTP)");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Local/private hostnames are blocked");
  }
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("Asset hostname did not resolve");
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new Error(`Private/reserved network address is blocked (${address})`);
  }
}

function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224;
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") ||
      normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") ||
      normalized.startsWith("ff") || normalized.startsWith("2001:db8:");
  }
  return true;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
