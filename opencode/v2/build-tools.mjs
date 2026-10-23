import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ["v2/tools.ts"], outfile: "dist/tools.mjs",
  bundle: true, platform: "node", format: "esm", target: "node24",
});
await build({
  absWorkingDir: root,
  entryPoints: ["v2/lsp.ts"], outfile: "dist/lsp.mjs",
  bundle: true, platform: "node", format: "esm", target: "node24",
});
