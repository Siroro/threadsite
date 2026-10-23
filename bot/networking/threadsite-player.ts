// Shared anonymous identity for gameplay networking and the standalone leaderboard client.
const cacheKey = Symbol.for("threadsite.player-tokens.v1");
const state = globalThis as typeof globalThis & { [cacheKey]?: Map<string, string> };
const temporaryTokens = state[cacheKey] ??= new Map<string, string>();

/** Private credential: never publish it, or use a public player ID as a credential. */
export function getPlayerIdentity(game: string, supplied?: string): { token: string | null; persistent: boolean } {
  if (supplied !== undefined) return { token: supplied, persistent: false };
  const key = `threadsite-player-v1:${game}`;
  try {
    const saved = localStorage.getItem(key);
    if (saved && /^[a-f0-9]{64}$/.test(saved)) return { token: saved, persistent: true };
  } catch { /* blocked storage uses the same page-lifetime identity in both clients */ }
  let token = temporaryTokens.get(game);
  if (!token) {
    try { token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
    catch { return { token: null, persistent: false }; }
    temporaryTokens.set(game, token);
  }
  try { localStorage.setItem(key, token); return { token, persistent: true }; }
  catch { return { token, persistent: false }; }
}
