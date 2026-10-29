/** A reset always selects at least one kind of shared game state. */
export type ResetScope = { world: true; scores: boolean } | { world: false; scores: true };

/** Lifecycle conflicts are distinct from authentication, validation and storage failures. */
export class GameConflict extends Error {}
