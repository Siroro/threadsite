import {
  GALLERY_DEFAULTS, gallerySelection, galleryUrl, publicGalleryUrl, readGalleryState, readSaved, readVisits,
  type GalleryProject, type GalleryState, type VisitHistory,
} from "./gallery-model.js";
import { galleryCard, galleryCover, galleryDate, galleryIcon, GALLERY_KINDS, GALLERY_MODES } from "./gallery-view.js";

const SAVED_KEY = "threadsite-gallery-saved-v1";
const VISITS_KEY = "threadsite-gallery-visits-v1";
const VIEW_KEY = "threadsite-gallery-view-v1";
const THEME_KEY = "threadsite-gallery-theme-v1";

function startGallery(): void {
  const payload = JSON.parse(document.getElementById("gallery-data")?.textContent ?? "null") as { version: number; projects: GalleryProject[] } | null;
  if (payload?.version !== 1 || !Array.isArray(payload.projects)) return;
  const projects = payload.projects.filter((project) => /^[a-f0-9]{20}$/.test(project.id) && publicGalleryUrl(project.url));
  const byId = new Map(projects.map((project) => [project.id, project]));
  const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const load = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
  const store = (key: string, value: string): boolean => { try { localStorage.setItem(key, value); return true; } catch { return false; } };
  let saved = readSaved(load(SAVED_KEY));
  let visits: VisitHistory = readVisits(load(VISITS_KEY));
  let state = readGalleryState(new URLSearchParams(location.search));
  if (!new URLSearchParams(location.search).has("view") && load(VIEW_KEY) === "list") state.view = "list";
  let currentProject: string | null = null;
  let opener: HTMLElement | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const search = element<HTMLInputElement>("gallery-search");
  const grid = element("project-grid");
  const projectDialog = element<HTMLDialogElement>("project-dialog");
  const aboutDialog = element<HTMLDialogElement>("about-dialog");
  const shareDialog = element<HTMLDialogElement>("share-dialog");

  function enhance(root: ParentNode = document): void { root.querySelectorAll<HTMLElement>("[data-enhance]").forEach((control) => { control.hidden = false; }); }
  function notify(text: string): void {
    const toast = element("toast");
    (document.querySelector("dialog[open]") ?? document.body).append(toast);
    toast.textContent = text; toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
  }
  function updateUrl(push = false, project: string | null = currentProject): void {
    const url = galleryUrl(new URL(location.href), state, project);
    if (url.href !== location.href) history[push ? "pushState" : "replaceState"](null, "", url);
  }
  function change(patch: Partial<GalleryState>, push = true): void {
    state = { ...state, ...patch, page: patch.page ?? 1 };
    if (patch.type === "site") state.mode = "all";
    if (patch.view) store(VIEW_KEY, patch.view);
    render(); updateUrl(push);
  }
  function applyTheme(theme: string): void {
    const light = theme === "light";
    document.documentElement.dataset.theme = light ? "light" : "dark";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", light ? "#f5f6f1" : "#101319");
    document.querySelector('[data-action="theme"]')?.setAttribute("aria-label", light ? "Switch to dark theme" : "Switch to light theme");
  }
  function render(): void {
    const result = gallerySelection(projects, state, saved, visits);
    state.page = result.page;
    grid.dataset.view = state.view;
    grid.innerHTML = result.visible.map((project) => galleryCard(project, saved.has(project.id), Boolean(visits[project.id]))).join("");
    enhance(grid);
    search.value = state.q;
    element<HTMLSelectElement>("mode-filter").value = state.mode;
    element<HTMLSelectElement>("mode-filter").disabled = state.type === "site";
    const sortOrder = element<HTMLSelectElement>("sort-order");
    sortOrder.querySelector<HTMLOptionElement>('option[value="updated"]')!.textContent = state.collection === "recent" ? "Recently opened" : "Recently updated";
    sortOrder.value = state.collection === "recent" ? "updated" : state.sort;
    sortOrder.disabled = state.collection === "recent";
    const isFiltered = Boolean(state.q || state.type !== "all" || state.mode !== "all");
    element("hero").hidden = isFiltered || state.collection !== "all";
    element("collection-title").textContent = state.collection === "saved" ? "Saved for a good day." : state.collection === "recent" ? "Back for another look." : state.type === "games" ? "Press play. Get lost." : state.type === "site" ? "Little corners of the web." : "Explore the collection.";
    element("collection-eyebrow").textContent = state.collection === "saved" ? "YOUR FAVOURITES, ALL IN ONE PLACE" : state.collection === "recent" ? "RECENTLY OPENED IN THIS BROWSER" : "FIND YOUR NEXT OBSESSION";
    element("result-count").textContent = `${result.visible.length} of ${result.total} project${result.total === 1 ? "" : "s"}${state.q ? ` matching “${state.q}”` : ""}`;
    document.querySelectorAll<HTMLElement>('[data-action="reset"]').forEach((button) => { button.hidden = button.closest(".results-toolbar") ? !isFiltered : false; });
    document.querySelector<HTMLElement>('[data-action="clear-search"]')!.hidden = !state.q;
    document.querySelectorAll<HTMLButtonElement>("[data-type]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.type === state.type)));
    document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.view === state.view)));
    document.querySelectorAll<HTMLButtonElement>("[data-nav]").forEach((button) => button.setAttribute("aria-pressed", String(state.collection === "all" && (button.dataset.nav === state.type || button.dataset.nav === "games" && state.type.startsWith("game-")))));
    document.querySelectorAll<HTMLButtonElement>("[data-collection]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.collection === state.collection)));
    document.querySelector('[data-count="saved"]')!.textContent = String(projects.filter((project) => saved.has(project.id)).length);
    document.querySelector('[data-count="recent"]')!.textContent = String(projects.filter((project) => visits[project.id]).length);
    document.querySelectorAll<HTMLButtonElement>('[data-action="surprise"]').forEach((button) => { button.disabled = !result.total; });
    element("empty-state").hidden = result.total !== 0;
    element("load-more").hidden = result.page >= result.pages;
    element("shown-count").textContent = `You've explored ${result.visible.length} of ${result.total} projects`;
    if (!projects.length) {
      element("empty-title").textContent = "A blank canvas. For now.";
      element("empty-description").textContent = "The first published project will start the collection.";
    } else if (state.collection === "saved" && !isFiltered) {
      element("empty-title").textContent = "Keep a little something for later.";
      element("empty-description").textContent = "Tap the heart on any project to find it here. Your collection stays in this browser.";
    } else if (state.collection === "recent" && !isFiltered) {
      element("empty-title").textContent = "Your next rabbit hole is out there.";
      element("empty-description").textContent = "Projects you open from the gallery will appear here, ready for another visit.";
    } else {
      element("empty-title").textContent = "Nothing down this rabbit hole. Yet.";
      element("empty-description").textContent = "Try a different search or clear the filters to see more projects.";
    }
  }
  function renderDetailSave(project: GalleryProject): void {
    const button = element<HTMLButtonElement>("detail-save");
    button.dataset.save = project.id;
    button.setAttribute("aria-pressed", String(saved.has(project.id)));
    button.innerHTML = `${galleryIcon("heart")} ${saved.has(project.id) ? "Saved" : "Save for later"}`;
    button.setAttribute("aria-label", `${saved.has(project.id) ? "Unsave" : "Save"} ${project.name}`);
  }
  function showProject(id: string, push = true): void {
    const project = byId.get(id);
    if (!project) { notify("This project is no longer in the collection."); return; }
    if (!projectDialog.open) opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    currentProject = id;
    element("detail-cover").innerHTML = galleryCover(project, true);
    element("detail-title").textContent = project.name;
    element("detail-pitch").textContent = project.pitch;
    element("detail-pitch").hidden = !project.pitch;
    const kinds = element("detail-kinds"); kinds.replaceChildren();
    for (const label of [GALLERY_KINDS[project.kind], project.mode ? GALLERY_MODES[project.mode] : "Website"]) {
      if (project.kind === "site" && kinds.childElementCount) continue;
      const badge = document.createElement("span"); badge.textContent = label; kinds.append(badge);
    }
    const launch = element<HTMLAnchorElement>("detail-launch");
    launch.href = project.url; launch.dataset.open = id;
    launch.setAttribute("aria-label", `${project.kind === "site" ? "Open" : "Play"} ${project.name} (opens in a new tab)`);
    launch.innerHTML = `${project.kind === "site" ? "Open website" : "Play game"} ${galleryIcon("arrow")}`;
    const source = element<HTMLAnchorElement>("detail-source");
    source.hidden = !project.source; if (project.source) source.href = project.source;
    renderDetailSave(project);
    element("detail-dates").textContent = `Created ${galleryDate(project.createdAt)} · Updated ${galleryDate(project.updatedAt)}`;
    element("play-heading").textContent = project.kind === "site" ? "How to use it" : "How to play";
    element("detail-play").textContent = project.play;
    element("play-section").hidden = !project.play;
    element("detail-change-title").textContent = project.changeTitle || "What's new";
    element("detail-change").textContent = project.change;
    element("change-section").hidden = !project.changeTitle && !project.change;
    if (!projectDialog.open) projectDialog.showModal();
    updateUrl(push, id);
  }
  async function copy(text: string): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("unavailable");
      await navigator.clipboard.writeText(text); notify("Copied. Pass it on.");
    } catch {
      element<HTMLInputElement>("share-link").value = text;
      if (!shareDialog.open) shareDialog.showModal();
      element<HTMLInputElement>("share-link").focus(); element<HTMLInputElement>("share-link").select();
    }
  }

  search.addEventListener("input", (event) => { if (!(event as InputEvent).isComposing) change({ q: search.value }, false); });
  search.addEventListener("compositionend", () => change({ q: search.value }, false));
  element<HTMLFormElement>("search-form").addEventListener("submit", (event) => event.preventDefault());
  element<HTMLSelectElement>("mode-filter").addEventListener("change", (event) => change({ mode: (event.target as HTMLSelectElement).value as GalleryState["mode"] }));
  element<HTMLSelectElement>("sort-order").addEventListener("change", (event) => change({ sort: (event.target as HTMLSelectElement).value as GalleryState["sort"] }));
  document.addEventListener("error", (event) => { if (event.target instanceof HTMLImageElement) event.target.hidden = true; }, true);
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const target = event.target.closest<HTMLElement>("[data-nav],[data-type],[data-collection],[data-view],[data-details],[data-save],[data-open],[data-copy],[data-action]");
    if (!target) return;
    if (target.dataset.open) {
      const id = target.dataset.open;
      visits = readVisits(JSON.stringify({ ...visits, [id]: Date.now() }));
      store(VISITS_KEY, JSON.stringify(visits));
      setTimeout(() => render(), 0);
      return; // Preserve native links, modifier keys and new-tab navigation.
    }
    if (target.dataset.save) {
      const id = target.dataset.save;
      if (!byId.has(id)) return;
      if (saved.has(id)) saved.delete(id); else saved.add(id);
      saved = new Set([...saved].slice(-2000));
      const persisted = store(SAVED_KEY, JSON.stringify([...saved]));
      render();
      if (currentProject) renderDetailSave(byId.get(currentProject)!);
      if (!persisted) notify("Saved for this visit. Browser storage is unavailable.");
      if (!projectDialog.open) (document.querySelector<HTMLElement>(`[data-save="${id}"]`) ?? search).focus({ preventScroll: true });
      return;
    }
    if (target.dataset.details) { showProject(target.dataset.details); return; }
    if (target.dataset.nav) { change({ type: target.dataset.nav as GalleryState["type"], collection: "all", mode: "all" }); window.scrollTo(0, 0); return; }
    if (target.dataset.type) { change({ type: target.dataset.type as GalleryState["type"] }); return; }
    if (target.dataset.collection) { change({ collection: target.dataset.collection as GalleryState["collection"], q: "", type: "all", mode: "all" }); window.scrollTo(0, 0); return; }
    if (target.dataset.view) { change({ view: target.dataset.view as GalleryState["view"], page: state.page }); return; }
    if (target.dataset.copy) { void copy(target.dataset.copy); return; }
    switch (target.dataset.action) {
      case "surprise": {
        const matches = gallerySelection(projects, state, saved, visits).matches;
        const project = matches[Math.floor(Math.random() * matches.length)];
        if (project) showProject(project.id);
        break;
      }
      case "reset": change({ ...GALLERY_DEFAULTS, view: state.view }); break;
      case "clear-search": change({ q: "" }, false); search.focus(); break;
      case "more": {
        const oldCount = grid.childElementCount;
        change({ page: state.page + 1 }, false);
        grid.children[oldCount]?.querySelector<HTMLElement>("a")?.focus();
        break;
      }
      case "theme": {
        const theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
        applyTheme(theme); store(THEME_KEY, theme); break;
      }
      case "about": aboutDialog.showModal(); break;
      case "close-about": aboutDialog.close(); break;
      case "close-project": projectDialog.close(); break;
      case "close-share": shareDialog.close(); break;
      case "share-gallery": void copy(galleryUrl(new URL(location.href), state, null).href); break;
      case "share-project": if (currentProject) void copy(galleryUrl(new URL(location.href), { ...GALLERY_DEFAULTS, view: state.view }, currentProject).href); break;
    }
  });
  projectDialog.addEventListener("close", () => {
    if (projectDialog.open) return;
    currentProject = null; updateUrl();
    if (opener?.isConnected) opener.focus({ preventScroll: true }); else search.focus({ preventScroll: true });
  });
  for (const dialog of [projectDialog, aboutDialog, shareDialog]) dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  window.addEventListener("popstate", () => {
    state = readGalleryState(new URLSearchParams(location.search)); render();
    const id = new URLSearchParams(location.search).get("project");
    if (id && byId.has(id)) showProject(id, false);
    else { currentProject = null; if (projectDialog.open) projectDialog.close(); }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === SAVED_KEY || event.key === VISITS_KEY || event.key === null) {
      saved = readSaved(load(SAVED_KEY)); visits = readVisits(load(VISITS_KEY)); render();
      if (currentProject) renderDetailSave(byId.get(currentProject)!);
    }
    if (event.key === THEME_KEY || event.key === null) applyTheme(load(THEME_KEY) ?? "dark");
  });
  document.addEventListener("keydown", (event) => {
    if (document.querySelector("dialog[open]")) return;
    const editing = event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName));
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" || event.key === "/" && !editing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); search.focus(); search.select();
    }
  });

  enhance(); applyTheme(load(THEME_KEY) ?? "dark"); render();
  const initialProject = new URLSearchParams(location.search).get("project");
  if (initialProject) showProject(initialProject, false);
  else updateUrl();
}

try { startGallery(); } catch (error) { console.error("[threadsite-gallery] Could not enable gallery tools; project links remain available.", error); }
