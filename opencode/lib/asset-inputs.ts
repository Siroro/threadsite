// Both asset tools accept the same destination and numeric inputs; share the
// validation so a rule fix cannot land in only one of them.

export function normalizeDestination(input: string): string {
  let value = input.trim().replaceAll("\\", "/");
  value = value.replace(/^\.?\/?site\/assets\//i, "").replace(/^\/?assets\//i, "");
  if (!value || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error("Destination must be a normal relative path below site/assets with no dot/path-traversal segments");
  }
  return value;
}

export function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
