import assert from "node:assert/strict";
import { test } from "node:test";
import { testRootSetup, testRecord, trackStore } from "./fixtures/root.js";

const root = testRootSetup("project-card-service");
const { Store } = await import("../src/store.js");
const { ProjectCardService } = await import("../src/project-card-service.js");

test("pinned card refresh edits only bot-owned messages and persists replacements", async () => {
  const store = trackStore(await Store.open(`${root}/state.db`));
  await store.putProject(testRecord("thread", root, { infoMessageId: "old" }));
  let author = "bot";
  let edits = 0;
  let sends = 0;
  let pins = 0;
  const thread = {
    isTextBased: () => true,
    messages: { fetch: async () => ({ author: { id: author }, edit: async () => { edits += 1; } }) },
    send: async () => { sends += 1; return { id: "replacement", pin: async () => { pins += 1; } }; },
  };
  const client = { channels: { fetch: async () => thread }, user: { id: "bot" } };
  const cards = new ProjectCardService(store, client as any, { threadTotal: async () => undefined }, {
    siteLink: () => "https://sites.example/game", repoLink: () => "https://git.example/game",
  });
  await cards.refresh("thread");
  assert.equal(edits, 1);
  assert.equal(sends, 0);
  author = "someone-else";
  await cards.refresh("thread");
  assert.equal(edits, 1);
  assert.equal(sends, 1);
  assert.equal(pins, 1);
  assert.equal(store.getProject("thread")?.infoMessageId, "replacement");
  await cards.refresh("missing");
  assert.equal(sends, 1);
});

test("card state uses accepted-turn metadata and refreshes attachment URLs, with unavailable preview fallback", async () => {
  const store = trackStore(await Store.open(`${root}/metadata.db`));
  const project = testRecord("metadata", root, { lastCardMessageId: "accepted", previewMessageId: "preview" });
  await store.putProject(project);
  store.patchCardState(project.threadId, "accepted", { result: { description: { title: "Accepted version", text: "Ready" } } });
  let unavailable = false;
  const client = { channels: { fetch: async () => {
    if (unavailable) throw new Error("unavailable");
    return { isTextBased: () => true, messages: { fetch: async () => ({ attachments: {
      find: (predicate: (attachment: any) => boolean) => {
        const attachment = { contentType: "image/png", url: "https://cdn.example/fresh" };
        return predicate(attachment) ? attachment : undefined;
      },
    } }) } };
  } }, user: { id: "bot" } };
  const cards = new ProjectCardService(store, client as any, { threadTotal: async () => undefined }, {
    siteLink: () => "https://sites.example/game", repoLink: () => "https://git.example/game",
  });
  const state = await cards.state(project);
  assert.equal(state.description?.title, "Accepted version");
  assert.equal(state.thumbnailUrl, "https://cdn.example/fresh");
  unavailable = true;
  assert.equal((await cards.state(project)).thumbnailUrl, undefined);
  assert.equal((await cards.state({ ...project, status: "creating" })).siteUrl, undefined);
});
