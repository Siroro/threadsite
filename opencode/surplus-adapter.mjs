import { readFile } from "node:fs/promises";
import { applyProviderConfig } from "./provider-config.mjs";

// Keep the Surplus catalog fetcher available to integration checks. Production
// loads the same JSON defaults and discovers catalogs through the shared loader.
export async function buildSurplusProvider({ config = {}, ...options } = {}) {
  const defaults = JSON.parse(await readFile(new URL("./providers.json", import.meta.url), "utf8"));
  const result = await applyProviderConfig({ providers: defaults.providers }, config, {
    ...options, defaultCatalogs: defaults.catalogs, defaultContextCaps: defaults.contextCaps,
  });
  return { provider: result.providers.surplus, contextCaps: result.contextCaps };
}
