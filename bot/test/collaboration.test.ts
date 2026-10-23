import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { PermissionFlagsBits, PermissionsBitField, type Attachment } from "discord.js";
import { testRecord, testRootSetup, trackStore } from "./fixtures/root.js";
import { assertV2 } from "./fixtures/cards.js";
import type { ProjectActor } from "../src/collaboration.js";
import type { ProjectApproval, ProjectRecord } from "../src/types.js";

const root = testRootSetup("collaboration");
const { Store } = await import("../src/store.js");
const { contributionAccess, authorizeCard, managesProject, requireContributor } = await import("../src/collaboration.js");
const { CollaborationService, installApprovedUploads, captureApprovalAttachments } = await import("../src/collaboration-service.js");
const { CardInteractions } = await import("../src/card-interactions.js");
const { cardId } = await import("../src/card-actions.js");
const owner: ProjectActor = { userId: "111111", admin: false, canSend: true };
const guest: ProjectActor = { userId: "222222", admin: false, canSend: true };
const editor: ProjectActor = { userId: "333333", admin: false, canSend: true };
let serial = 0;

async function fixture() {
  const id = String(900000 + ++serial);
  const file = path.join(root, `${id}.sqlite`);
  const store = trackStore(await Store.open(file));
  const project = testRecord(id, path.join(root, "workspaces", id), { ownerId: owner.userId, starterId: "444444" });
  await store.putProject(project);
  const calls = { prepared: 0, accepted: 0, rejected: 0 };
  const makeService = (activeStore = store, overrides: Record<string, unknown> = {}) => new CollaborationService({
    store: activeStore,
    serialize: async (_threadId, work) => work(),
    prepare: async (project, request) => {
      calls.prepared++;
      const files = await installApprovedUploads(project.workspacePath, request);
      return { request: { statusMessageId: request.id, prompt: request.prompt, requesterId: request.requesterId, author: request.author, files },
        accepted: async () => { calls.accepted++; } };
    },
    rejected: async () => { calls.rejected++; }, changed: () => {}, ...overrides,
  });
  return { store, project, file, calls, service: makeService(), makeService };
}
function pending(id = "555555"): ProjectApproval {
  return { id, requesterId: guest.userId, author: { name: "Guest", email: "guest@example.test" }, prompt: "Add a checkpoint", createdAt: new Date().toISOString(), attachmentCount: 0, attachments: [] };
}

test("existing projects default to open editing while Discord send permission and deletion still block mutation", async () => {
  const { project } = await fixture();
  assert.equal(contributionAccess(project, guest), "direct");
  assert.doesNotThrow(() => requireContributor(project, guest));
  assert.equal(contributionAccess(project, { ...guest, canSend: false }), "denied");
  assert.equal(contributionAccess({ ...project, pendingDeletion: { requestedAt: "now", reason: "deleted" } }, owner), "denied");
  assert.equal(managesProject(project, guest), false);
  assert.equal(managesProject(project, owner), true);
  assert.equal(managesProject(project, { ...guest, admin: true }), true);
});

test("owner-selected contributors and editing modes persist; stale panels and non-owners cannot change settings", async () => {
  const { service, store, project, file } = await fixture();
  assert.throws(() => service.update(project.threadId, guest, 0, { mode: "contributors" }));
  service.update(project.threadId, owner, 0, { mode: "contributors", userIds: [editor.userId] });
  const selected = store.getProject(project.threadId)!;
  assert.equal(contributionAccess(selected, guest), "denied");
  assert.equal(contributionAccess(selected, editor), "direct");
  assert.equal(contributionAccess(selected, owner), "direct");
  assert.throws(() => service.update(project.threadId, owner, 0, { mode: "open" }));
  assert.throws(() => service.update(project.threadId, owner, 1, { mode: "constructor" as never }));
  assert.equal(contributionAccess(store.getProject(project.threadId)!, guest), "denied");
  service.update(project.threadId, owner, 1, { mode: "approval" });
  store.close();
  const reopened = trackStore(await Store.open(file));
  assert.equal(contributionAccess(reopened.getProject(project.threadId)!, guest), "approval");
  assert.equal(contributionAccess(reopened.getProject(project.threadId)!, editor), "direct");
});

test("human thread ownership overrides the project starter on legacy records and is retained when settings are saved", async () => {
  const { service, store, project } = await fixture();
  await store.patchProject(project.threadId, { ownerId: undefined });
  const threadOwner = { ...owner, threadOwnerId: owner.userId };
  service.update(project.threadId, threadOwner, 0, { mode: "contributors" });
  assert.equal(store.getProject(project.threadId)!.ownerId, owner.userId);
  assert.equal(contributionAccess(store.getProject(project.threadId)!, { ...guest, userId: project.starterId! }), "denied");
});

test("restricted controls reject steers, answers, queue cancellation and rollback; approved requesters can answer only their active turn", async () => {
  const { project } = await fixture();
  const restricted: ProjectRecord = { ...project, collaboration: { mode: "contributors", userIds: [editor.userId], revision: 1 } };
  for (const action of ["change", "steer", "request", "stop", "cancel", "confirm", "answer", "send", "skip"] as const) {
    assert.throws(() => authorizeCard(restricted, guest, action), `guest cannot ${action}`);
    assert.doesNotThrow(() => authorizeCard(restricted, editor, action));
  }
  const approval: ProjectRecord = { ...restricted, collaboration: { ...restricted.collaboration!, mode: "approval" },
    pendingTurn: { id: "active", prompt: "approved", initial: false, startedAt: "now", requesterId: guest.userId } };
  for (const action of ["change", "steer", "request", "answer", "send", "skip"] as const) assert.doesNotThrow(() => authorizeCard(approval, guest, action));
  assert.throws(() => authorizeCard({ ...approval, pendingTurn: { ...approval.pendingTurn!, requesterId: editor.userId } }, guest, "answer"));
  assert.throws(() => authorizeCard(approval, guest, "stop"));
  assert.throws(() => authorizeCard(approval, editor, "approve"));
});

test("approval attachments survive reopening without workspace writes; owner approval atomically moves exactly one request to the queue", async () => {
  const { store, service, makeService, project, file, calls } = await fixture();
  service.update(project.threadId, owner, 0, { mode: "approval" });
  const bytes = Buffer.from("checkpoint reference");
  await service.request(project.threadId, guest, "555555", "Add a checkpoint", pending().author,
    [{ name: "reference.txt", contentType: "text/plain", size: bytes.length, url: `data:text/plain;base64,${bytes.toString("base64")}` } as Attachment]);
  await assert.rejects(fs.access(project.workspacePath), { code: "ENOENT" });
  assert.equal(calls.prepared, 0);
  assert.equal(store.getProject(project.threadId)!.pendingQueue?.length ?? 0, 0);
  store.close();
  const reopened = trackStore(await Store.open(file));
  const resumed = makeService(reopened);
  assert.equal(reopened.getApproval(project.threadId, "555555")!.attachments.length, 1);
  await assert.rejects(resumed.decide(project.threadId, guest, "555555", true));
  assert.equal(await resumed.decide(project.threadId, owner, "555555", true), true);
  assert.equal(await resumed.decide(project.threadId, owner, "555555", true), false);
  const queued = reopened.getProject(project.threadId)!.pendingQueue!;
  assert.equal(queued.length, 1);
  assert.equal(queued[0].requesterId, guest.userId);
  assert.equal(await fs.readFile(path.join(project.workspacePath, queued[0].files![0].path), "utf8"), bytes.toString());
  assert.equal(reopened.getApproval(project.threadId, "555555"), undefined);
  assert.equal(calls.accepted, 1);
  assert.equal(contributionAccess(reopened.getProject(project.threadId)!, guest), "approval", "approval does not grant ongoing editing");
});

test("failed preparation retains approval; delivery failure after commit leaves a durable queue entry instead of replaying", async () => {
  const { store, project, makeService } = await fixture();
  store.addApproval(project.threadId, pending());
  const failed = makeService(store, { prepare: async () => { throw new Error("offline"); } });
  await assert.rejects(failed.decide(project.threadId, owner, "555555", true));
  assert.ok(store.getApproval(project.threadId, "555555"));
  assert.equal(store.getProject(project.threadId)!.pendingQueue?.length ?? 0, 0);
  const interrupted = makeService(store, { prepare: async () => ({ request: { statusMessageId: "555555", prompt: "approved" }, accepted: async () => { throw new Error("restart"); } }) });
  await assert.rejects(interrupted.decide(project.threadId, owner, "555555", true));
  assert.equal(store.getApproval(project.threadId, "555555"), undefined);
  assert.equal(store.getProject(project.threadId)!.pendingQueue!.length, 1);
  assert.equal(await interrupted.decide(project.threadId, owner, "555555", true), false);
});

test("queued approval decisions recheck ownership before preparing work", async () => {
  const { store, project, makeService, calls } = await fixture();
  store.addApproval(project.threadId, pending());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const waiting = makeService(store, { serialize: async (_id: string, work: () => Promise<unknown>) => { await gate; return work(); } });
  const decision = waiting.decide(project.threadId, owner, "555555", true);
  await store.patchProject(project.threadId, { ownerId: editor.userId });
  release();
  await assert.rejects(decision);
  assert.equal(calls.prepared, 0);
  assert.ok(store.getApproval(project.threadId, "555555"));
});

test("revoking access during attachment capture never admits the pending request", async () => {
  const { store, project, service } = await fixture();
  service.update(project.threadId, owner, 0, { mode: "approval" });
  const originalFetch = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = async () => { await gate; return new Response("reference"); };
  try {
    const saving = service.request(project.threadId, guest, "555555", "Use this reference", pending().author,
      [{ name: "file.txt", size: 9, contentType: "text/plain", url: "https://example.test/reference" } as Attachment]);
    service.update(project.threadId, owner, 1, { mode: "contributors" });
    release();
    await assert.rejects(saving);
    assert.equal(store.listApprovals(project.threadId).length, 0);
    assert.equal(store.getProject(project.threadId)!.pendingQueue?.length ?? 0, 0);
    await assert.rejects(fs.access(project.workspacePath), { code: "ENOENT" });
  } finally { globalThis.fetch = originalFetch; release(); }
});

test("maintenance refuses to forget requests awaiting approval until the owner decides them", async () => {
  const { store, project, service } = await fixture();
  const { removeProjects } = await import("../src/maintenance.js");
  store.addApproval(project.threadId, pending());
  const services = { busy: async () => false, deleteThread: async () => { assert.fail("must not delete"); }, deleteRepository: async () => { assert.fail("must not delete"); } };
  await assert.rejects(removeProjects(store, [project], "forget", services));
  assert.ok(store.getProject(project.threadId));
  assert.ok(store.getApproval(project.threadId, "555555"));
  await service.decide(project.threadId, owner, "555555", false);
  await removeProjects(store, [project], "forget", services);
  assert.equal(store.getProject(project.threadId), undefined);
});

test("approval rejection, request bounds and project deletion preserve other projects", async () => {
  const { store, project, service, calls } = await fixture();
  const other = testRecord("777777", path.join(root, "other"));
  await store.putProject(other);
  store.addApproval(other.threadId, pending());
  for (let i = 0; i < 20; i++) store.addApproval(project.threadId, pending(String(555555 + i)));
  assert.throws(() => store.addApproval(project.threadId, pending("666666")));
  await assert.rejects(captureApprovalAttachments([{ size: 8 * 1024 * 1024 + 1 } as Attachment]));
  assert.equal(await service.decide(project.threadId, owner, "555555", false), true);
  assert.equal(calls.prepared, 0);
  assert.equal(calls.rejected, 1);
  store.addApproval(project.threadId, pending("666666"));
  assertV2(service.panel(store.getProject(project.threadId)!, owner));
  await store.deleteProject(project.threadId);
  assert.equal(store.listApprovals(project.threadId).length, 0);
  assert.ok(store.getApproval(other.threadId, "555555"));
});

test("card routing blocks stale forms after permissions change and rechecks controls after Discord acknowledgement", async () => {
  const { store, project, service } = await fixture();
  let modal: any;
  let submitted = 0, stopped = 0;
  const router = new CardInteractions({ store, collaboration: service, questions: {} as never,
    projectSections: () => [], queue: () => ({ requests: [], preparing: 0 }), cancel: async () => "", submit: async () => { submitted++; return "saved"; },
    stop: async () => { stopped++; return "stopped"; }, rollback: async () => {}, busy: async () => false, error: () => {},
  });
  const interaction = (customId: string, overrides: any = {}): any => ({ customId, channelId: project.threadId, guildId: project.guildId,
    user: { id: guest.userId }, memberPermissions: new PermissionsBitField(PermissionFlagsBits.SendMessagesInThreads),
    channel: { isThread: () => true, ownerId: owner.userId }, client: { user: { id: "bot" } },
    inGuild: () => true, isButton: () => true, isModalSubmit: () => false,
    showModal: async (value: unknown) => { modal = value; }, reply: async () => {}, editReply: async () => {}, deferReply: async () => {}, ...overrides,
  });
  await router.handle(interaction(cardId("change", project.threadId)));
  assert.ok(modal);
  service.update(project.threadId, owner, 0, { mode: "contributors", userIds: [] });
  await router.handle(interaction(modal.data.custom_id, { isButton: () => false, isModalSubmit: () => true }));
  assert.equal(submitted, 0);
  service.update(project.threadId, owner, 1, { mode: "open" });
  const turn = "888888";
  await store.patchProject(project.threadId, { pendingTurn: { id: "active", prompt: "run", initial: false, startedAt: "now", statusMessageId: turn } });
  store.patchCardState(project.threadId, turn, {});
  await router.handle(interaction(cardId("stop", turn), { deferReply: async () => { service.update(project.threadId, owner, 2, { mode: "contributors" }); } }));
  assert.equal(stopped, 0);
});
