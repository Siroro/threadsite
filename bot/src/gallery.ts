import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { GalleryProject } from "./gallery-model.js";
import { escapeGallery as e, galleryCard, galleryCover, galleryIcon as icon, GALLERY_KINDS } from "./gallery-view.js";

let clientBundle: Promise<string> | undefined;
function galleryScript(): Promise<string> {
  if (!clientBundle) {
    const entry = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./gallery-client.ts" : "./gallery-client.js", import.meta.url));
    clientBundle = build({ entryPoints: [entry], bundle: true, write: false, minify: true, format: "iife", platform: "browser", target: "es2022", legalComments: "none" })
      .then((result) => result.outputFiles![0].text.replace(/<\/script/gi, "<\\/script"))
      .catch((error) => { clientBundle = undefined; throw error; });
  }
  return clientBundle;
}

export async function renderGallery(projects: GalleryProject[]): Promise<string> {
  const css = await fs.readFile(new URL("../assets/gallery.css", import.meta.url), "utf8");
  const script = await galleryScript();
  const games = projects.filter((project) => project.kind !== "site").length;
  const websites = projects.length - games;
  const spotlight = projects.find((project) => project.image && project.kind !== "site") ?? projects.find((project) => project.image) ?? projects[0];
  const data = JSON.stringify({ version: 1, projects }).replace(/[<>&\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const nav = (key: string, label: string, glyph: Parameters<typeof icon>[0], count: number, attribute = "nav") => `<button type="button" data-${attribute}="${key}" aria-pressed="${key === "all"}" class="nav-item">${icon(glyph)}<span>${label}</span><span class="nav-count" data-count="${key}">${count}</span></button>`;
  return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Discover browser games and websites built from Discord conversations. Play, explore and save your favourites in the ThreadSite collection.">
<meta name="theme-color" content="#101319"><meta name="color-scheme" content="dark light"><title>ThreadSite — a collection worth getting lost in</title>
<style>${css}</style></head><body>
<a class="skip-link" href="#collection">Skip to projects</a>
<aside class="sidebar" aria-label="Gallery navigation"><a class="brand" href="./" aria-label="ThreadSite home"><span class="brand-symbol">${icon("spark")}</span>ThreadSite</a>
<p class="brand-caption">ONE THREAD. ENDLESS POSSIBILITIES.</p>
<nav class="side-navigation" aria-label="Browse collections" data-enhance hidden><p class="nav-label">THE COLLECTION</p>
${nav("all", "Discover", "grid", projects.length)}${nav("games", "Games", "game", games)}${nav("site", "Websites", "globe", websites)}
<div class="nav-divider"></div><p class="nav-label">YOUR LITTLE CORNER</p>${nav("saved", "Saved for later", "heart", 0, "collection")}${nav("recent", "Recently opened", "clock", 0, "collection")}
<p class="local-note">Just for you. Kept in this browser.</p></nav>
<div class="sidebar-bottom"><div class="make-card"><span class="mini-spark">${icon("spark")}</span><strong>Got a weird little idea?</strong><p>A conversation is a good place to start.</p><button type="button" class="text-button" data-action="about" data-enhance hidden>Make something ${icon("right")}</button></div>
<span class="sidebar-signoff">Built from chat.<br>Made to be explored.</span></div></aside>
<div class="page"><header class="topbar"><span class="topbar-label"><span class="status-dot"></span>THE COMMUNITY COLLECTION</span><div class="topbar-actions" data-enhance hidden>
<button type="button" class="icon-button" data-action="share-gallery" aria-label="Copy a link to this collection" title="Share this collection">${icon("share")}</button>
<button type="button" class="icon-button" data-action="theme" aria-label="Switch to light theme" title="Switch colour theme">${icon("sun")}</button>
<button type="button" class="create-button" data-action="about">Create a project ${icon("arrow")}</button></div></header>
<main id="main"><section class="hero" id="hero" aria-labelledby="hero-title"><div class="hero-copy"><p class="eyebrow"><span class="eyebrow-line"></span>MADE IN A THREAD. READY TO EXPLORE.</p>
<h1 id="hero-title">Good ideas.<br><span>Great rabbit holes.</span></h1><p class="hero-description">Games to get lost in. Websites worth a click.<br class="desktop-break"> All built from a Discord conversation.</p>
<div class="hero-actions"><button type="button" class="primary-button" data-action="surprise" data-enhance hidden${projects.length ? "" : " disabled"}>${icon("dice")} Surprise me</button><a class="quiet-link" href="#collection">Explore the collection ${icon("right")}</a></div>
<div class="hero-stats"><span><strong>${projects.length}</strong> projects to explore</span><i></i><span><strong>${games}</strong> browser games</span><i></i><span><strong>${websites}</strong> websites</span></div></div>
${spotlight ? `<a class="spotlight ${spotlight.kind}" href="${e(spotlight.url)}" target="_blank" rel="noopener" data-open="${e(spotlight.id)}" aria-label="Open ${e(spotlight.name)} (opens in a new tab)"><div class="spotlight-visual">${galleryCover(spotlight, true)}<span class="spotlight-label">${icon("spark")} LATEST SPOTLIGHT</span><span class="spotlight-kind">${GALLERY_KINDS[spotlight.kind]}</span></div><div class="spotlight-footer"><div><span>FRESH FROM THE THREADS</span><h2>${e(spotlight.name)}</h2><p>${e(spotlight.pitch || "A new idea, ready for you to explore.")}</p></div><span class="spotlight-arrow">${icon("arrow")}</span></div></a>` : `<div class="first-project"><span>${icon("spark")}</span><h2>The next rabbit hole<br>starts with a conversation.</h2><p>Published projects will appear here.</p></div>`}
</section>
<section class="collection" id="collection" aria-labelledby="collection-title"><div class="section-heading"><div><p class="eyebrow" id="collection-eyebrow">FIND YOUR NEXT OBSESSION</p><h2 id="collection-title">Explore the collection<span class="heading-dot">.</span></h2></div><span class="collection-total">${projects.length} PROJECT${projects.length === 1 ? "" : "S"}, AND COUNTING</span></div>
<div class="discovery-tools" data-enhance hidden><div class="search-row"><form class="search-box" role="search" id="search-form">${icon("search")}<input id="gallery-search" name="q" type="search" maxlength="200" autocomplete="off" placeholder="Find your next rabbit hole…" aria-label="Search projects"><button type="button" class="icon-button clear-search" data-action="clear-search" aria-label="Clear search" hidden>${icon("close")}</button><kbd>/</kbd></form><button type="button" class="outline-button surprise-small" data-action="surprise">${icon("dice")} Surprise me</button></div>
<div class="filter-row"><div class="type-filters" role="group" aria-label="Project type"><button type="button" data-type="all" aria-pressed="true">All projects</button><button type="button" data-type="game-2d" aria-pressed="false">2D games</button><button type="button" data-type="game-3d" aria-pressed="false">3D games</button><button type="button" data-type="site" aria-pressed="false">Websites</button></div><label class="mode-filter"><span class="sr-only">Multiplayer mode</span><select id="mode-filter"><option value="all">Any play style</option><option value="arena">Shared arena</option><option value="rooms">Invite rooms</option><option value="singleplayer">Singleplayer</option></select></label></div>
<div class="results-toolbar"><p id="result-count" aria-live="polite" aria-atomic="true"></p><button type="button" class="reset-button" data-action="reset" hidden>Clear filters</button><div class="result-options"><label class="sort-label">Sort by <select id="sort-order"><option value="updated">Recently updated</option><option value="newest">Newest projects</option><option value="az">Name: A–Z</option><option value="za">Name: Z–A</option></select></label><div class="view-switch" role="group" aria-label="Project layout"><button type="button" class="icon-button" data-view="grid" aria-pressed="true" aria-label="Grid view">${icon("grid")}</button><button type="button" class="icon-button" data-view="list" aria-pressed="false" aria-label="List view">${icon("list")}</button></div></div></div></div>
<noscript><p class="notice">Search and saved projects need JavaScript. You can still open every project below.</p></noscript>
<div id="project-grid" class="project-grid">${projects.map((project) => galleryCard(project)).join("\n")}</div>
<div id="empty-state" class="empty-state"${projects.length ? " hidden" : ""}><span class="empty-icon">${icon("search")}</span><h3 id="empty-title">A blank canvas. For now.</h3><p id="empty-description">The first published project will start the collection.</p><button type="button" class="outline-button" data-action="reset" data-enhance hidden>Explore all projects ${icon("right")}</button></div>
<div class="load-more" id="load-more" hidden><p id="shown-count"></p><button type="button" class="outline-button" data-action="more">Show more projects ${icon("right")}</button></div>
</section><footer class="page-footer"><span class="footer-mark">${icon("spark")} A thread is just the beginning.</span><a href="#main">Back to top ↑</a><span>ThreadSite · built from chat</span></footer></main></div>
<dialog id="project-dialog" class="project-dialog" aria-labelledby="detail-title"><button type="button" class="dialog-close icon-button" data-action="close-project" aria-label="Close project details">${icon("close")}</button><div id="detail-cover" class="detail-cover"></div><div class="detail-body"><div class="detail-kinds" id="detail-kinds"></div><h2 id="detail-title"></h2><p id="detail-pitch"></p><div class="detail-actions"><a id="detail-launch" class="primary-button" target="_blank" rel="noopener"></a><button type="button" id="detail-save" class="outline-button"></button><button type="button" class="icon-button" data-action="share-project" aria-label="Copy a link to this project's details" title="Share project">${icon("share")}</button><a id="detail-source" class="outline-button" target="_blank" rel="noopener">${icon("code")} View source</a></div><p id="detail-dates" class="detail-dates"></p><section id="play-section" class="detail-section"><h3 id="play-heading">How to play</h3><p id="detail-play"></p></section><section id="change-section" class="detail-section"><p class="eyebrow">LATEST UPDATE</p><h3 id="detail-change-title"></h3><p id="detail-change"></p></section></div></dialog>
<dialog id="about-dialog" class="small-dialog" aria-labelledby="about-title"><button type="button" class="dialog-close icon-button" data-action="close-about" aria-label="Close project creation guide">${icon("close")}</button><span class="dialog-symbol">${icon("spark")}</span><p class="eyebrow">FROM AN IDEA TO A LITTLE PIECE OF THE INTERNET</p><h2 id="about-title">Your next project<br>starts in a thread.</h2><p>ThreadSite turns Discord conversations into persistent websites and browser games. Start a project in your ThreadSite Discord server, then talk in its thread to keep shaping it.</p><div class="command-card"><strong>Make a website</strong><code>/site start prompt: your idea</code><button type="button" class="text-button" data-copy="/site start prompt: your idea">Copy command ${icon("share")}</button></div><div class="command-card"><strong>Make a browser game</strong><code>/makegam dimension:2d prompt: your idea</code><button type="button" class="text-button" data-copy="/makegam dimension:2d prompt: your idea">Copy command ${icon("share")}</button></div><p class="small-note">Saved projects and recently opened projects stay in this browser. No account is needed to explore the collection.</p></dialog>
<dialog id="share-dialog" class="small-dialog share-dialog" aria-labelledby="share-title"><button type="button" class="dialog-close icon-button" data-action="close-share" aria-label="Close share link">${icon("close")}</button><h2 id="share-title">Here's your link.</h2><p>Copy this link to share it.</p><label class="sr-only" for="share-link">Link to copy</label><input id="share-link" type="text" readonly><p class="small-note">Use Ctrl+C or ⌘C to copy.</p></dialog>
<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
<script id="gallery-data" type="application/json">${data}</script><script>${script}</script></body></html>`;
}
