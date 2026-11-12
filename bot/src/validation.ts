/**
 * Validation failures the agent can repair in a follow-up round-trip.
 * build.ts and publish.ts throw this for bundle/syntax/type/reference
 * problems; everything else (missing index.html, blocked file types, size
 * caps, an unusable type-checker) stays a plain Error and commits unpublished
 * without a repair attempt. project.ts switches on this type — the error
 * wording is for the thread, never for the repair decision.
 */
export class RepairableValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepairableValidationError";
  }
}

export function repairable(message: string): RepairableValidationError {
  return new RepairableValidationError(message);
}
