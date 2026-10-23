import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { testRecord, testRootSetup } from "./fixtures/root.js";
import {
  GALLERY_DEFAULTS, gallerySelection, galleryUrl, readGalleryState, readSaved, readVisits, type GalleryProject,
} from "../src/gallery-model.js";

const root = testRootSetup("gallery");
process.env.PUBLIC_SITES_BASE_URL = "https://gallery.example.test/collection";
const { publishIndex } = await import("../src/publish.js");
const { config } = await import("../src/config.js");
const id = (index: number) => index.toString(16).padStart(20, "0");
const project = (index: number, patch: Partial<GalleryProject> = {}): GalleryProject => ({ id: id(index), name: `Project ${index}`, kind: "game-2d", mode: "arena",
  url: `https://gallery.example.test/${index}/`, source: null, image: null, pitch: "A little game", play: "Move with WASD", changeTitle: "", change: "",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: `2026-01-${String(index).padStart(2, "0")}T00:00:00Z`, ...patch,
});

test("gallery search combines words, accents, type and play-style filters without searching private metadata", () => {
  const projects = [project(1, { name: "Café Circuit", pitch: "A fast racing game", mode: "rooms" }), project(2, { name: "Circuit archive", kind: "site", mode: null }), project(3, { name: "Space Circuit", kind: "game-3d", mode: "singleplayer" })];
  const select = (patch: Partial<typeof GALLERY_DEFAULTS>) => gallerySelection(projects, { ...GALLERY_DEFAULTS, ...patch }, new Set(), {});
  assert.deepEqual(select({ q: "cafe racing" }).matches.map((p) => p.id), [id(1)]);
  assert.deepEqual(select({ type: "games", q: "circuit" }).matches.map((p) => p.id), [id(3), id(1)]);
  assert.deepEqual(select({ mode: "rooms", q: "WASD" }).matches.map((p) => p.id), [id(1)]);
  assert.deepEqual(select({ type: "site", mode: "arena" }).matches, []);
  assert.deepEqual(select({ type: "game-3d", q: "offline" }).matches.map((p) => p.id), [id(3)]);
});

test("saved and recent collections, stable sorting and load-more boundaries compose", () => {
  const projects = Array.from({ length: 27 }, (_, index) => project(index + 1));
  const initial = gallerySelection(projects, GALLERY_DEFAULTS, new Set(), {});
  assert.equal(initial.visible.length, 12);
  assert.equal(initial.total, 27);
  assert.equal(initial.visible[0].id, id(27));
  const more = gallerySelection(projects, { ...GALLERY_DEFAULTS, page: 2 }, new Set(), {});
  assert.equal(more.visible.length, 24);
  const last = gallerySelection(projects, { ...GALLERY_DEFAULTS, page: 999 }, new Set(), {});
  assert.equal(last.page, 3);
  assert.equal(last.visible.length, 27);
  const saved = gallerySelection(projects, { ...GALLERY_DEFAULTS, collection: "saved", sort: "az" }, new Set([id(2), id(10)]), {});
  assert.deepEqual(saved.matches.map((p) => p.id), [id(2), id(10)], "numeric name ordering keeps Project 2 ahead of Project 10");
  const recent = gallerySelection(projects, { ...GALLERY_DEFAULTS, collection: "recent" }, new Set(), { [id(1)]: 20, [id(2)]: 10 });
  assert.deepEqual(recent.matches.map((p) => p.id), [id(1), id(2)]);
  assert.deepEqual(gallerySelection(projects, { ...GALLERY_DEFAULTS, collection: "saved", q: "missing" }, new Set([id(2)]), {}).visible, []);
});

test("gallery URLs round-trip filters and details while rejecting invalid query state", () => {
  const state = { ...GALLERY_DEFAULTS, q: "space & light", mode: "rooms" as const, view: "list" as const, page: 2 };
  const url = galleryUrl(new URL("https://example.test/library/?campaign=one"), state, id(1));
  assert.equal(url.searchParams.get("campaign"), "one");
  assert.equal(url.searchParams.get("project"), id(1));
  assert.deepEqual(readGalleryState(url.searchParams), state);
  const cleared = galleryUrl(url, GALLERY_DEFAULTS, null);
  assert.equal(cleared.search, "?campaign=one");
  assert.deepEqual(readGalleryState(new URLSearchParams("type=unknown&mode=bad&sort=bad&view=bad&page=Infinity")), GALLERY_DEFAULTS);
  assert.equal(readGalleryState(new URLSearchParams({ q: "a".repeat(999), page: "-2" })).q.length, 200);
  assert.equal(readGalleryState(new URLSearchParams("page=-2")).page, 1);
});

test("corrupt or forged browser storage degrades to bounded local collections", () => {
  assert.equal(readSaved("not-json").size, 0);
  assert.deepEqual([...readSaved(JSON.stringify([id(1), "<script>", id(1), null]))], [id(1)]);
  assert.equal(readSaved(JSON.stringify(Array.from({ length: 2100 }, (_, index) => id(index)))).size, 2000);
  assert.deepEqual(readVisits(JSON.stringify({ [id(1)]: 123, [id(2)]: "456", "__proto__": 5, bad: 99 })), { [id(1)]: 123 });
  assert.deepEqual(readVisits("[]"), {});
});

function data(html: string): { projects: GalleryProject[] } {
  return JSON.parse(/<script id="gallery-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]);
}
test("publication exposes only public metadata, keeps published failed updates, and blocks document/script/URL injection", async () => {
  const workspace = path.join(root, "public-docs"); await fs.mkdir(workspace, { recursive: true });
  const attack = '</script><script>window.galleryInjected=true</script>';
  await fs.writeFile(path.join(workspace, "DESCRIPTION.md"), `# Project\n\n${attack}\n\n## How to play\n\nMove with WASD.`);
  await fs.writeFile(path.join(workspace, "CHANGELOG.md"), "# Changes\n\n## A new level\n\nExplore the garden.");
  const ready = testRecord("1111", workspace, { displayName: 'A <b>bold</b> project', siteSlug: "ready-game", projectKind: "game-2d", sessionId: "DO_NOT_PUBLISH_SESSION", initialPrompt: "DO_NOT_PUBLISH_PROMPT", ownerId: "DO_NOT_PUBLISH_OWNER" });
  const failed = testRecord("2222", workspace, { siteSlug: "still-live", status: "error", lastError: "DO_NOT_PUBLISH_ERROR" });
  const initialFailure = testRecord("3333", workspace, { siteSlug: "never-published", status: "error" });
  const removed = testRecord("4444", workspace, { siteSlug: "deleted", pendingDeletion: { requestedAt: "now", reason: "delete" } });
  await fs.mkdir(path.join(config.publishRoot, "still-live"), { recursive: true });
  await fs.writeFile(path.join(config.publishRoot, "still-live", "index.html"), "last good site");
  await publishIndex([ready, failed, initialFailure, removed], () => "javascript:alert(1)");
  const html = await fs.readFile(path.join(config.publishRoot, "index.html"), "utf8");
  const projects = data(html).projects;
  assert.equal(projects.length, 2);
  const game = projects.find((p) => p.kind === "game-2d")!;
  assert.equal(game.pitch, attack);
  assert.equal(game.play, "Move with WASD.");
  assert.equal(game.changeTitle, "A new level");
  assert.equal(game.source, null);
  assert.equal(projects.find((p) => p.url.includes("still-live"))!.pitch, "", "failed-turn docs are not presented as published changes");
  assert.doesNotMatch(html, /DO_NOT_PUBLISH_|<script>window\.galleryInjected|href="javascript:/);
  assert.ok(!html.includes(workspace));
});

test("gallery identity survives renames, rejects symlink/oversized documents, and uses actual publication dates", async (t) => {
  const workspace = path.join(root, "guarded-docs"); await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "DESCRIPTION.md"), "x".repeat(65 * 1024));
  const outside = path.join(root, "private.txt"); await fs.writeFile(outside, "DO_NOT_PUBLISH_PRIVATE_FILE");
  try { await fs.symlink(outside, path.join(workspace, "CHANGELOG.md")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; t.diagnostic("Windows disallowed the test symlink; oversized-document and rename checks still run."); }
  const original = testRecord("5555", workspace, { siteSlug: "before-rename", updatedAt: "2026-10-01T00:00:00.000Z" });
  await publishIndex([original], () => "https://git.example.test/repo");
  const before = data(await fs.readFile(path.join(config.publishRoot, "index.html"), "utf8")).projects[0];
  const renamed = { ...original, siteSlug: "after-rename", repoName: "after-rename" };
  await fs.mkdir(path.join(config.publishRoot, renamed.siteSlug), { recursive: true });
  await fs.writeFile(path.join(config.publishRoot, renamed.siteSlug, "threadsite-version.json"), JSON.stringify({ publishedAt: "2026-09-01T12:00:00.000Z" }));
  await publishIndex([renamed], () => "https://git.example.test/repo");
  const html = await fs.readFile(path.join(config.publishRoot, "index.html"), "utf8");
  const after = data(html).projects[0];
  assert.equal(after.id, before.id);
  assert.ok(after.url.includes("after-rename"));
  assert.equal(after.pitch, "");
  assert.equal(after.change, "");
  assert.equal(after.updatedAt, "2026-09-01T12:00:00.000Z");
  assert.ok(!html.includes("DO_NOT_PUBLISH_PRIVATE_FILE"));
});

test("concurrent gallery refreshes publish in order with no staging files left behind", async () => {
  const workspace = path.join(root, "empty-docs"); await fs.mkdir(workspace, { recursive: true });
  await Promise.all([
    publishIndex([testRecord("6666", workspace, { siteSlug: "first-snapshot" })], () => "https://git.example.test/repo"),
    publishIndex([testRecord("7777", workspace, { siteSlug: "last-snapshot" })], () => "https://git.example.test/repo"),
  ]);
  const result = data(await fs.readFile(path.join(config.publishRoot, "index.html"), "utf8"));
  assert.equal(result.projects.length, 1);
  assert.ok(result.projects[0].url.includes("last-snapshot"));
  assert.ok(!(await fs.readdir(path.join(config.publishRoot, "__gallery"))).some((name) => name.endsWith(".tmp")));
  await assert.rejects(publishIndex([testRecord("8888", workspace, { siteSlug: "failed-refresh" })], () => { throw new Error("source lookup failed"); }));
  assert.equal(data(await fs.readFile(path.join(config.publishRoot, "index.html"), "utf8")).projects[0].id, result.projects[0].id, "failed refresh retains the complete prior gallery");
  await publishIndex([], () => "https://git.example.test/repo");
  assert.equal(data(await fs.readFile(path.join(config.publishRoot, "index.html"), "utf8")).projects.length, 0, "a failed refresh cannot poison later publication");
});
