#!/usr/bin/env node
/**
 * Vendor the curated third-party agent skills into bot/assets/skills/.
 *
 * Game workspaces get the skills their kind needs (the map lives in
 * bot/src/skills.ts); the bytes ship in the bot image like the vendored
 * multiplayer client. This script downloads the ENGINE-NEUTRAL discipline
 * and genre playbooks from the upstream catalog — the skills that need no
 * per-skill wrangling — and keeps them loadable here: it validates each
 * SKILL.md's frontmatter against OpenCode's rules (name matches the
 * directory, description unfolded to 1-1024 chars), stamps a `license`
 * field when the source omits one, and prepends a short harness-context
 * banner so vendored guidance never fights the workspace rules in
 * AGENTS.md (no npm, no import maps, engine preinstalled, harness runs
 * the only build). A dead-skill scrub rewrites pointers to catalog skills
 * ThreadSite does not ship (`godot-*`, `unity-*`, `dialogue-systems`,
 * ...) into neutral phrases, and the fetch fails loudly if a dead
 * reference survives, so upstream drift cannot silently reintroduce
 * pointers to skills the agent cannot load.
 *
 * NOT managed here (maintained in-tree, never downloaded or overwritten):
 * the authored skills (game-2d, game-3d, phaser-4) and
 * threejs-game-studio, which is forked from chrislaupama/threejs-game-studio
 * because it required heavy ThreadSite re-curation (Rapier/three-mesh-bvh
 * physics guidance, harness-native release gates); edit those files
 * directly and keep their banners' invariants.
 *
 * Run from the repo root whenever the curation changes (needs curl + tar):
 *
 *   node scripts/fetch-skills.mjs
 */
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const TARGET = path.join(process.cwd(), "bot", "assets", "skills");

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

/**
 * Skill names the upstream catalogs reference that ThreadSite does not ship
 * (other engines' cores, plus the engine-neutral shader skill we trimmed for
 * leanness). Any `skill-name` mention in shipped prose would send the agent
 * to load a skill that does not exist, so each gets an engine-neutral rewrite.
 */
const DEAD_SKILL_REWRITES = [
  [/`godot-[\w-]+`/g, "the engine's equivalent API"],
  [/`unity-[\w-]+`/g, "the engine's equivalent API"],
  [/`unreal-[\w-]+`/g, "the engine's equivalent API"],
  [/`phaser-[\w-]+`/g, "the engine's equivalent API"],
  [/`pygame-[\w-]+`/g, "the engine's equivalent API"],
  [/`bevy-[\w-]+`/g, "the engine's equivalent API"],
  [/`love2d-[\w-]+`/g, "the engine's equivalent API"],
  [/`roblox-[\w-]+`/g, "the platform's cloud-persistence docs"],
  [/`shader-programming`/g, "a GPU shader reference"],
  [/`dialogue-systems`/g, "a branching-dialogue reference"],
  [/`prototype-fast`/g, "a rapid prototype"],
];

const BANNERS = {
  "gamedev-skills/awesome-gamedev-agent-skills":
    "Vendored from gamedev-skills/awesome-gamedev-agent-skills (Apache-2.0) by scripts/fetch-skills.mjs. "
    + "ThreadSite context: the rendering engine (three/phaser) is preinstalled in this workspace's harness-managed "
    + "node_modules — import it by its bare name, never run npm or add package manifests, and no import maps are needed. "
    + "The harness runs the only build (site/src TypeScript -> site/js); see AGENTS.md.",
};

const SOURCES = [
  {
    repo: "gamedev-skills/awesome-gamedev-agent-skills",
    ref: "main",
    license: "Apache-2.0",
    skills: [
      ...DISCIPLINE_SKILLS.map((name) => ({ name, from: `skills/disciplines/${name}` })),
      ...GENRE_SKILLS.map((name) => ({ name, from: `skills/genres/${name}` })),
    ],
  },
];

function fail(skill, message) {
  throw new Error(`${skill}: ${message}`);
}

/** Stand-in phrase for a skill we do not ship, e.g. `godot-tilemap`. */
const GENERIC_ENGINE_SKILL = "the engine's equivalent API";

/**
 * Whole-line replacements for references a mechanical token rewrite would
 * mangle (possessives, mixed lists). Matched verbatim; a stale entry is
 * simply skipped, and the dead-reference assert below still guards the
 * result.
 */
const LINE_OVERRIDES = [
  {
    skill: "game-ui-ux",
    find: "This mirrors the state-stack idea in `love2d-core`'s `references/state-stack.md`, applied to UI.",
    replace: "This mirrors the state-stack idea from the same engine-neutral playbook collection, applied to UI.",
  },
  {
    skill: "fps-shooter",
    find: "- **Controller + camera:** `godot-3d-essentials` (Godot) or `unreal-cpp-gameplay` / `unreal-blueprints`; Unity uses `unity-physics` + a character controller.",
    replace: "- **Controller + camera:** the shipped engine's camera and character-controller support; see `camera-systems` and `input-systems`.",
  },
];

const ENGINE_SKILL_NAME = /(?:godot|unity|unreal|phaser|pygame|bevy|love2d)-[\w-]+/;

/**
 * Rewrite every mention of an upstream-catalog skill ThreadSite does not ship
 * into an engine-neutral phrase. Runs on every vendored markdown file;
 * assertNoDeadReferences afterwards guarantees the result.
 */
function scrubMarkdown(text, skillName) {
  for (const override of LINE_OVERRIDES) {
    if (override.skill === skillName && text.includes(override.find)) {
      text = text.replace(override.find, override.replace);
    }
  }

  // Collapse adjacent reference groups first (`godot-x`, `unity-y` -> one
  // phrase), then singles, then bare (unbackticked) name mentions.
  text = text.replace(
    new RegExp(`\\\`${ENGINE_SKILL_NAME.source}\\\`(?:\\s*(?:/|,|,? ?or|,? ?and)\\s*\\\`${ENGINE_SKILL_NAME.source}\\\`)+`, "g"),
    GENERIC_ENGINE_SKILL,
  );
  text = text.replace(new RegExp(`\\\`${ENGINE_SKILL_NAME.source}\\\``, "g"), GENERIC_ENGINE_SKILL);
  text = text.replace(new RegExp(`(?<![\\\`\\w])${ENGINE_SKILL_NAME.source}`, "g"), GENERIC_ENGINE_SKILL);
  // Standalone dead names run after the engine-family passes above (their
  // engine patterns then match nothing; they stay in the list as the record).
  for (const [pattern, phrase] of DEAD_SKILL_REWRITES) {
    text = text.replace(pattern, phrase);
  }
  text = text.replace(/ {2,}/g, " ");
  // A parenthetical that ended up containing only a scrub phrase adds
  // nothing ("the engine animation skill (the engine's equivalent API)").
  text = text.replace(/\s*\((?:the engine's equivalent API|a GPU shader reference|a branching-dialogue reference|a rapid prototype|the platform's cloud-persistence docs)\)(?=[\s.,;:)]|$)/g, "");
  return text;
}

/** Final gate: no pointer to an unshipped skill may survive vendoring. */
function assertNoDeadReferences(text, skillName) {
  const survivor = text.match(
    new RegExp(`\\\`?(?:shader-programming|dialogue-systems|prototype-fast|roblox-datastores)\\\`?|\\\`?${ENGINE_SKILL_NAME.source}\\\``),
  );
  if (survivor) fail(skillName, `unscrubbed engine-skill reference "${survivor[0].trim()}"`);
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

/** Every .md file under root, as absolute paths. */
async function listMarkdown(root) {
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith(".md")) files.push(child);
    }
  }
  await walk(root);
  return files.sort();
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
        // Scrub dead skill references in every markdown file of the vendored
        // skill, then re-write the normalized SKILL.md (its body was scrubbed
        // too).
        for (const file of await listMarkdown(to)) {
          const isEntry = file === path.join(to, "SKILL.md");
          const text = isEntry ? normalized : await readFile(file, "utf8");
          const scrubbed = scrubMarkdown(text, skill.name);
          assertNoDeadReferences(scrubbed, skill.name);
          await writeFile(file, isEntry ? scrubbed : `<!-- ${BANNERS[source.repo]} -->\n\n${scrubbed}`, "utf8");
        }
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
