# ThreadSite Project Rules

Maintained by the ThreadSite Discord harness. You author **TypeScript under `site/src/`**; when your reply ends the harness compiles and bundles it into static JavaScript under `site/js/`, validates, commits, and publishes `site/` to be served by Apache under an arbitrary path prefix.

## Boundaries

- Static browser deliverable only: HTML, CSS, bundled JS, JSON/data, fonts, media. No backend, server-side rendering, secrets, or build tooling of your own — **the harness runs the only build**; you never run builds or add build configuration.
- Edit only inside `site/` — TypeScript in `src/`, styles in `css/`, data in `data/`, media in `assets/`. Harness-owned (import, never edit): `site/net/` (net client + config + `.d.ts`), `node_modules/`, `AGENTS.md`, `README.md`, `ASSET_SOURCES.json`, `build-manifest.json`, `.opencode/`.
- `site/js/` is regenerated every turn — never hand-edit it; edit the `src/` module instead. TypeScript outside `site/src/` fails validation.
- Relative URLs only (the site is served under a path prefix). No dotfiles, symlinks, `package.json`/`tsconfig.json`, shell scripts, or git configuration.
- Git is read-only for you: `status`/`log`/`diff`/`show` and similar are fine for understanding history; writes are blocked and never needed — the harness owns commits, pushes, validation, rollback, and publication.

## How your TypeScript is built

- Each **top-level** `src/*.ts` is one bundle entry becoming `js/<name>.js`; `index.html` loads `js/main.js` by convention, and `<script src>` must reference compiled `js/*.js`, never a `.ts` source. Nested files (`src/game/player.ts`) are shared modules with no output of their own.
- Imports resolve like a normal bundler: `"./player.js"` (preferred) or `"./player"` finds the sibling `player.ts`. JSON imports are inlined; media imported from TypeScript emits hashed asset URLs. Prefer plain `<link>` stylesheets over CSS imports.
- Bare `"three"`/`"pixi.js"` resolve from the harness-managed `node_modules/` (gitignored, never published) — engine code reaches the browser only inside your bundle, tree-shaken to what you import. Both engines ship **full TypeScript types**: your editor and validation check engine usage against the real API, so wrong arguments and misspelled members fail the turn. Don't download second copies; addons fetched with `asset_download` into `site/assets/vendor/addons/` work when they import bare `"three"` — adapt `"three/addons/*"` subpaths.
- Fixed compiler flags (no tsconfig exists or is allowed): ES2022 + DOM libs, ES modules, lenient types — implicit `any` and unguarded DOM lookups are fine. Build failures (missing import, misspelled export, syntax damage) fail the turn with file:line and the offending source line — fix what they point at.

## Verification

Shell access is for checking your work: node one-liners, ls/cat/grep, prettier, unzip/tar (npm, curl, rm, and git writes are blocked). Keep scratch files in `/tmp` — the workspace is committed and `site/` is published.

- While editing: use `js_syntax_check` on files you change, and heed the attached language servers — they surface the same diagnostics the gate will.
- Before finishing, run the gate's own check yourself (it type-checks the whole import graph against the engines' and net client's real declarations):

      node /usr/local/lib/node_modules/typescript/bin/tsc --noEmit --allowJs --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM,DOM.Iterable --skipLibCheck site/src/*.ts

  Fix everything it reports — errors that reach the harness still get only one automatic repair round-trip.

## How your work ships

When your reply ends the harness restores harness-owned files, bundles `src/` → `js/` (pruning outputs of deleted sources), validates, commits the tree (authored by the requesting Discord user), and publishes it with cache-busting asset hashes. Type, build, or JavaScript errors get exactly **one** automatic repair round-trip; work that still fails is committed but not published — the live site keeps the last validated version and the next reply must fix it. Leave `site/` complete and directly openable over plain HTTP(S): no deferred work, no "run this first" steps, no server.

## Legacy JavaScript (only pre-TypeScript projects)

Hand-written `.js` under `site/js/` predates the switch. It still works, but on your next substantial change migrate it: move `js/<name>.js` to `src/<name>.ts` (the entry name and HTML reference don't change; delete the old file once its `.ts` exists) and update any `"../js/threadsite-net.js"` import to `"../net/threadsite-net.js"`. One renderer per page: the bundle or a legacy script, never both.

## Research and assets

- Use **websearch** when current information or real media would materially improve the result; don't search to appear busy. Verify facts rather than fabricating statistics, dates, or quotes.
- **asset_download** stores any public file under `site/assets/` — never hotlink search-result media. Prefer official/CC0/clearly-reusable sources; pass source/license notes when known and never invent licenses. Extract archives in place and delete the archive (everything under `site/` counts against the size budget); keep media lean and out of base64 blobs.

## Quality

The first viewport should communicate what the experience is. Visible hover/focus/loading/error states and feedback after actions; keyboard support and sensible touch behavior; `prefers-reduced-motion` for nonessential animation; semantic HTML, alt text, contrast; handle resizing; keep the console clean. Don't claim browser-testing you didn't do.
