import fs from "node:fs/promises";
import path from "node:path";
import type { Attachment } from "discord.js";
import { logError } from "./logger.js";
import { formatBytes, safeChild } from "./util.js";

/**
 * Non-image attachments cannot ride the prompt's file channel: the agent
 * service inlines only text and images into the model request, so PDFs,
 * sprites, audio and archives would never reach the model as parts. Their
 * bytes are instead saved into the workspace below scratch/uploads — a
 * gitignored, never-published directory the agent can read from and clean up —
 * and the prompt names the saved paths.
 */
export const MAX_TURN_UPLOADS = 4;
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const UPLOAD_DIR = "scratch/uploads";

export interface UploadedFile {
  /** Stored file name inside scratch/uploads. */
  name: string;
  /** Workspace-relative path, exactly as the prompt references it. */
  path: string;
  bytes: number;
  mime?: string;
}

/** A stored name safe to reference in a prompt: one path segment, no hidden files. */
export function uploadFileName(raw: string | undefined): string {
  const base = path.basename((raw ?? "").trim() || "file").replace(/[^A-Za-z0-9._-]+/g, "-");
  const cleaned = base.replace(/^[-.]+/, "").slice(0, 100).replace(/[.-]+$/, "");
  return cleaned || "file";
}

/**
 * Download uploadable attachments into the workspace now: Discord CDN URLs
 * expire, so like images the bytes must be captured at message receipt, before
 * the request waits behind the project queue. Oversized or undownloadable
 * attachments are skipped and reported through the return value's length.
 */
export async function saveUploadAttachments(workspacePath: string, attachments: Attachment[]): Promise<UploadedFile[]> {
  const saved: UploadedFile[] = [];
  for (const attachment of attachments.slice(0, MAX_TURN_UPLOADS)) {
    if (attachment.size > MAX_UPLOAD_BYTES) {
      logError("discord.upload_too_large", new Error(`attachment is ${attachment.size} bytes`), { threadWorkspace: workspacePath });
      continue;
    }
    try {
      const response = await fetch(attachment.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const name = await saveUniqueUpload(workspacePath, uploadFileName(attachment.name), bytes);
      saved.push({ name, path: `${UPLOAD_DIR}/${name}`, bytes: bytes.length, mime: attachment.contentType ?? undefined });
    } catch (error) {
      logError("discord.upload_save_failed", error, { url: attachment.url });
    }
  }
  return saved;
}

/** The prompt block that makes the agent aware of files saved for this request. */
export function uploadPromptNote(files: readonly UploadedFile[]): string {
  if (!files.length) return "";
  const list = files.map((file) => `- \`${file.path}\` (${formatBytes(file.bytes)}${file.mime ? `, ${file.mime}` : ""})`).join("\n");
  return `The user attached ${files.length} file${files.length === 1 ? "" : "s"}; the bytes are already saved in the workspace:\n${list}\nRead reference material in place, and install files the project should use into site/assets with asset_import.`;
}

/** Keep every upload's original name while never overwriting an existing file. */
async function saveUniqueUpload(workspacePath: string, desired: string, bytes: Buffer): Promise<string> {
  const dir = safeChild(workspacePath, UPLOAD_DIR);
  await fs.mkdir(dir, { recursive: true });
  const extension = path.extname(desired);
  const stem = desired.slice(0, desired.length - extension.length) || "file";
  for (let attempt = 1; ; attempt += 1) {
    const name = attempt === 1 ? desired : `${stem}-${attempt}${extension}`;
    try {
      // Claim and write in one operation: overlapping Discord handlers can
      // choose the same name before either has finished saving its request.
      await fs.writeFile(safeChild(dir, name), bytes, { mode: 0o644, flag: "wx" });
      return name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
