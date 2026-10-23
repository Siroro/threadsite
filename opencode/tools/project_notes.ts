import { tool } from "../v2/tool-definition.js";
import fs from "node:fs/promises";
import path from "node:path";

const NOTES_FILE = "PROJECT_NOTES.md";
const HEADER = `<!-- threadsite:harness-owned-header:start -->
# Project Notes

Long-lived project memory maintained by the sitebuilder agent. These notes are
injected into every future turn, even after a session reset or compaction.

Write concise, durable facts only: user preferences, deliberate design
decisions, known constraints, and things future turns must not break.
Do not log per-turn changelogs — git history already covers those.
<!-- threadsite:harness-owned-header:end -->
`;
const MAX_NOTES_BYTES = 32 * 1024;

export default tool({
  description:
    "Append a durable note to the project's long-term memory (PROJECT_NOTES.md). Notes are injected into every future turn, surviving session resets and compaction. Use for user preferences, deliberate design decisions, and constraints future turns must respect. Keep it concise; do not log per-turn changes.",
  args: {
    note: tool.schema.string().min(4).max(2000).describe("One concise durable note. Prefix with a category like [preference], [decision], [constraint], or [gotcha]."),
  },
  async execute(args, context) {
    const root = path.resolve(context.directory);
    const file = path.join(root, NOTES_FILE);

    let current = "";
    try {
      current = await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Re-create the header if it was lost; keep only the body that follows it.
    const marker = "threadsite:harness-owned-header:end -->";
    const body = current.includes(marker)
      ? current.slice(current.indexOf(marker) + marker.length).trim()
      : "";

    const line = `- ${args.note.trim().replace(/\r?\n+/g, " ")}`;
    const nextBody = body ? `${body}\n${line}` : line;
    if (Buffer.byteLength(`${HEADER}\n${nextBody}\n`, "utf8") > MAX_NOTES_BYTES) {
      throw new Error(`PROJECT_NOTES.md would exceed ${MAX_NOTES_BYTES} bytes. Existing notes may need pruning by an administrator.`);
    }

    await fs.writeFile(file, `${HEADER}\n${nextBody}\n`, { mode: 0o644 });
    return `Noted: ${line}`;
  },
});
