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
 * Two scrub passes keep the shipped set lean and loadable. Dead-skill
 * scrubbing rewrites pointers to upstream-catalog skills ThreadSite does not
 * ship (`godot-*`, `unity-*`, `unreal-*`, `shader-programming`, ...) into
 * engine-neutral phrases, and harness-conflict scrubbing drops sections and
 * lines that instruct npm/Vite workflows the workspace forbids; the fetch
 * fails loudly if a dead reference survives, so upstream drift cannot
 * silently reintroduce pointers to skills the agent cannot load.
 *
 * Run from the repo root whenever the curation changes (needs curl + tar):
 *
 *   node scripts/fetch-skills.mjs
 *
 * Authored skills (game-2d, game-3d, phaser-4) are NOT managed here and never touched;
 * re-running overwrites only the skills listed in SOURCES.
 */
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const TARGET = path.join(process.cwd(), "bot", "assets", "skills");

/** The ThreadSite 3D skill package: one coordinator skill with internal
 * reference manuals, vendored selectively (no npm/Vite scaffold, no evals). */
const THREEJS_SKILLS = ["threejs-game-studio"];

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
  [/`shader-programming`/g, "a GPU shader reference"],
];

/**
 * Sections/lines whose instructions assume a self-managed npm project —
 * exactly what the harness forbids in a ThreadSite workspace. Matched
 * verbatim from the vendored sources; the fetch fails if one disappears
 * upstream, so the list cannot silently rot.
 */
const HARNESS_CONFLICT_REMOVALS = [
  {
    skill: "threejs-game-studio",
    // The "Greenfield Scaffold" section: an npm/Vite project generator.
    startMarker: "## Greenfield Scaffold",
    endMarker: "\n## ",
    reason: "npm/Vite scaffold is forbidden in ThreadSite workspaces",
  },
  {
    skill: "threejs-game-studio",
    // Novice default pointing at npm project management.
    linePattern: /^- Vite \+ TypeScript \+ npm \+ `three` package imports\.$/,
    reason: "npm/Vite default conflicts with the harness-managed build",
  },
];

/**
 * Verbatim find/replace on the skill entry file where the guidance must be
 * kept but re-expressed for the harness (npm commands -> harness-native
 * verification). Applied before HARNESS_CONFLICT_REMOVALS; a stale find
 * that matches nothing is skipped and the removals/asserts still guard.
 */
const HARNESS_CONFLICT_REPLACEMENTS = [
  {
    skill: "threejs-game-studio",
    find: "At discovery:\n\n```bash\nnpm ls three\nnode -e \"import('three').then((THREE) => console.log(THREE.REVISION))\"\n```\n\nFor a greenfield project, check the current stable package through the bounded\nprobe after dependencies exist:\n\n```bash\nnpm --prefix <this-skill-dir> run probe:three -- <project>\n```\n\nThe probe limits npm lookup time to 20 seconds. If npm is unavailable, record\nthe offline result, use the reproducible verified lockfile, and do not claim a\nnewer stable target until the networked check can be rerun.",
    replace: "At discovery, import `three` and log `THREE.REVISION` from the installed engine package to confirm the revision you are authoring against. The harness pins and installs the engine, so record the observed revision and never claim a newer stable target than what is installed.",
  },
  {
    skill: "threejs-game-studio",
    find: "Run\n`npm --prefix <this-skill-dir> run audit:project-local -- <project>` before\nrelease.",
    replace: "Before release, walk every downloaded asset in `site/assets/` and confirm each entry in `ASSET_SOURCES.json` names its source and license.",
  },
  {
    skill: "threejs-game-studio",
    find: "For release or broad completion claims, prefer the unified ship check:\n\n```bash\nnpm --prefix <this-skill-dir> run ship-check -- /path/to/game\n```",
    replace: "For release or broad completion claims, verify in a real browser against the published preview URL: every level loads, the core loop completes, no console errors, and performance holds on a mid-range laptop.",
  },
  {
    skill: "threejs-game-studio",
    find: "Copy `assets/game-report.template.md` and audit an ordinary broad report:\n\n```bash\nnpm --prefix <this-skill-dir> run audit:report -- /path/to/report.md\n```",
    replace: "Copy `assets/game-report.template.md` and audit an ordinary broad report against it before claiming the matching tier.",
  },
  {
    skill: "threejs-game-studio",
    find: "The generated scaffold starts from that\nreproducible lockfile; compare it with current stable and upgrade intentionally\nwhen they differ.",
    replace: "For a new project, use the installed revision as the baseline; upgrade intentionally when a newer stable is required.",
  },
  {
    skill: "threejs-game-studio",
    find: "For a maintenance refresh, run `npm run audit:official-links`; keep this\nnetworked link check separate from deterministic offline verification.",
    replace: "For a maintenance refresh, spot-check the linked official pages; keep this networked check separate from deterministic offline verification.",
  },
  {
    skill: "threejs-game-studio",
    find: "- Use npm only for build-time installation. Bundle Three.js and official addons\n  with the application; do not hotlink runtime modules from a CDN.",
    replace: "- The engine is bundled by the harness build; do not hotlink runtime modules from a CDN.",
  },
  {
    skill: "threejs-game-studio",
    find: "- Import or asset issues → `references/local-assets.md` + `npm run audit:assets`",
    replace: "- Import or asset issues → `references/local-assets.md`",
  },
];

/**
 * Same contract as HARNESS_CONFLICT_REPLACEMENTS but applied to the skill's
 * reference manuals (verbatim, all files), for npm commands and scaffold
 * pointers that live outside the entry file.
 */
const REFERENCE_REPLACEMENTS = [
  {
    file: "references/local-assets.md",
    find: "For imported models and textures, also run this package's asset checklist:\n\n```bash\nnpm --prefix <this-skill-dir> run audit:assets -- <project>\n```",
    replace: "For imported models and textures, walk every file in `site/assets/` and confirm each entry in `ASSET_SOURCES.json` names its source and license before release.",
  },
  {
    file: "references/webgpu.md",
    find: "The optional scaffold adapter at\n`assets/threejs-vite-game/src/examples/WebGpuRendererOption.ts` packages this\nownership pattern in compile-checked form.",
    replace: "Keep this ownership pattern in compile-checked TypeScript under `site/src/` — the harness type-checks it on every turn.",
  },
];

const BANNERS = {
  "chrislaupama/threejs-game-studio":
    "Vendored from chrislaupama/threejs-game-studio (MIT) by scripts/fetch-skills.mjs. "
    + "ThreadSite context: three.js is preinstalled in this workspace's harness-managed node_modules — import it by "
    + "its bare name (\"three\") with full TypeScript types. This workspace has NO npm, NO Vite, NO dev server, and "
    + "NO project scaffold: author TypeScript under site/src, keep assets under site/assets, and the harness runs "
    + "the only build (site/src TypeScript -> site/js ESM via esbuild). Map every project-setup/scaffold/build step "
    + "of this skill onto the existing ThreadSite workspace layout; skip its npm/Vite instructions entirely. "
    + "Verification happens in a real browser via the preview URL; see AGENTS.md.",
  "gamedev-skills/awesome-gamedev-agent-skills":
    "Vendored from gamedev-skills/awesome-gamedev-agent-skills (Apache-2.0) by scripts/fetch-skills.mjs. "
    + "ThreadSite context: the rendering engine (three/phaser) is preinstalled in this workspace's harness-managed "
    + "node_modules — import it by its bare name, never run npm or add package manifests, and no import maps are needed. "
    + "The harness runs the only build (site/src TypeScript -> site/js); see AGENTS.md.",
};

const SOURCES = [
  {
    repo: "chrislaupama/threejs-game-studio",
    ref: "main",
    license: "MIT",
    // The skill lives at the repo root; ship only the coordinator, the
    // reference manuals, and the scorecard/report anchors they point at —
    // not the npm/Vite scaffold, evals, or repo tooling.
    skills: [
      {
        name: "threejs-game-studio",
        from: ".",
        only: [
          "SKILL.md",
          "references",
          "assets/scorecard-anchors",
          "assets/game-report.template.md",
          "assets/content-provenance.template.md",
        ],
      },
    ],
  },
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
 * into an engine-neutral phrase, and — for the skill entry file only — drop
 * the sections/lines that instruct npm/Vite project management the workspace
 * forbids. Runs on every vendored markdown file;
 * assertNoDeadReferences afterwards guarantees the result.
 */
function scrubMarkdown(text, skillName, isSkillEntry = false, relativeFile = "") {
  for (const replacement of REFERENCE_REPLACEMENTS) {
    if (replacement.file === relativeFile.replace(/\\/g, "/") && text.includes(replacement.find)) {
      text = text.replace(replacement.find, replacement.replace);
    }
  }
  if (isSkillEntry) {
    for (const replacement of HARNESS_CONFLICT_REPLACEMENTS) {
      if (replacement.skill === skillName && text.includes(replacement.find)) {
        text = text.replace(replacement.find, replacement.replace);
      }
    }
    for (const removal of HARNESS_CONFLICT_REMOVALS) {
      if (removal.skill !== skillName) continue;
      if (removal.startMarker !== undefined) {
        const start = text.indexOf(removal.startMarker);
        if (start === -1) fail(skillName, `harness-conflict section missing upstream (${removal.reason}); update fetch-skills.mjs`);
        const end = text.indexOf(removal.endMarker, start + removal.startMarker.length);
        text = text.slice(0, start) + text.slice(end === -1 ? text.length : end + 1);
      } else {
        const lines = text.split(/\r?\n/);
        const kept = lines.filter((line) => !removal.linePattern.test(line));
        if (kept.length === lines.length) fail(skillName, `harness-conflict line missing upstream (${removal.reason}); update fetch-skills.mjs`);
        text = kept.join("\n");
      }
    }
  }

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
  text = text.replace(/`shader-programming`/g, "a GPU shader reference");
  text = text.replace(new RegExp(`\\\`${ENGINE_SKILL_NAME.source}\\\``, "g"), GENERIC_ENGINE_SKILL);
  text = text.replace(new RegExp(`(?<![\\\`\\w])${ENGINE_SKILL_NAME.source}`, "g"), GENERIC_ENGINE_SKILL);
  text = text.replace(/ {2,}/g, " ");
  // A parenthetical that ended up containing only a scrub phrase adds
  // nothing ("the engine animation skill (the engine's equivalent API)").
  text = text.replace(/\s*\((?:the engine's equivalent API|a GPU shader reference)\)(?=[\s.,;:)]|$)/g, "");
  return text;
}

/** Final gate: no pointer to an unshipped skill may survive vendoring. */
function assertNoDeadReferences(text, skillName) {
  const survivor = text.match(new RegExp(`\\\`?shader-programming\\\`|\\\`?${ENGINE_SKILL_NAME.source}\\\``));
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
        if (skill.only) {
          // Selective vendoring: copy only the listed files/dirs (paths
          // relative to the skill source), preserving their subpaths.
          for (const rel of skill.only) {
            const sourcePath = path.join(from, ...rel.split("/"));
            const targetPath = path.join(to, ...rel.split("/"));
            await mkdir(path.dirname(targetPath), { recursive: true });
            await cp(sourcePath, targetPath, { recursive: true, force: true });
          }
        } else {
          await cp(from, to, { recursive: true, force: true });
        }
        // Scrub harness-conflicting instructions and dead skill references
        // in every markdown file of the vendored skill, then re-write the
        // normalized SKILL.md (its body was scrubbed too).
        const banner = `<!-- ${BANNERS[source.repo]} -->`;
        for (const file of await listMarkdown(to)) {
          const isEntry = file === path.join(to, "SKILL.md");
          const text = isEntry ? normalized : await readFile(file, "utf8");
          const scrubbed = scrubMarkdown(text, skill.name, isEntry, path.relative(to, file));
          assertNoDeadReferences(scrubbed, skill.name);
          await writeFile(file, isEntry ? scrubbed : `${banner}\n\n${scrubbed}`, "utf8");
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
