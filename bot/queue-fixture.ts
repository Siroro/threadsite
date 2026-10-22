/**
 * Throwaway concurrency fixture for the per-thread queue behind every Discord
 * turn: FIFO ordering, severQueue's head-only release (a hard reset must not
 * stampede N concurrent turns onto one worktree), the post-sever tail rebase
 * (work sent after a reset must not wait on the abandoned holder), and the
 * store's persisted pendingTurn identity the ownership guards rely on.
 * Run with:
 *   DISCORD_BOT_TOKEN=x DISCORD_APPLICATION_ID=x LOG_FILE=<tmp> npx tsx queue-fixture.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// config.ts validates these at import; the queue paths under test never touch
// Discord or the network, so placeholders are enough. Set before the dynamic
// imports below so module initialization sees them.
process.env.DISCORD_BOT_TOKEN ||= "fixture";
process.env.DISCORD_APPLICATION_ID ||= "fixture";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "threadsite-queue-"));
process.env.LOG_FILE ||= path.join(tmp, "fixture.log");
process.env.STATE_DB_FILE ||= path.join(tmp, "state.db");

const { ProjectService } = await import("./src/project.js");
const { Store, pendingTurnMatches } = await import("./src/store.js");
const { OpenCodeHarness } = await import("./src/opencode.js");
const { ForgejoClient } = await import("./src/forgejo.js");
const { UsageLog } = await import("./src/usage.js");

const store = await Store.open(path.join(tmp, "state.db"));
const service = new ProjectService(store, new OpenCodeHarness(), new ForgejoClient(), new UsageLog(path.join(tmp, "usage.jsonl")));
const queues = () => (service as unknown as { queues: Map<string, unknown> }).queues;
const sever = (threadId: string) => (service as unknown as { severQueue: (id: string) => void }).severQueue(threadId);

// --- 1. FIFO ordering without any sever ------------------------------------
{
  const events: string[] = [];
  const gates = [deferred(), deferred(), deferred()];
  for (const i of [0, 1, 2]) {
    void service.enqueue("t-fifo", async () => {
      events.push(`s${i}`);
      await gates[i].promise;
      events.push(`e${i}`);
    });
  }
  await sleep(50);
  check("FIFO: only the first item runs", events.join(",") === "s0", events.join(","));
  gates[0].resolve();
  await sleep(50);
  check("FIFO: second starts after first settles", events.join(",") === "s0,e0,s1", events.join(","));
  gates[1].resolve();
  gates[2].resolve();
  await sleep(50);
  check("FIFO: all items completed in order", events.join(",") === "s0,e0,s1,e1,s2,e2", events.join(","));
  check("FIFO: queue map drains to empty", queues().size === 0);
}

// --- 2. severQueue releases ONLY the head waiter -----------------------------
// The abandoned holder keeps running detached; the first waiter proceeds
// concurrently with it, but everything behind stays serialized — releasing
// every waiter at once would run N mutate pipelines on one worktree.
{
  const events: string[] = [];
  const holder = deferred();
  const w1 = deferred();
  const w2 = deferred();
  void service.enqueue("t-sever", async () => { events.push("sA"); await holder.promise; events.push("eA"); });
  void service.enqueue("t-sever", async () => { events.push("sW1"); await w1.promise; events.push("eW1"); });
  void service.enqueue("t-sever", async () => { events.push("sW2"); await w2.promise; events.push("eW2"); });
  await sleep(50);
  check("sever: waiters park behind the holder", events.join(",") === "sA", events.join(","));

  sever("t-sever");
  await sleep(50);
  check("sever: exactly the head waiter is released", events.join(",") === "sA,sW1", events.join(","));

  w1.resolve();
  await sleep(50);
  check("sever: second waiter runs after the released head settles", events.join(",") === "sA,sW1,eW1,sW2", events.join(","));

  w2.resolve();
  holder.resolve();
  await sleep(50);
  check("sever: abandoned holder completes detached", events.join(",") === "sA,sW1,eW1,sW2,eW2,eA", events.join(","));
  check("sever: queue map drains to empty", queues().size === 0);
}

// --- 3. Work enqueued AFTER a sever must not wait on the abandoned holder ----
{
  const stuck = deferred();
  void service.enqueue("t-post", async () => { await stuck.promise; });
  await sleep(50);

  sever("t-post"); // no waiters: the tail itself is the abandoned holder
  let firstStarted = false;
  const firstGate = deferred();
  void service.enqueue("t-post", async () => { firstStarted = true; await firstGate.promise; });
  await sleep(50);
  check("post-sever: new work starts without the abandoned holder", firstStarted);

  let secondStarted = false;
  void service.enqueue("t-post", async () => { secondStarted = true; });
  await sleep(50);
  check("post-sever: later work stays serialized behind it", !secondStarted);

  firstGate.resolve();
  await sleep(50);
  check("post-sever: serialization resolves normally", secondStarted);

  stuck.resolve();
  await sleep(50);
  check("post-sever: queue map drains to empty", queues().size === 0);
}

// --- 4. pendingTurn reference stability (ownership-guard assumption) ---------
{
  const base = {
    threadId: "t-store",
    guildId: "g",
    parentChannelId: "c",
    displayName: "Fixture",
    workspacePath: path.join(tmp, "ws"),
    siteSlug: "fixture",
    repoName: "site-fixture",
    sessionId: "s1",
    status: "ready" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await store.putProject(base);
  const marker = { prompt: "p", initial: false, startedAt: new Date().toISOString() };
  await store.patchProject("t-store", { pendingTurn: marker });
  await store.patchProject("t-store", { status: "error", lastError: "unrelated patch" });
  check("store: unrelated patches preserve turn identity", pendingTurnMatches(store.getProject("t-store")?.pendingTurn, marker));
  await store.patchProject("t-store", { pendingTurn: undefined });
  check("store: owning patch clears the marker", store.getProject("t-store")?.pendingTurn === undefined);
}

// --- 5. A failed provider-catalog fetch is not cached for the TTL ------------
{
  const harness = new OpenCodeHarness();
  const catalog = () => (harness as unknown as { providerCatalog?: unknown }).providerCatalog;
  const first = await Promise.race([
    (harness as unknown as { providerList: () => Promise<unknown[]> }).providerList(),
    sleep(8_000).then(() => ["timeout"] as unknown[]),
  ]);
  check("catalog: unreachable service resolves empty", Array.isArray(first) && first.length === 0);
  await sleep(50);
  check("catalog: the failed fetch is not pinned for the TTL", catalog() === undefined);
}

console.log(`\n${failed === 0 ? "✅" : "❌"} queue fixture: ${passed} passed, ${failed} failed`);
store.close();
await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
process.exit(failed === 0 ? 0 : 1);
