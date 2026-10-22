import { z } from "zod";
import * as definitions from "../dist/tools.mjs";
import { setupLsp } from "../dist/lsp.mjs";
import { checkExpandedCommand } from "./command-policy.mjs";

export default {
  id: "threadsite.v2",
  async setup(ctx) {
    const registrations = [];
    const stopLsp = await setupLsp(ctx);
    if (stopLsp) registrations.push({ dispose: stopLsp });
    registrations.push(await ctx.tool.transform((tools) => {
      // Direct tools retain the v1 model-facing contract. Browser tools use a
      // dedicated permission action so they can be absent for non-vision turns.
      const allowed = new Set(["read", "write", "edit", "apply_patch", "glob", "grep", "list", "shell", "skill", "subagent", "webfetch", "websearch", "question", "todowrite", "lsp"]);
      const docs = new Set(["context7_resolve-library-id", "context7_query-docs"]);
      for (const tool of tools.list()) {
        if (!allowed.has(tool.id) && !docs.has(tool.id) && !/^playwright[._]/.test(tool.id)) { tools.remove(tool.id); continue; }
        tools.update(tool.id, (current) => {
          current.options = { ...current.options, codemode: false,
            ...(/^playwright[._]/.test(tool.id) ? { permission: "threadsite_browser" } : {}),
            ...(docs.has(tool.id) ? { permission: "threadsite_docs" } : {}) };
        });
      }
      for (const [name, definition] of Object.entries(definitions)) tools.add({
        name, description: definition.description, input: z.object(definition.args),
        options: { codemode: false },
        execute: async (input, context) => ({ content: await definition.execute(input, {
          ...context, directory: ctx.location.directory,
        }) }),
      });
      tools.add({ name: "todoread", description: "Read the existing plan for this session before resuming work.",
        input: z.object({}), options: { codemode: false },
        execute: async (_input, context) => {
          const history = await ctx.session.context({ sessionID: context.sessionID });
          const latest = history.filter((message) => message.type === "assistant").flatMap((message) => message.content)
            .filter((part) => part.type === "tool" && part.name === "todowrite" && typeof part.state.input === "object").at(-1);
          return { content: JSON.stringify(latest?.state.input.todos ?? []) };
        },
      });
    }));
    registrations.push(await ctx.tool.hook("execute.before", async (event) => {
      // Match v1's owning-turn lifecycle: detached work must not keep editing
      // after the root reports success and the harness starts publication.
      if (event.tool === "subagent" || event.tool === "shell") event.input.background = false;
      if (event.tool === "shell") await checkExpandedCommand(event.input.command, ctx.location.directory, event.input.workdir);
    }));
    // Last defence if a session's selected model changes outside the bot. This
    // also applies to subagents independently of the parent's image support.
    registrations.push(await ctx.session.hook("context", async (event) => {
      const catalog = await ctx.model.list();
      const model = catalog.data.find((model) => model.id === event.model.id && model.providerID === event.model.providerID);
      if (["general", "explore"].includes(event.agent) || !model?.capabilities.input.includes("image")) {
        for (const name of Object.keys(event.tools)) if (/^playwright[._]/.test(name)) delete event.tools[name];
      }
    }));
    return async () => { for (const registration of registrations.reverse()) await registration.dispose(); };
  },
};
