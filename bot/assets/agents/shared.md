# ThreadSite Project Rules

Maintained by the ThreadSite harness. You author **TypeScript under `site/src/`**; when your reply ends the harness builds minified JavaScript under gitignored `site/js/`, validates it, commits authored source, and publishes only runtime files as plain static files under an arbitrary path prefix. `site/src/` and unbundled `site/net/` are never deployed.

## Boundaries

- Static browser deliverable only: HTML, CSS, bundled JS, JSON/data, fonts, media. No backend, server-side rendering, secrets, or build tooling of your own — **the harness runs the only build**; you never run builds or add build configuration.
- Author the deliverable inside `site/` — TypeScript in `src/`, styles in `css/`, data in `data/`, media in `assets/`. You may also edit `scratch/<name>/` for isolated browser views (see below). Harness-owned (import, never edit): `site/net/` (net client + config + `.d.ts`), `node_modules/`, `AGENTS.md`, `README.md`, `ASSET_SOURCES.json`, `build-manifest.json`, `.opencode/`.
- `site/js/` is regenerated every turn — never hand-edit it; edit the `src/` module instead. Within the deliverable, TypeScript outside `site/src/` fails validation. Scratch TypeScript belongs in `scratch/<name>/src/` and is compiled separately for preview only.
- Relative URLs only (the site is served under a path prefix). No dotfiles, symlinks, `package.json`/`tsconfig.json`, shell scripts, or git configuration.
- Git is read-only for you: `status`/`log`/`diff`/`show` and similar are fine for understanding history; writes are blocked and never needed — the harness owns commits, pushes, validation, rollback, and publication.

## Planning

- Before editing a request that needs multiple steps or changes across multiple files, call OpenCode's `todowrite` tool and create **3–6 concrete, checkable tasks**. A plan written only in prose does not count. Skip the todo tool only for a truly single-step change.
- The user watches this list live, so it must track reality: keep exactly one task `in_progress`, mark a task `completed` as soon as it is finished and promote the next one, and mark abandoned tasks `cancelled`. Do not leave finished work showing as pending.
- Before your final summary, update the list one last time so every finished task is `completed` and every dropped task is `cancelled`.
- When resuming an interrupted turn, call `todoread` first and continue the existing list — keep its task contents and update their statuses rather than replacing the list. If a multi-step turn has no list yet, create one before making further edits.
- A `[THREADSITE_FORCE_FINISH]` steering message means the current turn is nearing its configured step limit. Immediately finish the edits in progress, run the required checks, update the todos, and summarize. Stop optional exploration/features and browser retries; this message does not reset your budget. Leave coherent working behavior and disclose unfinished scope.

## How your TypeScript is built

- Each **top-level** `src/*.ts` is one bundle entry becoming `js/<name>.js`; `index.html` loads `js/main.js` by convention, and `<script src>` must reference compiled `js/*.js`, never a `.ts` source. Nested files (`src/game/player.ts`) are shared modules with no output of their own.
- Imports resolve like a normal bundler: `"./player.js"` (preferred) or `"./player"` finds the sibling `player.ts`. JSON imports are inlined; media imported from TypeScript emits hashed asset URLs. Prefer plain `<link>` stylesheets over CSS imports.
- Fixed compiler flags (no tsconfig exists or is allowed): ES2022 + DOM libs, ES modules, lenient types — implicit `any` and unguarded DOM lookups are fine. Build failures (missing import, misspelled export, syntax damage) fail the turn with file:line and the offending source line — fix what they point at.

## Verification

Shell access is for checking your work: node one-liners, ls/cat/grep, prettier, unzip/tar (npm, curl, rm, and git writes are blocked). Put browser experiments in `scratch/<name>/` using the edit tool; this workspace directory is gitignored and never published.

- While editing: use `js_syntax_check` on deliverable files you change under `site/`, and heed the attached language servers — they surface the same diagnostics the gate will. Scratch compilation diagnostics come from its preview page.
- **For models with image input, inspect the rendered result before finishing visual work.** Microsoft Playwright MCP is available as `playwright_browser_*` tools only to vision models. Text-only models receive no browser MCP tools: use source inspection, `js_syntax_check`, the required TypeScript check, and any harness-provided browser diagnostics; never claim visual inspection or try to bypass unavailable tools. The browser's preview URL is `http://127.0.0.1:8080/<guild-id>/<thread-id>/`, matching your workspace `/workspace/<guild-id>/<thread-id>` (inspect the working directory with `node -p "process.cwd()"` if needed). Navigate there: the preview service bundles the current TypeScript in memory, without writing `site/js/` or publishing anything. Reload/navigate again after every source edit; a build error is displayed on the page and must be fixed.
- When browser tools are available, use the screenshot tool to **see** the current viewport, inspect console errors and failed network requests, and correct visible layout/rendering problems. Inspect desktop and mobile sizes for websites. For games, get past the start screen, interact with keyboard/mouse, and inspect the actual canvas/WebGL scene; the vision tools support coordinate clicks. Take another screenshot after fixes. Screenshots require a model/provider advertising image input; choosing a text-only model does not give it vision or browser access.
- The preview browser is isolated, with fresh in-memory storage per MCP connection, and can reach only the local preview origin. Downloaded local assets work; external APIs, fonts, media and the multiplayer relay are unavailable, so test solo fallback and distinguish blocked external requests from missing local assets. Close the browser when inspection is complete. Screenshots and browser output stay in temporary storage and are never committed or published. Previewing does not replace the final validation gate or verify multiplayer.
- Before finishing, run the gate's own check yourself (it type-checks the whole import graph against the engines' and net client's real declarations):

      node /usr/local/lib/node_modules/typescript/bin/tsc --noEmit --allowJs --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM,DOM.Iterable --skipLibCheck site/src/*.ts

  Fix everything it reports — errors that reach the harness still get only one automatic repair round-trip.

## Scratch browser views

- Scratch browser inspection requires a vision model with browser MCP tools. Text-only models can edit scratch source but cannot render or inspect it through MCP; prioritize the deliverable and its static checks.
- Use a small isolated view to inspect a vehicle, character, material, lighting setup, sprite, UI component, or deterministic gameplay state without booting or controlling the whole game. Keep reusable factories/components in `site/src/`; import the component you need, not the full game's entry point. A broken unrelated game entry does not prevent scratch compilation.
- Create `scratch/<name>/index.html` and `scratch/<name>/src/main.ts` with the edit tool. Names are 1–64 letters/digits/hyphens/underscores, starting with a letter or digit. A minimal HTML shell is `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="js/main.js"></script></body></html>`. As in the main project, each top-level `src/*.ts` becomes a `js/*.js` bundle; nested modules are shared imports. Never create generated `js/` files yourself.
- From `scratch/car/src/main.ts`, import a shared factory with `import { createCar } from "../../../site/src/vehicles/car.js"` (adjust to the real export), and import installed engines by bare name, such as `"three"`. Set up only the required canvas/camera/lights or component mount, with a fixed seed/time and explicit ready flag when useful. Scratch imports can access this view, the project's `site/`, and its installed packages; other views/projects and root files remain outside the boundary.
- Navigate with `playwright_browser_navigate` to `http://127.0.0.1:8080/<guild-id>/<thread-id>/__scratch/<name>/`. It builds only that view's import graph in memory. Use the existing screenshot, evaluate, resize, keyboard/mouse and console/network tools to inspect it; reload after edits. Shared local assets/styles/data are mounted at `__site/assets/`, `__site/css/`, and `__site/data/` relative to the view URL, even if the full game cannot compile. Example: `new THREE.TextureLoader().load("__site/assets/car.png")`.
- Keep experiments in `scratch/`; move accepted behavior into `site/src/`. Scratch build errors and browser timeouts are diagnostics for that experiment and do not fail publication. The final site still needs its normal build/type checks and whole-experience browser inspection when available. Scratch files are retained locally for later iterations, excluded from Git and publication, and never required by the shipped game. The same browser isolation, image-model limitations, and close-browser guidance apply.

## How your work ships

When your reply ends the harness restores ignored build inputs, bundles/minifies `src/` → ignored `js/` (pruning stale outputs), validates, commits only authored files (authored by the requester), and publishes the runtime tree with cache-busting asset hashes.
Type, build, or JavaScript errors get exactly **one** automatic repair round-trip; work that still fails is committed but not published — the live site keeps the last validated version and the next reply must fix it.
Leave `site/` complete and directly openable over plain HTTP(S): no deferred work, no "run this first" steps, no server.

## Your two project documents

The harness shows these two files to everyone who opens the project, so keep them true and tiny. They live in the project root and are yours to write — you may edit them directly. In both, write every paragraph on a single line; never break a sentence across lines by hand.

- **`DESCRIPTION.md`** — what this project is, in a visitor's words. Keep it tiny: **one sentence of at most 25 words** under the title, and **one sentence of at most 20 words** under `## How to play` naming the goal — what the player is trying to do, and what winning looks like — not the controls and not a walkthrough. Written for a visitor, never for an engineer: no file names, no code, no APIs, no engine internals, no jargon. Update it whenever the project changes shape — a new mode, a new goal, a new kind of interaction — and leave it alone when only the internals moved.
- **`CHANGELOG.md`** — one section per turn, newest at the top. Before your final summary, add a section: a **heading of at most six words**, then **one sentence of at most 30 words** on what a visitor will notice — what changed for the player, not which file you edited. Keep the previous entries below it.


## Research and assets

- Use **websearch** when current information or real media would materially improve the result; don't search to appear busy. Verify facts rather than fabricating statistics, dates, or quotes.
- **asset_download** stores any public file under `site/assets/` — never hotlink search-result media. Prefer official/CC0/clearly-reusable sources; pass source/license notes when known and never invent licenses. Extract archives in place and delete the archive (everything under `site/` counts against the size budget); keep media lean and out of base64 blobs.

## Quality

The first viewport should communicate what the experience is. Visible hover/focus/loading/error states and feedback after actions; keyboard support and sensible touch behavior; `prefers-reduced-motion` for nonessential animation; semantic HTML, alt text, contrast; handle resizing; keep the console clean. Don't claim browser-testing you didn't do.

- **Your first frame is the one people see.** The harness photographs the page as it loads and shows that frame on the project card, so make the opening view worth looking at: the scene or content already rendered, lit and populated, never a black canvas, a loading spinner, a placeholder, an empty layout or a title screen that hides the work. Keep any loading state brief and make sure the finished frame is what remains.
