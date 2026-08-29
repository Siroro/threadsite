import path from "node:path";
import type { CommitAuthor } from "./types.js";

/** Discord rejects message content over 2000 chars; ThreadSite renders stay under it. */
export const MAX_DISCORD_MESSAGE_CHARS = 1990;

export function slugify(input: string, fallback = "site"): string {
  const value = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return value || fallback;
}

export function safeChild(root: string, ...parts: string[]): string {
  const target = path.resolve(root, ...parts);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (target !== path.resolve(root) && !target.startsWith(prefix)) throw new Error("Unsafe path traversal");
  return target;
}

/**
 * Build a git author identity from the Discord user who requested a change.
 * Display/nick names become the git author name; the unique @username becomes
 * a stable noreply email so Forgejo does not mix different users together.
 */
export function commitAuthorIdentity(user: {
  displayName?: string | null;
  globalName?: string | null;
  username: string;
  id?: string;
}): CommitAuthor {
  const rawName = String(user.displayName || user.globalName || user.username || "discord-user");
  const name = rawName.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 72)
    || String(user.username || "discord-user").slice(0, 72);
  const slug = String(user.username || user.id || "user")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "user";
  return { name, email: `${slug}@users.noreply.discord.com` };
}

export function parseModel(value: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!value) return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) throw new Error("Model must use provider/model-id format");
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}

export function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]!);
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Compact token counts for Discord: 1234 -> "1.2k", 1250000 -> "1.3M". */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`.replace(/\.0$/, "");
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`.replace(/\.0$/, "");
  return String(count);
}

/** USD cost with enough precision for both sub-cent per-turn amounts and large totals. */
export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  if (cost < 1000) return `$${cost.toFixed(2)}`;
  return `$${Math.round(cost).toLocaleString("en-US")}`;
}

/**
 * Drop leading summary sentences that merely restate the deliverable
 * ("Implemented a complete static 3D browser game in site/…") so final Discord
 * messages open with substance instead of meta-boilerplate. Only create-flavored
 * openers are stripped, and only when the sentence is short enough to be pure
 * restatement; if everything would be stripped the original text is kept.
 */
export function stripSummaryPreamble(summary: string): string {
  const original = summary.trim();
  let text = original.replace(/^[\s>*#-]+/, "");
  for (let i = 0; i < 2; i += 1) {
    const next = text
      .replace(
        /^(?:i\s+(?:have\s+)?)?(?:we\s+(?:have\s+)?)?(?:implemented|built|created|completed|made|delivered)\b[^.!?\n]{0,110}(?:[.!?]|\n)\s*/i,
        "",
      )
      .replace(/^[\s>*#-]+/, "");
    if (next === text || !next) break;
    text = next;
  }
  return text.trim() || original;
}

export function cleanThreadTitle(raw: string): string | undefined {
  const firstLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return undefined;
  const cleaned = firstLine
    .replace(/^[#>*\-•\s"'`]+/, "")
    .replace(/[`"']+/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "")
    .trim();
  const words = cleaned.split(" ");
  if (cleaned.length < 3 || cleaned.length > 80 || words.length > 10) return undefined;
  return cleaned;
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => resolve(undefined),
    );
  });
}
