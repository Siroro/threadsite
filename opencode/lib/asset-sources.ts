import fs from "node:fs/promises";
import path from "node:path";

// Imports and downloads update the same document. Share a per-workspace tail
// so their read/merge/rename operations cannot overwrite each other's records.
const sourceWriteQueues = new Map<string, Promise<void>>();

export function queueSourceRecord(root: string, record: Record<string, unknown>): Promise<void> {
  const run = (sourceWriteQueues.get(root) ?? Promise.resolve()).then(async () => {
    const file = path.join(root, "ASSET_SOURCES.json");
    let records: Array<Record<string, unknown>> = [];
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      if (Array.isArray(parsed)) records = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (!(error instanceof SyntaxError)) throw error;
        // Preserve a truncated/corrupt document for inspection and recover.
        await fs.rename(file, `${file}.corrupt`).catch(() => undefined);
      }
    }
    records = records.filter((item) => item.file !== record.file);
    records.push(record);
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o644 });
    await fs.rename(temp, file);
  });
  // A failed write must reject its caller without poisoning later updates.
  const tail = run.catch(() => {}).finally(() => {
    if (sourceWriteQueues.get(root) === tail) sourceWriteQueues.delete(root);
  });
  sourceWriteQueues.set(root, tail);
  return run;
}
