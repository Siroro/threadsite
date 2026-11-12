import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { testRecord, testRootSetup, trackStore } from "./fixtures/root.js";

const root = testRootSetup("external-push");
const { Store } = await import("../src/store.js");
const { createExternalPushMonitor } = await import("../src/external-push.js");
let serial = 0;

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const id = String(++serial);
  const store = trackStore(await Store.open(path.join(root, `${id}.sqlite`)));
  const project = testRecord(id, path.join(root, id), { repoName: `repo-${id}` });
  await store.putProject(project);
  const sent: unknown[] = [];
  const channel = { isTextBased: () => true, send: async (message: unknown) => control.send(message) };
  const control = {
    sha: "a".repeat(40) as string | undefined,
    head: async (): Promise<string | undefined> => control.sha,
    busy: async (): Promise<boolean> => false,
    fetch: async (): Promise<typeof channel> => channel,
    send: async (message: unknown): Promise<void> => { sent.push(message); },
  };
  const monitor = createExternalPushMonitor({
    store, webhooksLive: () => true,
    forgejo: { mainCommitSha: async () => control.head() } as never,
    projects: { agentBusy: async () => control.busy() } as never,
    client: { channels: { fetch: async () => control.fetch() } } as never,
  });
  return { project, store, monitor, control, sent };
}

test("overlapping checks cannot redeliver a commit after its first notification finishes", async () => {
  const { project, store, monitor, control, sent } = await fixture();
  const firstBusy = gate();
  const secondBusy = gate();
  const entered = gate();
  let calls = 0;
  control.busy = async () => {
    calls++;
    entered.resolve();
    await (calls === 1 ? firstBusy.promise : secondBusy.promise);
    return false;
  };
  const first = monitor.recheck(project.threadId);
  await entered.promise;
  const second = monitor.recheck(project.threadId);
  firstBusy.resolve();
  await first;
  secondBusy.resolve();
  await second;
  assert.equal(sent.length, 1);
  assert.equal(store.getProject(project.threadId)!.lastSeenCommit, control.sha);
});

test("a turn that starts during the agent status check suppresses a notification", async () => {
  const { project, store, monitor, control, sent } = await fixture();
  const checking = gate();
  const release = gate();
  control.busy = async () => { checking.resolve(); await release.promise; return false; };
  const pending = monitor.recheck(project.threadId);
  await checking.promise;
  await store.patchProject(project.threadId, { pendingTurn: {
    id: "new-turn", initial: false, prompt: "update", startedAt: new Date().toISOString(), statusMessageId: "status-1",
  } });
  release.resolve();
  await pending;
  assert.equal(sent.length, 0);
  assert.equal(store.getProject(project.threadId)!.lastSeenCommit, undefined);
});

test("the latest bot commit is recognized after the agent status check", async () => {
  const { project, store, monitor, control, sent } = await fixture();
  const checking = gate();
  const release = gate();
  control.busy = async () => { checking.resolve(); await release.promise; return false; };
  const pending = monitor.recheck(project.threadId);
  await checking.promise;
  await store.patchProject(project.threadId, { lastCommit: control.sha!.slice(0, 10) });
  release.resolve();
  await pending;
  assert.equal(sent.length, 0);
  assert.equal(store.getProject(project.threadId)!.lastSeenCommit, control.sha);
});

test("a project removed during channel lookup never receives an obsolete prompt", async () => {
  const { project, store, monitor, control, sent } = await fixture();
  const checking = gate();
  const release = gate();
  const channel = await control.fetch();
  control.fetch = async () => { checking.resolve(); await release.promise; return channel; };
  const pending = monitor.recheck(project.threadId);
  await checking.promise;
  await store.deleteProject(project.threadId);
  release.resolve();
  await pending;
  assert.equal(sent.length, 0);
  assert.equal(store.getProject(project.threadId), undefined);
});

test("replayed webhook commits cannot move the notification marker behind main", async () => {
  const { project, store, monitor, control, sent } = await fixture();
  await monitor.recheck(project.threadId);
  await monitor.handleForgejoPush({ ref: "refs/heads/main", after: "b".repeat(40), repository: { name: project.repoName } });
  assert.equal(sent.length, 1);
  assert.equal(store.getProject(project.threadId)!.lastSeenCommit, control.sha);
});

test("a removed main branch produces no external-push notification", async () => {
  const { project, store, monitor, control, sent } = await fixture();
  control.sha = undefined;
  await monitor.handleForgejoPush({ ref: "refs/heads/main", after: "0".repeat(40), repository: { name: project.repoName } });
  assert.equal(sent.length, 0);
  assert.equal(store.getProject(project.threadId)!.lastSeenCommit, undefined);
});

test("failed notification delivery leaves the same commit eligible for retry", async () => {
  const { project, store, monitor, control, sent } = await fixture();
  const send = control.send;
  control.send = async () => { throw new Error("Discord unavailable"); };
  await monitor.recheck(project.threadId);
  assert.equal(store.getProject(project.threadId)!.lastSeenCommit, undefined);
  control.send = send;
  await monitor.recheck(project.threadId);
  assert.equal(sent.length, 1);
  assert.equal(store.getProject(project.threadId)!.lastSeenCommit, control.sha);
});

test("branch lookups cannot finish out of order and roll the notification marker backwards", async () => {
  const { project, store, monitor, control } = await fixture();
  const lookup = gate();
  const release = gate();
  let calls = 0;
  control.head = async () => {
    if (++calls === 1) { lookup.resolve(); await release.promise; return "a".repeat(40); }
    return "b".repeat(40);
  };
  const first = monitor.recheck(project.threadId);
  await lookup.promise;
  const second = monitor.recheck(project.threadId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(store.getProject(project.threadId)!.lastSeenCommit, "b".repeat(40));
});

test("a publication marker written during Discord delivery is preserved", async () => {
  const { project, store, monitor, control, sent } = await fixture();
  const sending = gate();
  const release = gate();
  const send = control.send;
  control.send = async (message) => { sending.resolve(); await release.promise; await send(message); };
  const pending = monitor.recheck(project.threadId);
  await sending.promise;
  const newer = "b".repeat(40);
  await store.patchProject(project.threadId, { lastCommit: newer.slice(0, 10), lastSeenCommit: newer });
  release.resolve();
  await pending;
  assert.equal(sent.length, 1);
  assert.equal(store.getProject(project.threadId)!.lastSeenCommit, newer);
});

test("the poller recovers after a transient project inventory failure", async (t) => {
  const { store, monitor, sent } = await fixture();
  let tick!: () => void;
  t.mock.method(globalThis, "setInterval", (callback: () => void) => {
    tick = callback;
    return { unref() {} } as ReturnType<typeof setInterval>;
  });
  const list = store.listProjects.bind(store);
  let fail = true;
  t.mock.method(store, "listProjects", () => {
    if (fail) throw new Error("Temporary SQLite read failure");
    return list();
  });
  monitor.startPoller();
  t.after(() => monitor.stopPoller());
  tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0);
  fail = false;
  tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
});
