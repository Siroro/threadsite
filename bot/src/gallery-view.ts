import { publicGalleryUrl, type GalleryProject } from "./gallery-model.js";

export function escapeGallery(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
const paths = {
  search: '<circle cx="10.8" cy="10.8" r="7.3"/><path d="m16 16 5 5"/>',
  arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
  right: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  list: '<path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1"/>',
  game: '<path d="M7 7h10a4 4 0 0 1 4 3l1 7c.4 3-2.5 4-4 2l-2-3H8l-2 3c-1.5 2-4.4 1-4-2l1-7a4 4 0 0 1 4-3Z"/><path d="M6 10v5m-2.5-2.5h5M16 11h.01M19 14h.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M7 7h.01M17 7h.01M12 12h.01M7 17h.01M17 17h.01"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16"/>',
  share: '<path d="M12 15V3m-4 4 4-4 4 4M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  spark: '<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
} as const;
export type GalleryIcon = keyof typeof paths;
export function galleryIcon(name: GalleryIcon): string { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`; }
export const GALLERY_KINDS = { site: "Website", "game-2d": "2D game", "game-3d": "3D game" } as const;
export const GALLERY_MODES = { arena: "Shared arena", rooms: "Invite rooms", singleplayer: "Singleplayer" } as const;

export function galleryDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "Recently added";
}
export function galleryCover(project: GalleryProject, eager = false): string {
  const image = project.image && publicGalleryUrl(project.image);
  return `<div class="cover-art ${project.kind}" aria-hidden="true"><div class="art-orbit"></div><div class="art-grid"></div>${galleryIcon(project.kind === "site" ? "globe" : "game")}<span>${project.kind === "site" ? "A SMALL CORNER OF THE INTERNET" : "YOUR NEXT SIDE QUEST"}</span></div>${image ? `<img src="${escapeGallery(image)}" alt="Screenshot of ${escapeGallery(project.name)}" width="800" height="450" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">` : ""}`;
}
export function galleryCard(project: GalleryProject, saved = false, visited = false): string {
  const url = publicGalleryUrl(project.url);
  if (!url) return "";
  const name = escapeGallery(project.name);
  const id = escapeGallery(project.id);
  const source = project.source && publicGalleryUrl(project.source);
  return `<article class="project-card ${project.kind}" data-project-id="${id}">
    <div class="card-visual"><a class="cover" href="${escapeGallery(url)}" target="_blank" rel="noopener" data-open="${id}" aria-label="${project.kind === "site" ? "Open" : "Play"} ${name} (opens in a new tab)">${galleryCover(project)}</a>
      <span class="kind-badge">${GALLERY_KINDS[project.kind]}</span><button type="button" class="save-button icon-button" data-save="${id}" aria-pressed="${saved}" aria-label="${saved ? "Unsave" : "Save"} ${name}" title="${saved ? "Remove from saved" : "Save for later"}" data-enhance hidden>${galleryIcon("heart")}</button>
    </div><div class="card-body"><div class="card-meta">${project.mode ? `<span class="mode-dot ${project.mode}">${GALLERY_MODES[project.mode]}</span>` : '<span>Made for the web</span>'}${visited ? '<span class="visited-mark">Opened before</span>' : ""}</div>
      <h3><a href="${escapeGallery(url)}" target="_blank" rel="noopener" data-open="${id}">${name}</a></h3>
      <p class="card-pitch">${escapeGallery(project.pitch || (project.kind === "site" ? "A little idea with a home on the internet. Open it and take a look." : "A browser game made to be played. Jump in and find your next favourite."))}</p>
      <div class="card-footer"><time datetime="${escapeGallery(project.updatedAt)}" title="Last updated ${escapeGallery(galleryDate(project.updatedAt))}">${galleryDate(project.updatedAt)}</time>
        <div class="card-actions">${source ? `<a class="source-link" href="${escapeGallery(source)}" target="_blank" rel="noopener" title="View source for ${name}" aria-label="View source for ${name} (opens in a new tab)">${galleryIcon("code")}</a>` : ""}<button type="button" class="details-button" data-details="${id}" aria-label="Details for ${name}" aria-haspopup="dialog" aria-controls="project-dialog" data-enhance hidden>Details ${galleryIcon("chevron")}</button><a class="card-launch" href="${escapeGallery(url)}" target="_blank" rel="noopener" data-open="${id}" aria-label="${project.kind === "site" ? "Open" : "Play"} ${name} (opens in a new tab)">${project.kind === "site" ? "Open" : "Play"} ${galleryIcon("arrow")}</a></div>
      </div></div></article>`;
}
