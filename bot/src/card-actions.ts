/** Versioned, bounded IDs. Resources are Discord message/thread IDs; question IDs are revisions. */
export const CARD_ACTIONS = ["details", "tab", "page", "project", "queue", "cancel", "change", "steer", "request", "stop", "answer", "select", "questions", "form", "other", "custom", "skip", "review", "send", "retry", "doc", "rollback", "keep", "confirm", "wipe", "collaboration", "collabmode", "collabusers", "collabwipe", "approve", "reject", "reviewrequest"] as const;
export type CardAction = typeof CARD_ACTIONS[number];
export interface CardRoute { action: CardAction; resource: string; args: string[] }

export function cardId(action: CardAction, resource: string, ...args: Array<string | number>): string {
  const parts = ["ts2", action, resource, ...args.map(String)];
  if (parts.some((part) => !/^[a-zA-Z0-9_-]+$/.test(part))) throw new Error("Invalid card action identifier.");
  const id = parts.join(":");
  if (id.length > 100) throw new Error("Card action identifier is too long.");
  return id;
}

export function parseCardId(id: string): CardRoute | undefined {
  const [version, action, resource, ...args] = id.split(":");
  if (version !== "ts2" || id.length > 100 || !resource || !CARD_ACTIONS.includes(action as CardAction)
    || [resource, ...args].some((part) => !/^[a-zA-Z0-9_-]+$/.test(part))) return undefined;
  return { action: action as CardAction, resource, args };
}
