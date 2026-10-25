import { tool, type ToolResultPart } from "../v2/tool-definition.js";
import fs from "node:fs/promises";
import path from "node:path";
import { positiveInt } from "../lib/asset-inputs.js";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
// SVG/glTF are text: return their source instead of an image part, capped for context.
const MAX_TEXT_BYTES = 64 * 1024;

const RASTER_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
};

export default tool({
  description: "Inspect an asset so you can judge it: images (PNG/JPG/GIF/WebP/AVIF/BMP) return the rendered picture, SVG and glTF return their source, GLB returns its embedded JSON, and WAV returns its duration/channels/sample rate. Use it to review every asset you create or install — generated site/assets files and scratch/ work in progress — before treating it as finished.",
  args: {
    file: tool.schema.string().min(1).max(220).describe("Workspace-relative path of an asset under site/assets or scratch, for example site/assets/sprites/player.svg or sprites/player.svg"),
  },
  async execute(args, context): Promise<string | ToolResultPart[]> {
    const root = path.resolve(context.directory);
    let normalized = args.file.trim().replaceAll("\\", "/");
    // Accept the asset tools' destination convention (with or without the
    // site/assets/ prefix); scratch/ paths are previewed where they are.
    if (!normalized.startsWith("scratch/")) normalized = normalized.replace(/^\.?\/?site\/assets\//i, "");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
      throw new Error("File must be a normal relative path under site/assets or scratch with no dot/path-traversal segments");
    }
    const target = path.resolve(root, normalized.startsWith("scratch/")
      ? normalized
      : path.join("site", "assets", normalized));
    // lstat so a symlink is reported as not-a-file rather than followed.
    const stat = await fs.lstat(target).catch(() => undefined);
    if (!stat?.isFile()) throw new Error(`Asset not found: ${args.file}`);

    const maxBytes = positiveInt(process.env.ASSET_MAX_BYTES, DEFAULT_MAX_BYTES);
    if (stat.size > maxBytes) throw new Error(`Asset is ${stat.size} bytes, above ASSET_MAX_BYTES=${maxBytes}`);

    const realRoot = await fs.realpath(root);
    const realTarget = await fs.realpath(target);
    const relative = path.relative(realRoot, realTarget);
    const segments = relative.split(path.sep);
    const insideAssets = segments[0] === "site" && segments[1] === "assets" && segments.length > 2;
    const insideScratch = segments[0] === "scratch" && segments.length > 1;
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || (!insideAssets && !insideScratch)) {
      throw new Error("Asset preview is limited to files under site/assets or scratch");
    }

    const label = `${relative.replaceAll(path.sep, "/")} · ${stat.size} bytes`;
    const text = (summary: string, body: string) => [{ type: "text" as const,
      text: `${label} · ${summary}${Buffer.byteLength(body, "utf8") > MAX_TEXT_BYTES ? " (source truncated)" : ""}:\n${body.slice(0, MAX_TEXT_BYTES)}` }];

    const extension = path.extname(realTarget).toLowerCase();
    if (extension === ".svg") {
      return text("SVG source", await fs.readFile(realTarget, "utf8"));
    }
    if (extension === ".gltf") {
      return text("glTF JSON (structure; verify meshes, materials, accessors)", await fs.readFile(realTarget, "utf8"));
    }
    if (extension === ".glb") {
      const json = glbJsonChunk(await fs.readFile(realTarget));
      if (!json) throw new Error("GLB container is malformed (missing JSON chunk)");
      return text("GLB embedded glTF JSON (structure; verify meshes, materials, accessors)", json);
    }
    if (extension === ".wav") {
      const stats = wavStats(await fs.readFile(realTarget));
      if (!stats) throw new Error("WAV header is malformed");
      return text("WAV metadata", stats);
    }
    const mime = RASTER_MIME[extension];
    if (!mime) throw new Error(`Unsupported preview type '${extension || "none"}'; supported: svg, ${Object.keys(RASTER_MIME).map((ext) => ext.slice(1)).join(", ")}, gltf, glb, wav`);
    const bytes = await fs.readFile(realTarget);
    return [
      { type: "file", uri: `data:${mime};base64,${bytes.toString("base64")}`, mime, name: path.basename(realTarget) },
      { type: "text", text: `${label} · ${mime}` },
    ];
  },
});

/** GLB is a 12-byte header followed by chunks; the first must be the JSON chunk. */
function glbJsonChunk(bytes: Buffer): string | undefined {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) return undefined;
  const length = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== 0x4e4f534a) return undefined;
  if (12 + 8 + length > bytes.length) return undefined;
  return bytes.subarray(20, 20 + length).toString("utf8");
}

/** Summarize a RIFF/WAVE header: format, channels, sample rate, duration. */
function wavStats(bytes: Buffer): string | undefined {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return undefined;
  let offset = 12;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bits: number | undefined;
  let formatTag: number | undefined;
  let dataBytes: number | undefined;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + size > bytes.length) return undefined;
    if (id === "fmt ") {
      formatTag = bytes.readUInt16LE(offset + 8);
      channels = bytes.readUInt16LE(offset + 10);
      sampleRate = bytes.readUInt32LE(offset + 12);
      bits = bytes.readUInt16LE(offset + 22);
    }
    if (id === "data") dataBytes = size;
    offset += 8 + size + (size % 2);
  }
  if (!channels || !sampleRate || dataBytes === undefined) return undefined;
  const format = formatTag === 1 ? "PCM" : formatTag === 3 ? "float" : `format ${formatTag}`;
  const divisor = sampleRate * channels * ((bits ?? 16) / 8);
  const seconds = divisor > 0 ? dataBytes / divisor : 0;
  return `${format} · ${channels} channel(s) · ${sampleRate} Hz · ${bits ?? "?"}-bit · ${(seconds).toFixed(2)}s`;
}
