# ThreadSite project skills

Every skill here ships in the bot image and is seeded into game workspaces by
`bot/src/skills.ts` (`ensureSkillFiles`), re-checked before every mutation and
after every turn. Two tiers:

- **Maintained in-tree — edit the files directly, never download over them:**
  `game-2d`, `game-3d`, `phaser-4` (authored), and `threejs-game-studio`
  (forked from chrislaupama/threejs-game-studio, MIT — it needed heavy
  ThreadSite re-curation: Rapier/three-mesh-bvh physics guidance,
  harness-native release gates instead of its npm scripts).
- **Downloaded from upstream:** the engine-neutral discipline and genre
  playbooks from gamedev-skills/awesome-gamedev-agent-skills (Apache-2.0),
  refreshed with `node scripts/fetch-skills.mjs`, which stamps harness-context
  banners, validates frontmatter, and scrubs references to catalog skills
  ThreadSite does not ship. Do not hand-edit these; re-run the script instead.

Invariants for both tiers: no npm/Vite/CDN/scaffold instructions (the harness
runs the only build and preinstalls the engines), and cross-skill pointers
must only name skills from the managed list in `bot/src/skills.ts`.
