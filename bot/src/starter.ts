import type { ProjectKind } from "./types.js";

/** First site/index.html in every new workspace; references the compiled bundle. */
export function starterHtml(name: string): string {
  const safe = name.replace(/[&<>"']/g, "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safe}</title></head><body><main><h1>${safe}</h1><p>Site generation is starting…</p></main><script type="module" src="js/main.js"></script></body></html>\n`;
}

/**
 * The first site/src/main.ts in every new workspace. Tiny on purpose — the
 * agent replaces it — but it compiles, imports the engine package for game
 * kinds so the import paths are demonstrated working, and gives the initial
 * baseline commit a real bundle.
 */
export function starterSource(kind: ProjectKind): string {
  if (kind === "game-3d") {
    return `// ThreadSite starter — site/src/main.ts.
// The harness bundles each top-level src/*.ts entry into js/<name>.js when
// your turn ends; index.html already loads js/main.js as a module. Import
// siblings like "./player.js" and the engine package like "three" (see AGENTS.md).
import * as THREE from "three";

console.log(\`[boot] three.js r\${THREE.REVISION} — build the game in site/src/\`);
`;
  }
  if (kind === "game-2d") {
    return `// ThreadSite starter — site/src/main.ts.
// The harness bundles each top-level src/*.ts entry into js/<name>.js when
// your turn ends; index.html already loads js/main.js as a module. Import
// siblings like "./player.js" and the engine package like "pixi.js" (see AGENTS.md).
import * as PIXI from "pixi.js";

console.log(\`[boot] PixiJS \${PIXI.VERSION} — build the game in site/src/\`);
`;
  }
  return `// ThreadSite starter — site/src/main.ts.
// The harness bundles each top-level src/*.ts entry into js/<name>.js when
// your turn ends; index.html already loads js/main.js as a module. Import
// siblings like "./feature.js" and split by responsibility as the site grows.
document.documentElement.classList.add("js-booted");
console.log("[boot] build the site in site/src/");
`;
}
