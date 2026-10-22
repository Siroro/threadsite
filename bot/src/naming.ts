import { cleanThreadTitle } from "./util.js";

export function projectName(raw: string): string | undefined {
  const cleaned = cleanThreadTitle(raw.replace(/[\u0000-\u001f\u007f]/g, " "));
  const name = cleaned && cleanThreadTitle(cleaned.replace(/^(?:(?:site|game)[-_])+/i, ""));
  if (!name || /^(?:sorry\b|i (?:cannot|can't|am unable)\b|here(?:'s| is)\b|title\s*:)/i.test(name)) return undefined;
  return name;
}

export function fallbackProjectName(request: string, kind = "site"): string {
  const words = request.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/^(?:(?:please|can you|could you|i want|i'd like|build|create|make|design|develop|implement|a|an|the|me)\b[\s,:-]*)+/i, "")
    .replace(/[^a-zA-Z0-9\s-]/g, " ").split(/[\s-]+/).filter(Boolean).slice(0, 6);
  return projectName(words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" "))
    ?? (kind === "site" ? "Untitled Project" : "Untitled Adventure");
}
