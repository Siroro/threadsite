import { tool } from "@opencode-ai/plugin";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;


let sourceWriteQueue = Promise.resolve();

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

    return `Saved ${sourceRecord.file} (${bytes.length} bytes). Source metadata was recorded in ASSET_SOURCES.json. The copy under scratch/uploads remains — remove it once the file is installed.`;
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

async function queueSourceRecord(root: string, record: Record<string, unknown>): Promise<void> {
  const run = sourceWriteQueue.then(async () => {
    const file = path.join(root, "ASSET_SOURCES.json");
    let records: Array<Record<string, unknown>> = [];
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      if (Array.isArray(parsed)) records = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (!(error instanceof SyntaxError)) throw error;
        // Corrupt (e.g. truncated by a crash mid-write before writes were
        // rename-atomic): keep it aside for inspection and start a fresh
        // list rather than failing every future import.
        await fs.rename(file, `${file}.corrupt`).catch(() => undefined);
      }
    }
    records = records.filter((item) => item.file !== record.file);
    records.push(record);
    // Rename-atomic: a crash mid-write must not leave truncated JSON behind.
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o644 });
    await fs.rename(temp, file);
  });
  // One rejected write must not poison the tail: the tools share one
  // long-lived server process across every project session, so later calls
  // still run and only this caller sees its own error.
  sourceWriteQueue = run.catch(() => {});
  await run;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
