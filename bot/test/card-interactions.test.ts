import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { PermissionFlagsBits, PermissionsBitField, type ModalBuilder } from "discord.js";
import { testRecord, testRootSetup, trackStore } from "./fixtures/root.js";
import type { RequestFormState } from "../src/card-state.js";

const root = testRootSetup("card-interactions");
const { Store } = await import("../src/store.js");
const { CardInteractions } = await import("../src/card-interactions.js");
const { cardId } = await import("../src/card-actions.js");

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
  const router = new CardInteractions({ store, questions: {} as never,
    projectSections: () => [], queue: () => ({ requests: [], preparing: 0 }), cancel: async () => "",
    submit: async (_interaction, _project, form) => { submitted.push(form); return "saved"; },
    stop: async () => "", rollback: async () => {}, busy: async () => false, error: () => {},
  });
  const interaction = (customId: string, overrides: Record<string, unknown> = {}): any => ({
    customId, channelId: threadId, guildId: project.guildId, user: { id: "12345" },
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.SendMessagesInThreads),
    channel: { isThread: () => true }, client: { user: { id: "bot" } },
    inGuild: () => true, isButton: () => false, isModalSubmit: () => false, deferred: false, replied: false,
    showModal: async () => {}, reply: async () => {}, editReply: async () => {}, deferReply: async () => {}, deferUpdate: async () => {},
    ...overrides,
  });
  return { store, threadId, turn, router, submitted, interaction };
}

/** Modal fields as discord.js reports them; "absent" simulates a pre-checkbox modal. */
function modalFields(options: { prompt?: string; restart?: boolean | "absent" } = {}) {
  return {
    getTextInputValue: (id: string) => (id === "prompt" ? options.prompt ?? "" : ""),
    getUploadedFiles: () => null,
    getCheckbox: (id: string) => {
      if (options.restart === "absent") throw new Error(`No modal component with id: ${id}`);
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

test("unchecked and pre-checkbox steer forms stay ordinary steers", async () => {
  const f = await fixture();
  await steerSubmission(f, modalFields({ prompt: "also add penguins", restart: false }));
  await steerSubmission(f, modalFields({ prompt: "and a seal", restart: "absent" }));
  assert.deepEqual(f.submitted.map((form) => form.restart), [false, false], "legacy modals submit as unchecked rather than failing");
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
