import { z } from "zod";
import * as definitions from "../dist/tools.mjs";
import { setupLsp } from "../dist/lsp.mjs";
import { checkExpandedCommand } from "./command-policy.mjs";

export default {
  id: "threadsite.v2",
  async setup(ctx) {
    const registrations = [];
    const browserQaModel = ctx.options?.browserQaModel;
    const configuredQaModel = (model) => `${model.providerID}/${model.id}` === browserQaModel?.split("#")[0];
    const isBrowserTool = (name) => /^playwright[._]/.test(name);
    const models = () => ctx.model.list({ location: { directory: ctx.location.directory } });
    const stopLsp = await setupLsp(ctx);
    if (stopLsp) registrations.push({ dispose: stopLsp });
    registrations.push(await ctx.tool.transform((tools) => {
      // Guarded tools use their declared schema. Browser tools use a
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
      // Only the inspection-only QA agent can outlive a tool call. Builders
      // and shell commands must finish before the parent can publish their edits.
      if (event.tool === "shell" || (event.tool === "subagent" && event.input.agent !== "browser-qa")) event.input.background = false;
      if (event.tool === "subagent" && event.input.agent === "browser-qa") {
        const catalog = await models();
        const model = browserQaModel && catalog.data.find(configuredQaModel);
        if (!model?.capabilities.input.includes("image") || model.enabled === false) {
          throw new Error("Browser QA unavailable: OPENCODE_BROWSER_QA_MODEL must select an available model advertising image input. Continue static checks and report visual QA as unavailable.");
        }
        // Delegation cannot replace the dedicated vision model with the parent
        // model or a tool-call override.
        event.input.model = browserQaModel;
      }
      if (event.tool === "shell") await checkExpandedCommand(event.input.command, ctx.location.directory, event.input.workdir);
    }));
    // Native children inherit the parent's session rules, including a text
    // builder's browser denial. Replace those rules only on the QA child before
    // its first tool registry is selected; never broaden the parent session.
    registrations.push(await ctx.session.hook("prompt", async (event) => {
      // MCP connects asynchronously at each location. Select the first registry
      // only after discovery settles, including failed/disabled services.
      const deadline = Date.now() + 10_000;
      while (true) {
        const catalog = await ctx.mcp.list({ location: { directory: ctx.location.directory } },
          { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) }).catch(() => undefined);
        if (!catalog) break;
        const { data } = catalog;
        if (!data.some((server) => server.status.status === "pending") || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await ctx.tool.reload();
      const session = await ctx.session.get({ sessionID: event.sessionID });
      if (session.agent !== "browser-qa" || !session.parentID) return;
      const catalog = await models();
      const model = catalog.data.find((model) => configuredQaModel(model) && model.providerID === session.model?.providerID && model.id === session.model?.id);
      const vision = model?.enabled !== false && model?.capabilities.input.includes("image");
      await ctx.session.update({ sessionID: event.sessionID, permissions: [
        { action: "*", resource: "*", effect: "deny" },
        ...(vision ? ["threadsite_browser", "playwright_*", "playwright.*"].map((action) => ({ action, resource: "*", effect: "allow" })) : []),
      ] });
    }));
    // Last defence if a session's selected model changes outside the bot. This
    // also applies to subagents independently of the parent's image support.
    registrations.push(await ctx.session.hook("context", async (event) => {
      const catalog = await models();
      const model = catalog.data.find((model) => model.id === event.model.id && model.providerID === event.model.providerID);
      const vision = model?.enabled !== false && model?.capabilities.input.includes("image");
      for (const name of Object.keys(event.tools)) {
        if (event.agent === "browser-qa") {
          if (!isBrowserTool(name) || !vision || !configuredQaModel(event.model)) delete event.tools[name];
        } else if (isBrowserTool(name) && (["general", "explore"].includes(event.agent) || !vision)) delete event.tools[name];
      }
    }));
    return async () => { for (const registration of registrations.reverse()) await registration.dispose(); };
  },
};
