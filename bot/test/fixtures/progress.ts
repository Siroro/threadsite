import type { ProgressSnapshot } from "../../src/progress-view.js";

export function buildingSnapshot(): ProgressSnapshot {
  return {
    title: "🎮 Updating Sumo Shove", phase: "working", startedAt: 1_000_000, now: 1_134_000,
    latest: { text: "✏️ Editing code", detail: "site/src/player.ts", at: 1_129_000, key: "edit-player" },
    context: { request: "Make the arena feel more alive and add a proper leaderboard.", siteUrl: "https://sites.example.invalid/sumo-shove/", repoUrl: "https://git.example.invalid/site-sumo-shove" },
    thought: "The arena now has crowd reactions. I’m connecting the leaderboard to the shared match state.",
    files: { files: 6, added: 2, modified: 4, deleted: 0, additions: 184, deletions: 37, paths: ["site/src/player.ts", "site/src/leaderboard.ts", "site/css/main.css", "site/src/arena.ts", "site/index.html", "site/assets/crowd.svg"] },
    metrics: { contextTokens: 28400, contextLimit: 100000, inputTokens: 82300, outputTokens: 6200, cacheTokens: 65840, steps: 12, outputTokensPerSecond: 54 },
    plan: [
      { content: "Inspect the arena and multiplayer state", status: "completed" },
      { content: "Add crowd movement and impact feedback", status: "completed" },
      { content: "Connect the live leaderboard", status: "in_progress" },
      { content: "Test keyboard, touch controls and match reset", status: "pending" },
      { content: "Build, check and publish", status: "pending" },
    ],
    history: [
      { text: "📚 Project context inspected", detail: "site/src/arena.ts", at: 1_023_000 },
      { text: "✓ File edit complete", detail: "site/src/arena.ts", at: 1_059_000 },
      { text: "📸 Preview screenshot captured", at: 1_096_000 },
      { text: "✓ File edit complete", detail: "site/css/main.css", at: 1_122_000 },
    ],
    queuedRequests: 2, actions: 24, activeTools: 1, toolErrors: 0,
  };
}
