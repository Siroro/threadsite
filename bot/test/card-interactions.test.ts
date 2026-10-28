import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { PermissionFlagsBits, PermissionsBitField, type Message, type MessageEditOptions, type ModalBuilder } from "discord.js";
import { testRecord, testRootSetup, trackStore } from "./fixtures/root.js";
import { cardView } from "./fixtures/cards.js";
import type { RequestFormState } from "../src/card-state.js";

const root = testRootSetup("card-interactions");
const { Store } = await import("../src/store.js");
const { CardInteractions } = await import("../src/card-interactions.js");
const { cardId } = await import("../src/card-actions.js");
const { DiscordProgress } = await import("../src/progress.js");

let serial = 0;

/** A thread with a live turn on its status card, plus a routing-only card service. */
async function fixture() {
  const threadId = String(700000 + ++serial);
  const store = trackStore(await Store.open(path.join(root, `${threadId}.sqlite`)));
  const project = testRecord(threadId, path.join(root, "workspaces", threadId));
  await store.putProject(project);
  const turn = String(800000 + ++serial);
  await store.patchProject(threadId, { pendingTurn: { id: "turn-1", prompt: "make it pop", initial: false, startedAt: new Date().toISOString(), statusMessageId: turn } });
  store.patchCardState(threadId, turn, {});
  const submitted: RequestFormState[] = [];
  const wiped: string[] = [];
  const stopped: string[] = [];
  const replies: unknown[] = [];
  const router = new CardInteractions({ store, questions: {} as never,
    projectSections: () => [], queue: () => ({ requests: [], preparing: 0 }), cancel: async () => "",
    submit: async (_interaction, _project, form) => { submitted.push(form); return "saved"; },
    stop: async (_threadId, statusId) => { stopped.push(statusId); return "stopped"; }, rollback: async () => {}, busy: async () => false, error: () => {},
    wipe: async (threadId, userId, scope) => {
      wiped.push(`${threadId}/${userId}:${[scope.world ? "world" : "", scope.scores ? "scores" : ""].filter(Boolean).join("+")}`);
      return "wipe done";
    },
  });
  const interaction = (customId: string, overrides: Record<string, unknown> = {}): any => ({
    customId, channelId: threadId, guildId: project.guildId, user: { id: "12345" },
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.SendMessagesInThreads),
    channel: { isThread: () => true }, client: { user: { id: "bot" } },
    inGuild: () => true, isButton: () => false, isModalSubmit: () => false, deferred: false, replied: false,
    showModal: async () => {}, reply: async (value: unknown) => { replies.push(value); }, editReply: async (value: unknown) => { replies.push(value); }, deferReply: async () => {}, deferUpdate: async () => {},
    ...overrides,
  });
  return { store, threadId, turn, router, submitted, wiped, stopped, replies, interaction };
}

test("the live progress stop control routes to its turn and cannot stop a successor", async () => {
  const f = await fixture();
  const edits: MessageEditOptions[] = [];
  const progress = new DiscordProgress({ id: f.turn, edit: async (payload: MessageEditOptions) => { edits.push(payload); } } as unknown as Message, "Updating");
  progress.enableStopButton();
  await progress.close();
  const control = cardView(edits[0]).buttons.find((button) => button.custom_id?.startsWith("ts2:stop:"))!;
  await f.router.handle(f.interaction(control.custom_id!, { isButton: () => true }));
  assert.deepEqual(f.stopped, [f.turn]);
  await f.store.patchProject(f.threadId, { pendingTurn: { id: "successor", prompt: "next", initial: false, startedAt: new Date().toISOString(), statusMessageId: "999999" } });
  await f.router.handle(f.interaction(control.custom_id!, { isButton: () => true }));
  assert.deepEqual(f.stopped, [f.turn]);
});

/** Modal fields as discord.js reports them. */
function modalFields(options: { prompt?: string; restart?: boolean } = {}) {
  return {
    getTextInputValue: (id: string) => (id === "prompt" ? options.prompt ?? "" : ""),
    getUploadedFiles: () => null,
    getCheckbox: (id: string) => {
      return options.restart ?? false;
    },
  };
}

/** Open the steer form from the running card and submit it with the given fields. */
async function steerSubmission(f: Awaited<ReturnType<typeof fixture>>, fields: ReturnType<typeof modalFields>) {
  let modal: ModalBuilder | undefined;
  await f.router.handle(f.interaction(cardId("steer", f.turn), { isButton: () => true, showModal: async (value: ModalBuilder) => { modal = value; } }));
  assert.ok(modal, "the steer button opens the request modal");
  await f.router.handle(f.interaction(modal!.data.custom_id!, { isButton: () => false, isModalSubmit: () => true, fields }));
}

test("a checked restart checkbox reaches the submit service flagged on the steer form", async () => {
  const f = await fixture();
  await steerSubmission(f, modalFields({ prompt: "make it ice-blue instead", restart: true }));
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].steer, true);
  assert.equal(f.submitted[0].restart, true, "the restart choice rides the claimed form, not just the store");
});

test("unchecked steer forms stay ordinary steers", async () => {
  const f = await fixture();
  await steerSubmission(f, modalFields({ prompt: "also add penguins", restart: false }));
  assert.equal(f.submitted[0].restart, false);
});

test("queue-form submissions never carry the restart flag", async () => {
  const f = await fixture();
  let modal: ModalBuilder | undefined;
  await f.router.handle(f.interaction(cardId("change", f.threadId), { isButton: () => true, showModal: async (value: ModalBuilder) => { modal = value; } }));
  assert.ok(modal, "the change button opens the request modal");
  await f.router.handle(f.interaction(modal!.data.custom_id!, { isButton: () => false, isModalSubmit: () => true, fields: modalFields({ prompt: "queue this", restart: true }) }));
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].steer, false);
  assert.notEqual(f.submitted[0].restart, true, "the restart option exists only on the steer form");
});

/** A game thread whose owner is someone else; the fixture user is a plain member. */
async function gameFixture(extra: Record<string, unknown> = {}) {
  const f = await fixture();
  const record = f.store.getProject(f.threadId)!;
  await f.store.patchProject(f.threadId, { projectKind: "game-2d", multiplayerGameId: record.siteSlug, ownerId: "999", ...extra });
  return f;
}

test("the card wipe button opens a scope form instead of editing the distant card", async () => {
  const f = await gameFixture({ collaboration: { mode: "open", userIds: [], revision: 1, wipePolicy: "anyone" } });
  let modal: ModalBuilder | undefined;
  await f.router.handle(f.interaction(cardId("wipe", f.threadId), { isButton: () => true, showModal: async (value: ModalBuilder) => { modal = value; } }));
  assert.ok(modal, "the button opens a modal centred on the user's view");
  assert.deepEqual(f.wiped, [], "opening the form clears nothing");
  const json = JSON.stringify(modal!.toJSON());
  assert.match(json, /"custom_id":"world"/);
  assert.match(json, /"custom_id":"scores"/);
  assert.match(json, /"default":true/, "both scopes start checked, so submitting is the deliberate act");
});

test("submitting the wipe form clears exactly the checked scopes", async () => {
  const f = await gameFixture({ collaboration: { mode: "open", userIds: [], revision: 1, wipePolicy: "anyone" } });
  const submit = (boxes: Record<string, boolean>) => f.router.handle(f.interaction(cardId("wipe", f.threadId), {
    isButton: () => false, isModalSubmit: () => true,
    fields: { getCheckbox: (id: string) => boxes[id] ?? (() => { throw new Error(`No modal component with id: ${id}`); })() },
  }));
  await submit({ world: true, scores: false });
  await submit({ world: false, scores: true });
  await submit({ world: true, scores: true });
  assert.deepEqual(f.wiped, [
    `${f.threadId}/12345:world`,
    `${f.threadId}/12345:scores`,
    `${f.threadId}/12345:world+scores`,
  ]);
});

test("an empty wipe form is refused rather than clearing nothing silently", async () => {
  const f = await gameFixture({ collaboration: { mode: "open", userIds: [], revision: 1, wipePolicy: "anyone" } });
  await f.router.handle(f.interaction(cardId("wipe", f.threadId), {
    isButton: () => false, isModalSubmit: () => true, fields: { getCheckbox: () => false },
  }));
  assert.deepEqual(f.wiped, []);
  assert.ok(JSON.stringify(f.replies).includes("Choose at least one thing to clear"));
});

test("a submitted wipe form still rechecks the current policy before resetting", async () => {
  const f = await gameFixture({ collaboration: { mode: "open", userIds: [], revision: 1, wipePolicy: "anyone" } });
  // The owner tightens the policy while the form is still open.
  await f.store.patchProject(f.threadId, { collaboration: { mode: "open", userIds: [], revision: 2, wipePolicy: "owner" } });
  await f.router.handle(f.interaction(cardId("wipe", f.threadId), {
    isButton: () => false, isModalSubmit: () => true, fields: { getCheckbox: () => true },
  }));
  assert.deepEqual(f.wiped, [], "a stale form cannot outlive the policy that allowed it");
});

test("singleplayer games get a scores-only form, and only the owner's policy or managers reach it", async () => {
  const f = await gameFixture({ multiplayerMode: "singleplayer" });
  let modal: ModalBuilder | undefined;
  await f.router.handle(f.interaction(cardId("wipe", f.threadId), {
    isButton: () => true,
    memberPermissions: new PermissionsBitField([PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.ManageGuild]),
    showModal: async (value: ModalBuilder) => { modal = value; },
  }));
  assert.ok(modal, "server administrators always reach the form");
  assert.doesNotMatch(JSON.stringify(modal!.toJSON()), /"custom_id":"world"/, "singleplayer has no shared arena world to clear");
  assert.match(JSON.stringify(modal!.toJSON()), /"custom_id":"scores"/);
  const denied = await gameFixture();
  await denied.router.handle(denied.interaction(cardId("wipe", denied.threadId), { isButton: () => true }));
  assert.ok(JSON.stringify(denied.replies).includes("Only the thread owner"), "the denial explains the Collaboration toggle");
  const site = await fixture();
  await site.router.handle(site.interaction(cardId("wipe", site.threadId), {
    isButton: () => true,
    memberPermissions: new PermissionsBitField([PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.ManageGuild]),
  }));
  assert.deepEqual(site.wiped, [], "site projects hold no relay state");
});
