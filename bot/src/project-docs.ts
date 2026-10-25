import fs from "node:fs/promises";
import path from "node:path";

/**
 * The project's three author-maintained documents, kept next to the README in
 * the project root:
 *
 * - `DESCRIPTION.md` — what the project is, in a visitor's words, plus how to
 *   play it. The agent keeps it current; the play card shows it.
 * - `CHANGELOG.md` — one section per turn, newest first. The agent adds an
 *   entry before its final summary; the play card shows the newest one.
 * - `README.agent.md` — the long-form README appended to `README.md` at the end
 *   of every turn: what the project is, how to use or play it, controls and
 *   useful notes. The harness owns `README.md` itself.
 *
 * All live outside `site/`, so they are repository content rather than
 * published pages, and all are read back after every turn.
 */
export const DESCRIPTION_FILE = "DESCRIPTION.md";
export const CHANGELOG_FILE = "CHANGELOG.md";
export const README_AGENT_FILE = "README.agent.md";
/** Leave room below Forgejo's 64 KiB ownership-detection limit. */
export const README_MAX_BYTES = 63 * 1024;
/** Keep the generated README well below Forgejo's 64 KiB ownership-detection limit. */
export const README_SECTION_MAX_BYTES = 24 * 1024;

/** The description as the play card shows it: the pitch and how to play. */
export interface ProjectDescription {
  /** What the project is and what a visitor can do. */
  pitch?: string;
  /** The how-to-play section: goal, controls, and a tip or two; shown in the card's expanded view. */
  play?: string;
}

/** The newest changelog entry, as the play card shows it. */
export interface ProjectChangelog {
  /** The entry's heading, without the hashes. */
  title?: string;
  /** The entry's body. */
  body?: string;
}

/** The first `DESCRIPTION.md` a new project starts with. */
export function descriptionTemplate(name: string): string {
  return `# ${name}\n\n`
    + "<!-- The heading above is the project's public name: replace it with the distinctive name you chose for what you built. -->\n"
    + "<!-- One sentence, at most 25 words, in words a visitor understands: what this is and what they can do. No file names, no code, no internals, and keep it on one line. Replace this line. -->\n\n"
    + "## How to play\n\n"
    + "<!-- Up to four short paragraphs, about 120 words total: the goal first, then the controls, then a tip or two. Visitor words only. Replace this. -->\n";
}

/** The first `CHANGELOG.md` a new project starts with. */
export function changelogTemplate(): string {
  return "# Changelog\n\n"
    + "<!-- Add a new section at the top of this file for each turn: a heading of at most six words, then one sentence, on one line, about what a visitor will notice. -->\n";
}

/** The first `README.agent.md` a new project starts with. */
export function readmeAgentTemplate(): string {
  return "<!-- This file is appended to README.md at the end of every turn. Edit this file, never README.md. -->\n"
    + "<!-- Write a concise, visitor-facing README section: what the project is, how to play or use it, the controls, and useful development notes. Use ## headings and keep it under 6,000 characters. -->\n"
    + "<!-- Do not repeat the harness-owned title, live link, original request or attribution. -->\n";
}

/** Strip the placeholder comments and the leading heading from a document. */
function cleanDocument(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r?\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Create the three project documents when they are missing. Existing content is
 * never touched: the agent owns them from then on.
 */
export async function ensureProjectDocuments(workspacePath: string, name: string): Promise<boolean> {
  let created = false;
  // lstat, not stat: a dangling symlink must never redirect a harness write
  // outside the workspace.
  const ensure = async (file: string, content: string): Promise<void> => {
    if (await fs.lstat(file).then(() => true, () => false)) return;
    await fs.writeFile(file, content, "utf8");
    created = true;
  };
  await ensure(path.join(workspacePath, DESCRIPTION_FILE), descriptionTemplate(name));
  await ensure(path.join(workspacePath, CHANGELOG_FILE), changelogTemplate());
  await ensure(path.join(workspacePath, README_AGENT_FILE), readmeAgentTemplate());
  return created;
}

/**
 * The project's chosen name: the first `# ` heading of DESCRIPTION.md. The
 * agent picks it while building; the harness adopts it as the project's
 * public identity once the first turn is delivered.
 */
export async function readProjectTitle(workspacePath: string): Promise<string | undefined> {
  const raw = await fs.readFile(path.join(workspacePath, DESCRIPTION_FILE), "utf8").catch(() => undefined);
  if (!raw) return undefined;
  return /^#\s+(.+)$/m.exec(raw)?.[1]?.trim() || undefined;
}

/**
 * Point DESCRIPTION.md's title heading at the project's current name after a
 * rename, leaving the agent-owned body untouched. Returns whether the file
 * changed. A missing or symlinked document is skipped: the next turn re-seeds
 * it with the current name anyway, and a harness write must never leave the
 * workspace.
 */
export async function setProjectTitle(workspacePath: string, name: string): Promise<boolean> {
  const file = path.join(workspacePath, DESCRIPTION_FILE);
  const stat = await fs.lstat(file).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink()) return false;
  const raw = await fs.readFile(file, "utf8");
  const reheading = raw.replace(/^#\s+.*$/m, `# ${name}`);
  const next = reheading === raw && !/^#\s/m.test(raw)
    ? `# ${name}\n\n${raw.replace(/^[^\S\n]+/, "")}` : reheading;
  if (next === raw) return false;
  await fs.writeFile(file, next, "utf8");
  return true;
}

/** Read the project's own description: the pitch above the "How to play" heading, and the play section below it. */
export async function readProjectDescription(workspacePath: string): Promise<ProjectDescription | undefined> {
  const raw = await fs.readFile(path.join(workspacePath, DESCRIPTION_FILE), "utf8").catch(() => undefined);
  return parseProjectDescription(raw);
}

export function parseProjectDescription(raw: string | undefined): ProjectDescription | undefined {
  if (!raw) return undefined;
  const text = cleanDocument(raw).replace(/^#\s+.*$/m, "").trim();
  if (!text) return undefined;
  const sections = text.split(/^##\s+(?:how to play|the goal|controls?|how it works)\s*$/im);
  const pitch = sections[0].trim();
  const play = sections.slice(1).join("\n").trim();
  // An untouched template carries placeholders only: it says nothing.
  if (!pitch && !play) return undefined;
  return {
    ...(pitch ? { pitch } : {}),
    ...(play ? { play } : {}),
  };
}

/** Read the newest changelog entry: the first section below the title. */
export async function readProjectChangelog(workspacePath: string): Promise<ProjectChangelog | undefined> {
  const raw = await fs.readFile(path.join(workspacePath, CHANGELOG_FILE), "utf8").catch(() => undefined);
  return parseProjectChangelog(raw);
}

/**
 * Read the agent-maintained README section. It becomes part of `README.md`, so
 * reject symlinks and bound the bytes: Forgejo only recognizes the repository
 * as harness-managed while that README stays under 64 KiB.
 */
export async function readProjectReadmeSection(workspacePath: string, maxBytes = README_SECTION_MAX_BYTES): Promise<string | undefined> {
  const file = path.join(workspacePath, README_AGENT_FILE);
  const stat = await fs.lstat(file).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink()) return undefined;
  const raw = await fs.readFile(file, "utf8").catch(() => undefined);
  const text = raw ? cleanDocument(raw) : "";
  if (!text) return undefined;
  const bytes = Buffer.from(text, "utf8");
  const limit = Math.max(0, Math.min(README_SECTION_MAX_BYTES, maxBytes));
  if (bytes.length <= limit) return text;
  const notice = `\n\n_README section truncated to fit the repository limit. See \`${README_AGENT_FILE}\` in the repository for the full text._`;
  const contentLimit = limit - Buffer.byteLength(notice, "utf8");
  if (contentLimit <= 0) return undefined;
  let cut = bytes.subarray(0, contentLimit).toString("utf8").replace(/\uFFFD+$/, "");
  const newline = cut.lastIndexOf("\n");
  if (newline > contentLimit / 2) cut = cut.slice(0, newline);
  return `${cut.trimEnd()}${notice}`;
}

export function parseProjectChangelog(raw: string | undefined): ProjectChangelog | undefined {
  if (!raw) return undefined;
  const text = cleanDocument(raw);
  const sections = text.split(/^##\s+/m);
  // The first chunk is the document title; the next one is the newest entry.
  const entry = sections[1];
  if (!entry) return undefined;
  const [heading, ...rest] = entry.split(/\r?\n/);
  const body = rest.join("\n").trim();
  const title = heading.trim();
  if (!title && !body) return undefined;
  return { ...(title ? { title } : {}), ...(body ? { body } : {}) };
}

/** Only author-owned, regular project documents can be exposed in a card panel. */
export async function readProjectCardDocument(workspacePath: string, kind: "description" | "changelog"): Promise<string | undefined> {
  const file = path.join(workspacePath, kind === "description" ? DESCRIPTION_FILE : CHANGELOG_FILE);
  const stat = await fs.lstat(file).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink()) return undefined;
  const text = await fs.readFile(file, "utf8").catch(() => undefined);
  return text ? cleanDocument(text) || undefined : undefined;
}
