import { tool } from "../v2/tool-definition.js";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { makeValidatingLookup, isPrivateAddress } from "../lib/net-guard.js";
import { normalizeDestination, positiveInt } from "../lib/asset-inputs.js";
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
      licenseNote: args.license_note || "unspecified; verify before redistribution if required",
      contentType: result.contentType || undefined,
      bytes: result.bytes.length,
      sha256,
      downloadedAt: new Date().toISOString(),
    };
    await queueSourceRecord(root, sourceRecord);

    return `Saved ${sourceRecord.file} (${result.bytes.length} bytes, ${result.contentType || "unknown type"}). Source metadata was recorded in ASSET_SOURCES.json.`;
  },
});

async function fetchPublicAsset(
  input: string,
  options: { maxBytes: number; timeoutMs: number; allowHttp: boolean },
): Promise<{ bytes: Buffer; contentType: string; finalUrl: string }> {
  // Address validation happens inside the lookup the dial uses, so a name
  // cannot re-resolve to a private address between the check and the connect.
  const lookup = makeValidatingLookup((hostname, family) => dns.lookup(hostname, { family, all: true, verbatim: true }));
  let current = new URL(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    await assertPublicUrl(current, options.allowHttp);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("asset download timeout")), options.timeoutMs);
    try {
      const response = await sendRequest(current, lookup, controller.signal);
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = firstHeader(response.headers.location);
        response.resume();
        if (!location) throw new Error(`Redirect ${status} had no Location header`);
        current = new URL(location, current);
        continue;
      }
      if (status < 200 || status >= 300) throw new Error(`Asset server returned HTTP ${status}`);

      const contentLength = Number.parseInt(firstHeader(response.headers["content-length"]) || "0", 10);
      if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
        throw new Error(`Asset is ${contentLength} bytes, above ASSET_MAX_BYTES=${options.maxBytes}`);
      }

      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for await (const chunk of response) {
          total += chunk.length;
          if (total > options.maxBytes) {
            response.destroy();
            throw new Error(`Asset exceeded ASSET_MAX_BYTES=${options.maxBytes}`);
          }
          chunks.push(Buffer.from(chunk));
        }
      } catch (error) {
        // A destroyed body raises a socket error; the deadline owns the cause.
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error("asset download timeout");
        throw error;
      }
      return {
        bytes: Buffer.concat(chunks),
        contentType: (firstHeader(response.headers["content-type"]) || "").split(";", 1)[0].trim().toLowerCase(),
        finalUrl: current.toString(),
      };
    } catch (error) {
      if (controller.signal.aborted && String((error as Error)?.message) !== "asset download timeout") {
        throw new Error("asset download timeout");
      }
      throw error;
    } finally {
      // Headers and body share one deadline; the tool cannot release the turn
      // while a slow or stalled response body is still outstanding.
      clearTimeout(timer);
    }
  }
  throw new Error("Too many redirects while downloading asset");
}

function sendRequest(url: URL, lookup: ReturnType<typeof makeValidatingLookup>, signal: AbortSignal) {
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      lookup: lookup as unknown as net.LookupFunction,
      signal,
      headers: {
        // Asset CDNs such as static.poly.pizza return 403 to non-browser user
        // agents, so present as a browser with the fetcher token appended.
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 ThreadSite-AssetFetcher/2.0",
        Accept: "*/*",
      },
    }, resolve);
    request.on("error", reject);
    request.end();
  });
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function assertPublicUrl(url: URL, allowHttp: boolean): Promise<void> {
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new Error(allowHttp ? "Only http/https asset URLs are allowed" : "Only HTTPS asset URLs are allowed (set ASSET_ALLOW_HTTP=true to permit HTTP)");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Local/private hostnames are blocked");
  }
  // Literal IPs never hit DNS, so validate them here; hostnames are validated
  // per hop by the connect-time lookup, covering rebinding, mapped IPv6 and
  // NAT64 forms that resolve to private networks.
  if (net.isIP(hostname) && isPrivateAddress(hostname)) {
    throw new Error(`Private/reserved network address is blocked (${hostname})`);
  }
}
