import { z } from "zod";
import * as definitions from "../dist/tools.mjs";
import { setupLsp } from "../dist/lsp.mjs";
import { checkExpandedCommand } from "./command-policy.mjs";
import { applyContextCaps } from "./context-caps.mjs";

export default {
  id: "threadsite.v2",
  async setup(ctx) {
    const registrations = [];
    const browserQaModel = ctx.options?.browserQaModel;
    const configuredQaModel = (model) => `${model.providerID}/${model.id}` === browserQaModel?.split("#")[0];
    const isBrowserTool = (name) => /^playwright[._]/.test(name);
    const models = () => ctx.model.list({ location: { directory: ctx.location.directory } });
    const assetModel = ctx.options?.assetModel;
    const assetFallbacks = ctx.options?.assetFallbacks ?? [];
    const assetPermissions = ctx.options?.assetPermissions ?? [];
    const resolveAssetModel = async (sessionID) => {
      if (assetModel === false) {
        throw new Error("asset-forge is disabled (OPENCODE_ASSET_MODEL=off). Create the assets yourself and note the limitation.");
      }
      const { data: catalog } = await models();
      const resolve = (ref) => {
        const [id, variant] = String(ref).split("#");
        const slash = id.indexOf("/");
        if (slash <= 0 || slash === id.length - 1) return undefined;
        const model = catalog.find((model) => model.providerID === id.slice(0, slash) && model.id === id.slice(slash + 1));
        if (!model || model.enabled === false || !model.capabilities.input.includes("image")) return undefined;
        if (variant && !(model.variants ?? []).some((entry) => entry.id === variant)) return undefined;
        return variant ? `${id}#${variant}` : id;
      };
      const candidates = [];
      if (assetModel) candidates.push(assetModel);
      if (sessionID) {
        const session = await ctx.session.get({ sessionID }).catch(() => undefined);
        if (session?.model) candidates.push(`${session.model.providerID}/${session.model.id}${session.model.variant ? `#${session.model.variant}` : ""}`);
      }
      candidates.push(...assetFallbacks);
      const resolved = candidates.map(resolve).find(Boolean);
      if (!resolved) {
        throw new Error("asset-forge unavailable: no enabled image-capable model is configured (set OPENCODE_ASSET_MODEL or OPENCODE_ASSET_FALLBACK_MODELS, or select an image-capable model). Create the assets yourself and note the limitation.");
      }
      return resolved;
    };
    const contextCaps = ctx.options?.contextCaps;
    const registerCaps = contextCaps && Object.keys(contextCaps).length
      ? () => ctx.model.transform((models) => applyContextCaps(models, contextCaps)) : undefined;
    if (registerCaps) registrations.push(await registerCaps());
    let finalCaps;
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
      // Background agents are those the bot's turn ownership waits for: the
      // inspection-only QA agent and the asset creator, whose files must be
      // delivered before the parent can publish. Everything else — builders
      // and shell commands — finishes before the parent continues.
      const backgroundAgents = new Set(["browser-qa", "asset-forge"]);
      if (event.tool === "shell" || (event.tool === "subagent" && !backgroundAgents.has(event.input.agent))) event.input.background = false;
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
      if (event.tool === "subagent" && event.input.agent === "asset-forge") {
        // Defaults to the parent's selected model (variant included) and falls
        // back through the configured list; the resolved model must advertise
        // image input so the agent can see what it creates, and the parent
        // cannot substitute its own choice.
        event.input.model = await resolveAssetModel(event.sessionID);
      }
      if (event.tool === "shell") await checkExpandedCommand(event.input.command, ctx.location.directory, event.input.workdir);
      // Screenshot saves live in the preview container; the workspace is not
      // writable from there, so a workspace path fails the whole call with
      // EROFS/ENOENT after the browser already produced the image. Path-shaped
      // targets are dropped — the screenshot still returns as image content.
      if (/^playwright[._].*take_screenshot$/.test(event.tool)) {
        if (typeof event.input.rawPath === "string" && event.input.rawPath) delete event.input.rawPath;
        if (typeof event.input.filename === "string"
          && (event.input.filename.includes("/") || event.input.filename.includes("\\") || /^[~.]/.test(event.input.filename))) {
          delete event.input.filename;
        }
      }
    }));
    registrations.push(await ctx.shell.hook("create.before", async (event) => {
      // Spawned commands inherit the server's environment, which carries every
      // provider credential and the server password; a prompt-injected command
      // could print them regardless of file permissions. Rebuild the child
      // environment from an allowlist so tools run with none of it.
      if (!event.env) return;
      const allowed = (key) => key === "PATH" || key === "HOME" || key === "TERM" || key === "LANG" || key === "TZ"
        || key === "TMPDIR" || key === "SHELL" || key === "OPENCODE_TERMINAL" || key === "SSL_CERT_FILE"
        || key === "SSL_CERT_DIR" || key.startsWith("LC_");
      for (const key of Object.keys(event.env)) {
        if (!allowed(key)) delete event.env[key];
      }
    }));
    // Native children inherit the parent's session rules, including a text
    // builder's browser denial. Replace those rules only on children that get
    // browser tools (QA and the asset creator) before their first tool
    // registry is selected; never broaden the parent session.
    registrations.push(await ctx.session.hook("prompt", async (event) => {
      // OpenCode installs its config transform after user plugins. Append a
      // final cap once config is ready, so alias inheritance cannot restore an
      // uncapped source window before compaction or a provider request.
      if (registerCaps) await (finalCaps ??= registerCaps().then((registration) => { registrations.push(registration); }));
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
      if (!session.parentID) return;
      const catalog = await models();
      if (session.agent === "browser-qa") {
        const model = catalog.data.find((model) => configuredQaModel(model) && model.providerID === session.model?.providerID && model.id === session.model?.id);
        const vision = model?.enabled !== false && model?.capabilities.input.includes("image");
        await ctx.session.update({ sessionID: event.sessionID, permissions: [
          { action: "*", resource: "*", effect: "deny" },
          ...(vision ? ["threadsite_browser", "playwright_*", "playwright.*"].map((action) => ({ action, resource: "*", effect: "allow" })) : []),
        ] });
        return;
      }
      if (session.agent === "asset-forge") {
        // Re-apply the configured creator profile (asset tools, scratch/asset
        // edits, scoped shell) and grant the browser tools only when the
        // child's own model accepts images, mirroring the builder's rule.
        const model = catalog.data.find((model) => model.providerID === session.model?.providerID && model.id === session.model?.id);
        const vision = model?.enabled !== false && model?.capabilities.input.includes("image");
        await ctx.session.update({ sessionID: event.sessionID, permissions: [
          ...structuredClone(assetPermissions),
          ...(vision ? ["threadsite_browser", "playwright_*", "playwright.*"].map((action) => ({ action, resource: "*", effect: "allow" })) : []),
        ] });
      }
    }));
    // Last defence if a session's selected model changes outside the bot. This
    // also applies to subagents independently of the parent's image support.
    registrations.push(await ctx.session.hook("context", async (event) => {
      const catalog = await models();
      const model = catalog.data.find((model) => model.id === event.model.id && model.providerID === event.model.providerID);
      const vision = model?.enabled !== false && model?.capabilities.input.includes("image");
      const creatorTools = new Set(["read", "write", "edit", "apply_patch", "glob", "grep", "list", "shell",
        "asset_save", "asset_download", "asset_import", "websearch", "webfetch"]);
      for (const name of Object.keys(event.tools)) {
        if (event.agent === "browser-qa") {
          if (!isBrowserTool(name) || !vision || !configuredQaModel(event.model)) delete event.tools[name];
        } else if (event.agent === "asset-forge") {
          // The creator sources, writes through the guarded tools, and reviews
          // its work visually (asset_preview, browser viewer page, the running
          // game) when its model accepts images.
          if (!creatorTools.has(name) && !(isBrowserTool(name) && vision) && !(name === "asset_preview" && vision)) delete event.tools[name];
        } else {
          if (isBrowserTool(name) && (["general", "explore"].includes(event.agent) || !vision)) delete event.tools[name];
          if (name === "asset_save" && event.agent !== "asset-forge") delete event.tools[name];
          // Visual asset review needs advertised image input; research
          // subagents never need it.
          if (name === "asset_preview" && (!vision || event.agent !== "sitebuilder")) delete event.tools[name];
        }
      }
    }));
    return async () => { for (const registration of registrations.reverse()) await registration.dispose(); };
  },
};
