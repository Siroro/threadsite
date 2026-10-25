import { tool } from "../v2/tool-definition.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeDestination, positiveInt } from "../lib/asset-inputs.js";
import { queueSourceRecord } from "../lib/asset-sources.js";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export default tool({
  description: "Copy a user-uploaded file from scratch/uploads into site/assets so the project can use it. Use it for sprites, audio, fonts, data files and other binaries the user attached in Discord; readable reference material can stay in place instead.",
  args: {
    source: tool.schema.string().min(1).max(220).describe("Workspace-relative path of the uploaded file, for example scratch/uploads/hero.png"),
    destination: tool.schema.string().min(1).max(180).describe("Path below site/assets, for example images/hero.png or audio/click.ogg"),
    note: tool.schema.string().max(300).optional().describe("Description or license/attribution note for the uploaded file, when known"),
  },
  async execute(args, context) {
    const root = path.resolve(context.directory);
    const uploadsRoot = path.join(root, "scratch", "uploads");
    const source = path.resolve(root, args.source);
    if (source !== uploadsRoot && !source.startsWith(`${uploadsRoot}${path.sep}`)) throw new Error("Source must be a file under scratch/uploads");
    const stat = await fs.lstat(source).catch(() => undefined);
    if (!stat?.isFile()) throw new Error(`Uploaded file not found: ${path.relative(root, source).replaceAll(path.sep, "/") || args.source}`);

    const maxBytes = positiveInt(process.env.ASSET_MAX_BYTES, DEFAULT_MAX_BYTES);
    if (stat.size > maxBytes) throw new Error(`Upload is ${stat.size} bytes, above ASSET_MAX_BYTES=${maxBytes}`);

    const assetRoot = path.join(root, "site", "assets");
    const destination = normalizeDestination(args.destination);
    const output = path.resolve(assetRoot, destination);
    if (!output.startsWith(`${assetRoot}${path.sep}`)) throw new Error("Destination escaped site/assets");

    const bytes = await fs.readFile(source);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, bytes, { mode: 0o644 });
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

    const sourceRecord = {
      file: path.relative(root, output).replaceAll(path.sep, "/"),
      uploadedFrom: path.relative(root, source).replaceAll(path.sep, "/"),
      note: args.note || "uploaded by the user via Discord",
      bytes: bytes.length,
      sha256,
      adoptedAt: new Date().toISOString(),
    };
    await queueSourceRecord(root, sourceRecord);

    return `Saved ${sourceRecord.file} (${bytes.length} bytes). Source metadata was recorded in ASSET_SOURCES.json. The copy under scratch/uploads remains; remove it once the file is installed.`;
  },
});
