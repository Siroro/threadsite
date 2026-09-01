#!/usr/bin/env node
/**
 * Vendor the curated third-party agent skills into bot/assets/skills/.
 *
 * Game workspaces get the skills their kind needs (the map lives in
 * bot/src/skills.ts); the bytes ship in the bot image like the vendored
 * multiplayer client. This script is the curation record: it downloads the
 * pinned sources, validates each SKILL.md's frontmatter against OpenCode's
 * rules (name matches the directory, description unfolded to 1-1024 chars),
 * stamps a `license` field when the source omits one, and prepends a short
 * harness-context banner so vendored guidance never fights the workspace
 * rules in AGENTS.md (no npm, no import maps, engine preinstalled, harness
 * runs the only build).
 *
 * Run from the repo root whenever the curation changes (needs curl + tar):
 *
 *   node scripts/fetch-skills.mjs
 *
 * Authored skills (game-2d, game-3d) are NOT managed here and never touched;
 * re-running overwrites only the skills listed in SOURCES.
 */
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const TARGET = path.join(process.cwd(), "bot", "assets", "skills");

/** Official PixiJS v8 skill pack — API references with trigger keyword lists. */
const PIXIJS_SKILLS = [
  "pixijs-application",
  "pixijs-assets",
  "pixijs-core-concepts",
  "pixijs-events",
  "pixijs-filters",
  "pixijs-performance",
  "pixijs-scene-container",
  "pixijs-scene-graphics",
  "pixijs-scene-particle-container",
  "pixijs-scene-sprite",
  "pixijs-scene-text",
  "pixijs-ticker",
];

/** Engine-neutral three.js trio from the gamedev collection (the official
 * PixiJS pack already covers the 2D engine surface). */
const THREEJS_SKILLS = ["threejs-scene-setup", "threejs-materials-lighting", "threejs-gltf-loading"];

/** Engine-neutral disciplines shared by both game kinds. */
const DISCIPLINE_SKILLS = [
  "game-ai",
  "game-feel",
  "game-ui-ux",
  "camera-systems",
  "input-systems",
  "audio-design",
  "level-design",
  "performance-optimization",
  "physics-tuning",
  "procedural-gen",
  "save-systems",
];

/** Genre playbooks shared by both game kinds. */
const GENRE_SKILLS = [
  "card-game",
  "fps-shooter",
  "platformer",
  "puzzle",
  "roguelike",
  "rpg",
  "survival-crafting",
  "tower-defense",
  "visual-novel",
];

const BANNERS = {
  "pixijs/pixijs-skills":
    "Vendored from pixijs/pixijs-skills (MIT) by scripts/fetch-skills.mjs. "
    + "ThreadSite context: pixi.js is preinstalled in this workspace's harness-managed node_modules — "
    + "import it by its bare name, never run npm, never vendor a second copy, and no import maps are needed. "
    + "The harness runs the only build (site/src TypeScript -> site/js); see AGENTS.md.",
  "gamedev-skills/awesome-gamedev-agent-skills":
    "Vendored from gamedev-skills/awesome-gamedev-agent-skills (Apache-2.0) by scripts/fetch-skills.mjs. "
    + "ThreadSite context: the rendering engine (three/pixi.js) is preinstalled in this workspace's harness-managed "
    + "node_modules — import it by its bare name, never run npm or add package manifests, and no import maps are needed. "
    + "The harness runs the only build (site/src TypeScript -> site/js); see AGENTS.md.",
};

const SOURCES = [
  {
    repo: "pixijs/pixijs-skills",
    ref: "main",
    license: "MIT",
    skills: PIXIJS_SKILLS.map((name) => ({ name, from: `skills/${name}` })),
  },
  {
    repo: "gamedev-skills/awesome-gamedev-agent-skills",
    ref: "main",
    license: "Apache-2.0",
    skills: [
      ...THREEJS_SKILLS.map((name) => ({ name, from: `skills/web-engines/${name}` })),
      ...DISCIPLINE_SKILLS.map((name) => ({ name, from: `skills/disciplines/${name}` })),
      ...GENRE_SKILLS.map((name) => ({ name, from: `skills/genres/${name}` })),
    ],
  },
];

function fail(skill, message) {
  throw new Error(`${skill}: ${message}`);
}

function parseFrontmatter(skill, text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) fail(skill, "no YAML frontmatter");
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

/** Unfold `description:` the way YAML would (quoted scalar or a folded `>` block). */
function descriptionText(skill, frontmatter) {
  const lines = frontmatter.split(/\r?\n/);
  const index = lines.findIndex((line) => /^description:/.test(line));
  if (index === -1) fail(skill, "no description field");
  const first = lines[index].replace(/^description:\s*/, "");
  if (!first.startsWith(">") && !first.startsWith("|")) {
    return first.replace(/^["']|["']$/g, "");
  }
  const collected = [];
  for (const line of lines.slice(index + 1)) {
    if (/^[A-Za-z][\w-]*:/.test(line)) break;
    if (line.trim()) collected.push(line.trim());
  }
  return collected.join(" ");
}

function boundedFrontmatter(skill, frontmatter, license) {
  const lines = frontmatter.split(/\r?\n/);
  const index = lines.findIndex((line) => /^description:/.test(line));
  if (index === -1) fail(skill, "no description field");
  const description = descriptionText(skill, frontmatter).slice(0, 1000).trim();
  let end = index + 1;
  if (/^description:\s*(?:>|\|)/.test(lines[index])) {
    while (end < lines.length && !/^[A-Za-z][\w-]*:/.test(lines[end])) end += 1;
  }
  lines.splice(index, end - index, `description: ${JSON.stringify(description)}`);
  if (!/^license:/m.test(lines.join("\n"))) lines.push(`license: ${license}`);
  return lines.join("\n");
}

async function downloadRepo(repo, ref, dir) {
  const url = `https://codeload.github.com/${repo}/tar.gz/refs/heads/${ref}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${repo}: download failed (HTTP ${response.status})`);
  const extracted = path.join(dir, repo.replace("/", "__"));
  await mkdir(extracted, { recursive: true });
  const archive = path.join(extracted, "source.tar.gz");
  await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  // codeload tarballs are prefixed with <repo>-<ref>/ (strip on extract). Run
  // with cwd inside the target and a relative archive name: absolute Windows
  // paths make GNU tar try to read the drive letter as a remote host.
  const tar = spawnSync("tar", ["-xzf", path.basename(archive), "--strip-components", "1"], { cwd: extracted, stdio: "inherit" });
  await rm(archive, { force: true });
  if (tar.status !== 0) throw new Error(`${repo}: tar exited ${tar.status}`);
  return extracted;
}

async function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await dirStats(child);
      files += nested.files;
      bytes += nested.bytes;
    } else {
      files += 1;
      bytes += (await stat(child)).size;
    }
  }
  return { files, bytes };
}

async function main() {
  const work = await mkdtemp(path.join(tmpdir(), "threadsite-skills-"));
  const report = [];
  try {
    for (const source of SOURCES) {
      const extracted = await downloadRepo(source.repo, source.ref, work);
      for (const skill of source.skills) {
        const from = path.join(extracted, skill.from);
        if (!await stat(from).then(() => true, () => false)) fail(skill.name, `missing in ${source.repo} at ${skill.from}`);

        const original = await readFile(path.join(from, "SKILL.md"), "utf8");
        const { frontmatter, body } = parseFrontmatter(skill.name, original);
        const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
        if (name !== skill.name) fail(skill.name, `frontmatter name "${name}" does not match directory`);
        const bounded = boundedFrontmatter(skill.name, frontmatter, source.license);
        const length = descriptionText(skill.name, bounded).length;
        if (length < 1 || length > 1024) fail(skill.name, `description unfolds to ${length} chars (OpenCode allows 1-1024)`);

        const normalized =
          `---\n${bounded}\n---\n\n`
          + `<!-- ${BANNERS[source.repo]} -->\n\n`
          + `${body.trimEnd()}\n`;

        const to = path.join(TARGET, skill.name);
        await rm(to, { recursive: true, force: true });
        await mkdir(to, { recursive: true });
        await cp(from, to, { recursive: true, force: true });
        await writeFile(path.join(to, "SKILL.md"), normalized, "utf8");
        report.push({ skill: skill.name, source: source.repo, license: source.license, ...await dirStats(to) });
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  console.log(`Vendored ${report.length} skills into ${path.relative(process.cwd(), TARGET)}:\n`);
  for (const row of report) {
    console.log(`  ${row.skill.padEnd(34)} ${String(row.files).padStart(2)} file(s) ${String(row.bytes).padStart(7)} B  ${row.license.padEnd(11)} ${row.source}`);
  }
}

main().catch((error) => {
  console.error(`\nfetch-skills failed: ${error.message}`);
  process.exit(1);
});
