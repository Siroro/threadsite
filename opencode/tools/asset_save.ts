import { tool } from "../v2/tool-definition.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeDestination, positiveInt } from "../lib/asset-inputs.js";
import { queueSourceRecord } from "../lib/asset-sources.js";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export default tool({
  description: "Install an original asset you created into site/assets with provenance recorded in ASSET_SOURCES.json. Pass content for text assets (SVG, JSON) or source for a file a generator script wrote under scratch/ (PNG, WAV, binaries). This is the only way to add generated assets; never edit site/assets directly.",
  args: {
    destination: tool.schema.string().min(1).max(180).describe("Path below site/assets, for example sprites/player.svg or audio/jump.wav"),
    content: tool.schema.string().max(2 * 1024 * 1024).optional().describe("Text content of the asset (SVG, JSON, ...). Exclusive with source."),
    source: tool.schema.string().min(1).max(220).optional().describe("Workspace-relative path of the generated file under scratch/, for example scratch/gen/player.png"),
    note: tool.schema.string().max(300).optional().describe("What the asset depicts and how it was produced (technique/script), for provenance"),
  },
  async execute(args, context) {
    if ((args.content === undefined) === (args.source === undefined)) {
      throw new Error("Pass exactly one of content or source");
    }
    const root = path.resolve(context.directory);
    const maxBytes = positiveInt(process.env.ASSET_MAX_BYTES, DEFAULT_MAX_BYTES);

    let bytes: Buffer;
    let generatedFrom: string | undefined;
    if (args.source !== undefined) {
      const scratchRoot = path.join(root, "scratch");
      const source = path.resolve(root, args.source);
      if (source !== scratchRoot && !source.startsWith(`${scratchRoot}${path.sep}`)) throw new Error("Source must be a file under scratch/");
      const stat = await fs.lstat(source).catch(() => undefined);
      if (!stat?.isFile()) throw new Error(`Generated file not found: ${args.source}`);
      if (stat.size === 0) throw new Error(`Generated file is empty: ${args.source}`);
      if (stat.size > maxBytes) throw new Error(`Generated file is ${stat.size} bytes, above ASSET_MAX_BYTES=${maxBytes}`);
      bytes = await fs.readFile(source);
      generatedFrom = path.relative(root, source).replaceAll(path.sep, "/");
    } else {
      bytes = Buffer.from(args.content!, "utf8");
      if (!bytes.length) throw new Error("Asset content is empty");
      if (bytes.length > maxBytes) throw new Error(`Asset content is ${bytes.length} bytes, above ASSET_MAX_BYTES=${maxBytes}`);
    }

    const assetRoot = path.join(root, "site", "assets");
    const destination = normalizeDestination(args.destination);
    const output = path.resolve(assetRoot, destination);
    if (!output.startsWith(`${assetRoot}${path.sep}`)) throw new Error("Destination escaped site/assets");

    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, bytes, { mode: 0o644 });
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

    const file = path.relative(root, output).replaceAll(path.sep, "/");
    // Identical bytes already installed elsewhere is a generation bug (a retry
    // or variant loop re-emitting the same file), not a second asset; the
    // same destination with the same bytes is an idempotent no-op.
    const existing = (await readSourceRecords(root)).find((record) => record.sha256 === sha256);
    if (existing && existing.file !== file) {
      throw new Error(`Identical asset is already installed at ${existing.file}; use that file or change the asset before saving to ${file}`);
    }
    if (existing && existing.file === file) {
      return `Already installed ${file} (${bytes.length} bytes, unchanged).`;
    }
    await queueSourceRecord(root, {
      file,
      origin: "generated",
      ...(generatedFrom ? { generatedFrom } : {}),
      note: args.note || "generated in-project by the asset-forge subagent",
      bytes: bytes.length,
      sha256,
      createdAt: new Date().toISOString(),
    });

    return `Saved ${file} (${bytes.length} bytes). Provenance was recorded in ASSET_SOURCES.json.`;
  },
});

/** Current provenance records; a missing or corrupt document reads as empty
 * (the write queue owns recovery) so dedup never blocks a first save. */
async function readSourceRecords(root: string): Promise<Array<{ file?: unknown; sha256?: unknown }>> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(root, "ASSET_SOURCES.json"), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
