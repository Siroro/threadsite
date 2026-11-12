// Both asset tools accept the same destination and numeric inputs; share the
// validation so a rule fix cannot land in only one of them.

export function normalizeDestination(input: string): string {
  let value = input.trim().replaceAll("\\", "/");
  value = value.replace(/^\.?\/?site\/assets\//i, "").replace(/^\/?assets\//i, "");
  validateRelativeSegments(value, "Destination must be a normal relative path below site/assets with no dot/path-traversal segments");
  return value;
}

/** The one rule every asset-tool path must satisfy: relative, no traversal, no dot segments. */
export function validateRelativeSegments(value: string, message: string): void {
  if (!value || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error(message);
  }
}

export function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
