import fs from "node:fs/promises";
import path from "node:path";
import type { Attachment } from "discord.js";
import type { PromptImage } from "./opencode-shared.js";
import { logError } from "./logger.js";
import { formatBytes, safeChild } from "./util.js";
import { ensureWorkspaceDirectory } from "./workspace-inputs.js";

/**
 * Non-image attachments cannot ride the prompt's file channel: the agent
 * service inlines only text and images into the model request, so PDFs,
 * sprites, audio and archives would never reach the model as parts. Their
 * bytes are instead saved into the workspace below scratch/uploads — a
 * gitignored, never-published directory the agent can read from and clean up —
 * and the prompt names the saved paths.
 */
/** Attachment rules shared by live-turn images, saved uploads and approval requests. */
export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;
export const UPLOAD_DIR = "scratch/uploads";

/** Images and saved files in the same request share both limits. */
export function attachmentBudget(): { remainingFiles: number; remainingBytes: number } {
  return { remainingFiles: MAX_ATTACHMENTS, remainingBytes: MAX_ATTACHMENT_TOTAL_BYTES };
}

export async function downloadAttachment(attachment: Attachment, budget: ReturnType<typeof attachmentBudget>): Promise<Buffer> {
  if (budget.remainingFiles <= 0) throw new Error("Attachment count limit reached.");
  budget.remainingFiles -= 1;
  if (attachment.size > budget.remainingBytes) throw new Error("Attachment byte limit reached.");
  const response = await fetch(attachment.url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Attachment download failed (${response.status}).`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > budget.remainingBytes) throw new Error("Attachment byte limit reached.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  budget.remainingBytes -= size;
  return Buffer.concat(chunks, size);
}

/** Capture expiring image URLs before a request waits behind the project queue. */
export async function downloadImageAttachments(attachments: Attachment[], budget = attachmentBudget()): Promise<PromptImage[]> {
  const images: PromptImage[] = [];
  for (const attachment of attachments.slice(0, MAX_ATTACHMENTS)) {
    try {
      const bytes = await downloadAttachment(attachment, budget);
      const mime = attachment.contentType ?? "image/png";
      images.push({ mime, filename: attachment.name ?? undefined, dataUrl: `data:${mime};base64,${bytes.toString("base64")}` });
    } catch (error) {
      logError("discord.image_download_failed", error, { url: attachment.url });
    }
  }
  return images;
}

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
export async function saveUploadAttachments(workspacePath: string, attachments: Attachment[], budget = attachmentBudget()): Promise<UploadedFile[]> {
  const saved: UploadedFile[] = [];
  for (const attachment of attachments.slice(0, MAX_ATTACHMENTS)) {
    try {
      const bytes = await downloadAttachment(attachment, budget);
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
  const dir = await ensureWorkspaceDirectory(workspacePath, UPLOAD_DIR.split("/"));
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
