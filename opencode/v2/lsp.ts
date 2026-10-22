import { LspManager } from "./vendor/lsp/src/manager.ts";
import { afterTool } from "./vendor/lsp/src/diagnostics.ts";
import { lspTool } from "./vendor/lsp/src/tool.ts";
import type { Settings } from "./vendor/lsp/src/config.ts";

// Only the deployment's plugin options supply commands. Never discover LSP
// settings (or executable paths) in a generated project's config files.
export async function setupLsp(ctx: any) {
  const settings: Settings = {
    servers: Object.entries(ctx.options?.lsp || {}).flatMap(([id, value]: [string, any]) =>
      value.disabled ? [] : [{ id, command: value.command, extensions: value.extensions,
        env: value.env ?? {}, initialization: value.initialization }]),
    diagnostics: true, diagnosticsTimeoutMs: 5000,
    initializeTimeoutMs: 45000, requestTimeoutMs: 15000, debug: false,
  };
  if (!settings.servers.length) return;
  const manager = new LspManager(settings, ctx.location.directory);
  const registration = await ctx.tool.transform((tools: any) => tools.add(lspTool(manager, ctx.location.directory)));
  const diagnose = afterTool(manager, ctx.location.directory, true);
  const hook = await ctx.tool.hook("execute.after", async (event: any) => {
    // Diagnostics are advisory. A failed language server must not fail an edit.
    try { await diagnose(event); } catch { /* The mandatory compiler gate still runs. */ }
  });
  return async () => {
    await hook.dispose();
    await registration.dispose();
    await manager.shutdown();
  };
}
