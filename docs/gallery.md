# Public gallery

With `PUBLIC_INDEX_ENABLED=true`, ThreadSite refreshes the static gallery at `PUBLIC_SITES_BASE_URL` after publishing projects, renaming them or removing them. The gallery uses the deployment's existing hosting and requires no extra service, account or external asset host.

## Exploring projects

- Search across project names, descriptions, controls, project type and play style. Search ignores case and accents and combines multiple words.
- Browse all projects, games, websites, 2D games or 3D games. Game filters distinguish shared arenas, invite rooms and singleplayer.
- Sort by publication updates, creation date or name; switch between grid and list views. Longer collections load 12 cards at a time.
- Save favourites and revisit recently opened projects. These collections, layout and theme preferences stay in localStorage in the current browser. They are not public likes, user accounts or shared analytics. If storage is blocked, collections work for the current visit.
- Open project details for the larger screenshot, public description, how-to-play/use instructions and newest changelog entry. Play/Open launches the project in a new tab; Source opens its repository. Previews are screenshots, never embedded game scripts.
- Share the current search/filter combination or a direct link to project details. Project identifiers survive renames. Browser Back/Forward restores filter and detail state. Clipboard denial falls back to a selectable link.
- Use Random project to pick from the current filtered collection. The creation guide explains the existing Discord commands without inventing a separate creation service.

Search is available with `/` or Ctrl/⌘K. Detail dialogs support keyboard focus and Escape; layouts respond to mobile widths and reduced-motion preferences. All projects retain ordinary links when JavaScript is disabled.

## Publication and public data

`bot/src/publish.ts` builds an explicit public model, `gallery.ts` renders the page, `gallery-client.ts` handles browser interactions and `bot/assets/gallery.css` supplies the design. The browser bundle uses the existing esbuild dependency and is embedded in the page, with no new build command or production dependency. The bot Docker image already includes the required compiled modules and assets.

The public model contains only project names, kind/mode, links, dates, screenshots and the intended public `DESCRIPTION.md` / `CHANGELOG.md` content. It excludes original prompts, usage, collaborators, approval requests, workspace paths, sessions and private diagnostics. Documents must be regular files of at most 64 KiB; symlinks are rejected, and the exposed text is bounded. Names and document text remain text, including inside detail dialogs and the embedded JSON payload. Only HTTP(S) links without credentials are accepted.

Ready projects appear normally. An update failure does not remove a previously published site from the gallery: its live site and saved screenshot remain discoverable, while unpublished turn documents and diagnostics are omitted. Failed initial projects and pending deletions stay out. Update dates prefer the live `threadsite-version.json` timestamp, so collaboration/queue changes do not look like releases. Screenshot links include a version key to avoid stale thumbnails.

Gallery refreshes are serialized and the completed HTML replaces the index through an atomic rename. A failed refresh retains the prior gallery and does not block later refreshes. Gallery-owned assets remain under `__gallery`, preserving existing cleanup and rename behaviour.

## Checks

Use Node 24. From `bot/`, `npm test` exercises discovery state, URL round-trips, storage recovery, public-data isolation, document limits, renames and publication failure/recovery. `npm run build` checks the browser and server TypeScript together.

For real-browser checks, install the existing `preview/` dependencies and provide its Playwright Chromium browser. From `bot/`, run `npm run test:gallery`. The test launches an isolated local server with clearly labelled sample projects, exercises desktop/mobile interactions and never reads live workspaces or published sites. If Chromium is already installed elsewhere, set `GALLERY_BROWSER_EXECUTABLE_PATH` to its executable. Optional `GALLERY_SCREENSHOT_DIR` saves desktop, mobile and detail-view PNGs. These are development-only test settings, not production configuration.
