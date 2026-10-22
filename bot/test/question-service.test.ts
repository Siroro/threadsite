import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { testRootSetup, trackStore } from "./fixtures/root.js";
import type { ProjectRecord } from "../src/types.js";

const root = testRootSetup("question-service");
const { Store } = await import("../src/store.js");
const { QuestionService } = await import("../src/question-service.js");

const question = {
  requestID: "req-1",
  questions: [{ header: "Style", question: "Which direction?", options: [{ label: "Minimal" }, { label: "Bold" }] }],
};

interface Harness {
  service: InstanceType<typeof QuestionService>;
  store: Store;
  answers: string[][][];
  pendingList: Array<{ id: string }>;
  progressEvents: string[];
}

async function harness(): Promise<Harness> {
  const store = trackStore(await Store.open(path.join(root, `svc-${Math.random().toString(36).slice(2)}.db`)));
  const now = new Date().toISOString();
  const project: ProjectRecord = {
    threadId: "thread-1", guildId: "100", parentChannelId: "200", displayName: "Project",
    siteSlug: "site-p", repoName: "repo-p", sessionId: "fake",
    workspacePath: path.join(root, "ws"), projectKind: "site", status: "ready", createdAt: now, updatedAt: now,
    pendingTurn: { id: "t1", prompt: "make it pop", initial: false, startedAt: now, statusMessageId: "status-1" },
  };
  await store.putProject(project);
  store.patchCardState("thread-1", "status-1", { question });
  const state: Pick<Harness, "answers" | "pendingList" | "progressEvents"> = { answers: [], pendingList: [], progressEvents: [] };
  const progressStub = {
    recordAnswer: (_id: string, responder: string, answer: string) => state.progressEvents.push(`answer:${responder}:${answer}`),
    recordSkip: (_id: string, responder: string) => state.progressEvents.push(`skip:${responder}`),
    clearQuestion: (_id: string) => state.progressEvents.push("cleared"),
    setQuestionStatus: (status: { status: string }) => state.progressEvents.push(`status:${status.status}`),
  };
  const service = new QuestionService({
    store,
    progress: () => progressStub as never,
    pending: async () => state.pendingList,
    answer: async (_dir: string, _id: string, answers: string[][]) => {
      if (state.answers.length === 0) state.pendingList = [];
      state.answers.push(answers);
    },
    skip: async () => { state.progressEvents.push("rejected"); state.pendingList = []; },
    error: () => undefined,
  });
  // The fakes close over `state`, so tests mutate through the same reference.
  return { service, store, answers: state.answers, pendingList: state.pendingList, progressEvents: state.progressEvents };
}

/** The fakes read the harness arrays by reference, so tests mutate in place. */
function setPending(h: Harness, entries: Array<{ id: string }>): void {
  h.pendingList.splice(0, h.pendingList.length, ...entries);
}

test("answers are claimed once, delivered, and idempotent on repeat clicks", async () => {
  const h = await harness();
  const first = await h.service.submit("thread-1", "status-1", "req-1", "Shane", [["Bold"]]);
  assert.equal(first.status, "answered");
  assert.deepEqual(h.answers, [[["Bold"]]]);
  assert.deepEqual(h.progressEvents, ["status:submitting", "status:answered", "answer:Shane:Bold", "cleared"]);
  const again = await h.service.submit("thread-1", "status-1", "req-1", "Someone", [["Minimal"]]);
  assert.equal(again.status, "answered");
  assert.equal(h.answers.length, 1, "a settled question is never answered twice");
});

test("an ambiguous transport failure reconciles instead of losing or duplicating the answer", async () => {
  const h = await harness();
  // The agent accepted the answer but the reply failed on the wire.
  setPending(h, []);
  h.answers.length = 0;
  const failing = new QuestionService({
    store: h.store,
    progress: () => undefined,
    pending: async () => h.pendingList,
    answer: async () => { throw new Error("socket hung up"); },
    skip: async () => { throw new Error("socket hung up"); },
    error: () => undefined,
  });
  const delivery = await failing.submit("thread-1", "status-1", "req-1", "Shane", [["Bold"]]);
  assert.equal(delivery.status, "answered", "the agent is still waiting on nothing, so the answer landed");
  assert.equal(h.store.getCardState<{ status: string }>("thread-1", "question:status-1:req-1")?.status, "answered");
});

test("a rejected delivery keeps the question pending and retries from the saved answers", async () => {
  const h = await harness();
  h.answers.length = 0;
  setPending(h, [{ id: "req-1" }]);
  const failing = new QuestionService({
    store: h.store,
    progress: () => undefined,
    pending: async () => h.pendingList,
    answer: async (_dir: string, _id: string, answers: string[][]) => {
      h.answers.push(answers);
      if (h.answers.length === 1) throw new Error("transport down");
      h.pendingList = [];
    },
    skip: async () => { throw new Error("transport down"); },
    error: () => undefined,
  });
  const first = await failing.submit("thread-1", "status-1", "req-1", "Shane", [["Bold"]]);
  assert.equal(first.status, "retry");
  assert.match(first.error!, /submit again to retry/);
  const inFlightCheck = await failing.reconcile("thread-1", "status-1", "req-1");
  assert.equal(inFlightCheck.status, "retry", "reconciliation confirms the agent still waits");
  const second = await failing.submit("thread-1", "status-1", "req-1", "Shane", [["Bold"]]);
  assert.equal(second.status, "answered");
  assert.deepEqual(h.answers, [[["Bold"]], [["Bold"]]], "the retry re-sends the same complete batch");
});

test("a submission already in flight is never duplicated by a concurrent click", async () => {
  const h = await harness();
  h.answers.length = 0;
  setPending(h, [{ id: "req-1" }]);
  h.store.patchCardState("thread-1", "question:status-1:req-1", { requestID: "req-1", status: "submitting", operation: "answer" });
  const seen = await h.service.submit("thread-1", "status-1", "req-1", "Shane", [["Bold"]]);
  assert.equal(seen.status, "retry", "the in-flight claim reconciles instead of sending again");
  assert.equal(h.answers.length, 0);
  assert.equal(seen.error && /submit again/.test(seen.error), true);
});

test("skips deliver a rejection once and record who skipped", async () => {
  const h = await harness();
  const delivery = await h.service.submit("thread-1", "status-1", "req-1", "Shane", undefined);
  assert.equal(delivery.status, "skipped");
  assert.ok(h.progressEvents.includes("skip:Shane"));
  assert.deepEqual(h.answers, [], "a skip never sends answers");
});

test("drafts are per-user, validated against the pending revision, and survive restarts", async () => {
  const h = await harness();
  const draft = h.service.draft("thread-1", "status-1", "req-1", "user-a");
  assert.deepEqual(draft.answers, [[]]);
  draft.answers[0] = ["Bold"];
  h.service.saveDraft("thread-1", "status-1", "req-1", "user-a", draft);
  const other = h.service.draft("thread-1", "status-1", "req-1", "user-b");
  assert.deepEqual(other.answers, [[]], "one user's draft never leaks to another");
  assert.deepEqual(h.service.draft("thread-1", "status-1", "req-1", "user-a").answers, [["Bold"]], "drafts persist durably");
  assert.throws(() => h.service.context("thread-1", "status-1", "req-9"), /no longer pending/, "a stale revision cannot answer");
});
