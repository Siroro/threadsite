import fs from "node:fs/promises";
import path from "node:path";

/**
 * The project's two author-maintained documents, kept next to the README in
 * the project root:
 *
 * - `DESCRIPTION.md` — what the project is, in a visitor's words, plus how to
 *   play it. The agent keeps it current; the play card shows it.
 * - `CHANGELOG.md` — one section per turn, newest first. The agent adds an
 *   entry before its final summary; the play card shows the newest one.
 *
 * Both live outside `site/`, so they are repository content rather than
 * published pages, and both are read back after every turn.
 */
export const DESCRIPTION_FILE = "DESCRIPTION.md";
export const CHANGELOG_FILE = "CHANGELOG.md";

/** The description as the play card shows it: the pitch and how to play. */
export interface ProjectDescription {
  /** What the project is and what a visitor can do. */
  pitch?: string;
  /** The controls, or what to try first. */
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
    + "<!-- One sentence, at most 25 words, in words a visitor understands: what this is and what they can do. No file names, no code, no internals — and keep it on one line. Replace this line. -->\n\n"
    + "## How to play\n\n"
    + "<!-- One sentence, at most 20 words: the goal the player works toward, not the controls. One line. Replace this line. -->\n";
}

/** The first `CHANGELOG.md` a new project starts with. */
export function changelogTemplate(): string {
  return "# Changelog\n\n"
    + "<!-- Add a new section at the top of this file for each turn: a heading of at most six words, then one sentence, on one line, about what a visitor will notice. -->\n";
}

/** Strip the placeholder comments and the leading heading from a document. */
function cleanDocument(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r?\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Create the two project documents when they are missing. Existing content is
 * never touched: the agent owns them from then on.
 */
export async function ensureProjectDocuments(workspacePath: string, name: string): Promise<boolean> {
  let created = false;
  const description = path.join(workspacePath, DESCRIPTION_FILE);
  if (!await fs.stat(description).catch(() => undefined)) {
    await fs.writeFile(description, descriptionTemplate(name), "utf8");
    created = true;
  }
  const changelog = path.join(workspacePath, CHANGELOG_FILE);
  if (!await fs.stat(changelog).catch(() => undefined)) {
    await fs.writeFile(changelog, changelogTemplate(), "utf8");
    created = true;
  }
  return created;
}

/** Read the project's own description: the pitch above the "How to play" heading, and the play section below it. */
export async function readProjectDescription(workspacePath: string): Promise<ProjectDescription | undefined> {
  const raw = await fs.readFile(path.join(workspacePath, DESCRIPTION_FILE), "utf8").catch(() => undefined);
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
