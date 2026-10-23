# Project rules

The harness builds, validates, commits and publishes this project as static files. You author source; it owns the build and deployment.

## Workspace

- Edit `site/`, `scratch/<name>/`, and root `DESCRIPTION.md` / `CHANGELOG.md`. Browser TypeScript belongs in `site/src/`; styles, media and data go in `site/css/`, `site/assets/` and `site/data/`.
- Read/import but never edit harness inputs: `site/net/`, `node_modules/`, `AGENTS.md`, `NETWORKING.md`, `README.md`, `ASSET_SOURCES.json`, `build-manifest.json`, `.opencode/`. Never edit generated `site/js/`.
- Static browser code only. No backend, secrets, dotfiles, symlinks or package/build configuration. Use relative URLs: publication may be under any path prefix.
- Author with edit/write/apply_patch. Shell is for permitted inspection, checks and asset handling; never bypass editing restrictions. Git writes, package managers, builds and publication belong to the harness.

## Workflow

- Inspect existing work; preserve working features unless the request changes them. For multi-step work, use `todowrite` before editing: 3–6 checkable tasks, one `in_progress`, updated as each finishes. End with completed/cancelled statuses. On recovery, `todoread` and continue the existing list.
- A `[THREADSITE_FORCE_FINISH]` steer means finish current edits, run checks and summarize unfinished scope; stop optional work.
- Record durable project decisions with `project_notes`.
- Render meaningful content on load: the first viewport becomes the project-card screenshot. Keep controls, feedback, keyboard/touch support, resize behavior and accessibility usable.

## Subagents

Use the `subagent` tool for focused exploration, research, independent implementation or review when a separate context helps. Handle small edits directly.

- Choose `agent: "explore"` for read-only code searches; `agent: "general"` for research, review or scoped implementation. Omit `model` to use the configured subagent model.
- Supply a short `description` and a self-contained `prompt`: goal, relevant paths, constraints and expected result. Children share your workspace; assign separate files and avoid overlapping edits.
- General/explore work runs with `background: false`. Read returned results, inspect changes and integrate them before final checks.
- General/explore children have no browser or question tools. Handle user questions yourself and remain responsible for the final deliverable and validation.

## Build and checks

Each top-level `site/src/*.ts` becomes `site/js/<name>.js`; nested files are imported modules. HTML loads `js/main.js`, never TypeScript. Relative imports such as `"./player.js"` resolve `player.ts`; installed packages use bare imports. JSON imports inline data; imported media emits asset URLs. Prefer linked CSS.

Use `js_syntax_check` on changed deliverable files. Before finishing, run the same full TypeScript check as the harness and fix its errors:

```sh
node /usr/local/lib/node_modules/typescript/bin/tsc --noEmit --allowJs --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM,DOM.Iterable --skipLibCheck site/src/*.ts
```

The harness bundles after your reply. Build/type/static errors block publication and get one repair attempt; fix source under `site/src/`, not generated output.

## Browser inspection

Browser MCP is available only to image-capable models. Text-only models receive no browser MCP tools; use source, syntax/type checks and supplied diagnostics.

When `browser-qa` is available, delegate one bounded inspection after building new UI/gameplay or making substantial visual/interaction changes. It uses a dedicated vision model even if yours is text-only. Pass the preview/scratch URL, viewport sizes, controls, expected behavior and specific checks; omit `model`. Use `background: true` to continue independent work while it inspects; results arrive automatically, so do not poll or duplicate its checks. Review its report before finishing, and request a focused recheck if later edits changed what it inspected. Keep code edits with the builder. If QA is unavailable or the budget is exhausted, finish static checks and state what was untested; findings are advisory.

With browser tools, inspect visual changes at `http://127.0.0.1:8080/<guild-id>/<thread-id>/` (IDs match `/workspace/<guild-id>/<thread-id>`). Reload after edits; preview compiles current source in memory. Inspect screenshots, interactions, console and local asset failures; test website desktop/mobile layouts and actual gameplay beyond the start screen. Close the browser afterward.

The preview browser reaches only its local origin: external APIs/fonts/media and the relay are unavailable. Test solo fallback; do not try to repair blocked external access. Harness browser QA is advisory. Report only checks actually performed.

### Scratch views

For isolated inspection, create `scratch/<name>/index.html` and `scratch/<name>/src/main.ts`; load `js/main.js`. Names use 1–64 letters/digits/hyphens/underscores, starting with a letter or digit.

Preview at `http://127.0.0.1:8080/<guild-id>/<thread-id>/__scratch/<name>/`. Each view compiles independently; imports may reach only that view, its project's `site/` and installed packages. From `scratch/car/src/main.ts`, a site import looks like `../../../site/src/vehicles/car.js`. Shared assets/styles/data use `__site/assets/`, `__site/css/`, `__site/data/` relative to the view URL.

Keep accepted code in `site/src/`. Scratch files are excluded from production builds, validation and Git, and never published; scratch errors do not block the deliverable.

## Project documents

Write paragraphs on single lines. These files supply the public project card:

- `DESCRIPTION.md`: a title, then one visitor-facing headline sentence (≤25 words). Under `## How to play`, give the goal, controls and tips in up to four short paragraphs (~120 words total). Create it initially and update when the experience changes; avoid implementation jargon.
- `CHANGELOG.md`: add one section per turn, newest first: a heading (≤6 words), then one sentence (≤30 words) about the visible change. Keep previous entries.

## Research and assets

Use documentation/search when it improves the result. Context7 queries must concern public APIs; installed types/compiler results take precedence over mismatched documentation. Continue with local references if research tools are unavailable.

Download reusable media with `asset_download` into `site/assets/`; avoid hotlinks/base64 and invented licenses or facts. Supply provenance/license notes when known. Extract archives in place and remove the archive; keep assets within the project's size budget.

Files the user attached in Discord arrive under `scratch/uploads/`, named in the request. That directory never publishes: read reference material in place, and install files the project should use (sprites, audio, fonts, data) into `site/assets/` with `asset_import`. Remove consumed uploads from `scratch/uploads/` when the files are installed or the reference is no longer needed.
