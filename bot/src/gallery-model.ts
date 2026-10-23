/** Public gallery data only. Never serialize a ProjectRecord into a page. */
export interface GalleryProject {
  id: string;
  name: string;
  kind: "site" | "game-2d" | "game-3d";
  mode: "arena" | "rooms" | "singleplayer" | null;
  url: string;
  source: string | null;
  image: string | null;
  pitch: string;
  play: string;
  changeTitle: string;
  change: string;
  createdAt: string;
  updatedAt: string;
}
export interface GalleryState {
  q: string;
  type: "all" | "games" | "site" | "game-2d" | "game-3d";
  mode: "all" | "arena" | "rooms" | "singleplayer";
  collection: "all" | "saved" | "recent";
  sort: "updated" | "newest" | "az" | "za";
  view: "grid" | "list";
  page: number;
}
export type VisitHistory = Record<string, number>;
export const GALLERY_PAGE_SIZE = 12;
export const GALLERY_DEFAULTS: GalleryState = { q: "", type: "all", mode: "all", collection: "all", sort: "updated", view: "grid", page: 1 };

export function readGalleryState(params: URLSearchParams): GalleryState {
  const value = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const raw = params.get(key);
    return allowed.includes(raw as T) ? raw as T : fallback;
  };
  const page = Number(params.get("page") ?? 1);
  return {
    q: (params.get("q") ?? "").slice(0, 200),
    type: value("type", ["all", "games", "site", "game-2d", "game-3d"], "all"),
    mode: value("mode", ["all", "arena", "rooms", "singleplayer"], "all"),
    collection: value("collection", ["all", "saved", "recent"], "all"),
    sort: value("sort", ["updated", "newest", "az", "za"], "updated"),
    view: value("view", ["grid", "list"], "grid"),
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(1000, page) : 1,
  };
}

/** Preserve unrelated URL parameters (e.g. campaign links). */
export function galleryUrl(url: URL, state: GalleryState, project?: string | null): URL {
  const next = new URL(url);
  for (const key of Object.keys(GALLERY_DEFAULTS) as (keyof GalleryState)[]) {
    if (state[key] === GALLERY_DEFAULTS[key]) next.searchParams.delete(key);
    else next.searchParams.set(key, String(state[key]));
  }
  if (project === null) next.searchParams.delete("project");
  else if (project) next.searchParams.set("project", project);
  return next;
}

function normalized(value: string): string { return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase(); }
const MODE_SEARCH = { arena: "arena multiplayer shared world", rooms: "rooms multiplayer invite friends", singleplayer: "singleplayer solo offline" };
export function gallerySelection(projects: readonly GalleryProject[], state: GalleryState, saved: ReadonlySet<string>, visits: VisitHistory) {
  const tokens = normalized(state.q).trim().split(/\s+/).filter(Boolean);
  const matches = projects.filter((project) => {
    if (state.type === "games" ? project.kind === "site" : state.type !== "all" && state.type !== project.kind) return false;
    if (state.mode !== "all" && project.mode !== state.mode) return false;
    if (state.collection === "saved" && !saved.has(project.id)) return false;
    if (state.collection === "recent" && !visits[project.id]) return false;
    const text = normalized(`${project.name} ${project.pitch} ${project.play} ${project.kind === "site" ? "website site" : project.kind === "game-2d" ? "2d game excalibur" : "3d game three.js"} ${project.mode ? MODE_SEARCH[project.mode] : ""}`);
    return tokens.every((token) => text.includes(token));
  });
  const timestamp = (value: string): number => Date.parse(value) || 0;
  matches.sort((a, b) => {
    if (state.collection === "recent") return (visits[b.id] ?? 0) - (visits[a.id] ?? 0) || a.id.localeCompare(b.id);
    if (state.sort === "az" || state.sort === "za") return (state.sort === "az" ? 1 : -1) * a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true }) || a.id.localeCompare(b.id);
    const field = state.sort === "newest" ? "createdAt" : "updatedAt";
    return timestamp(b[field]) - timestamp(a[field]) || a.id.localeCompare(b.id);
  });
  const pages = Math.max(1, Math.ceil(matches.length / GALLERY_PAGE_SIZE));
  const page = Math.min(pages, state.page);
  return { matches, visible: matches.slice(0, page * GALLERY_PAGE_SIZE), page, pages, total: matches.length };
}

export function readSaved(value: string | null): Set<string> {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && /^[a-f0-9]{20}$/.test(id)).slice(0, 2000) : []);
  } catch { return new Set(); }
}
export function readVisits(value: string | null): VisitHistory {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([id, time]) => /^[a-f0-9]{20}$/.test(id) && typeof time === "number" && Number.isFinite(time) && time > 0)
      .sort(([, a], [, b]) => Number(b) - Number(a)).slice(0, 100));
  } catch { return {}; }
}

export function publicGalleryUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
