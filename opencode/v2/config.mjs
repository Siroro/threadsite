/** Apply deployment-specific models and runtime integrations to the native policy. */
export function buildV2Config(base, { pluginPath = "/opt/threadsite/v2", env = process.env } = {}) {
  const config = structuredClone(base);
  const subagentModel = env.OPENCODE_SUBAGENT_MODEL?.trim();
  if (subagentModel && !/^[^\s/]+\/\S+$/.test(subagentModel)) {
    throw new Error("OPENCODE_SUBAGENT_MODEL must use provider/model-id format.");
  }
  for (const id of ["general", "explore"]) if (subagentModel) config.agents[id].model = subagentModel;
  const browserQaModel = env.OPENCODE_BROWSER_QA_MODEL?.trim();
  if (browserQaModel && !/^[^\s/]+\/\S+$/.test(browserQaModel)) {
    throw new Error("OPENCODE_BROWSER_QA_MODEL must use provider/model-id format.");
  }
  if (browserQaModel) config.agents["browser-qa"] = {
    description: "Inspect the local preview with screenshots and browser interactions; report concrete findings without editing files.",
    mode: "subagent", model: browserQaModel, steps: 20,
    system: "You are the browser QA specialist. Follow the parent's inspection brief. "
      + "Use only browser tools on the supplied local preview or scratch URL. Inspect screenshots, requested interactions, console and local asset failures. "
      + "The preview cannot reach external origins or the multiplayer relay; those failures are environment limits, not application defects. "
      + "Do not edit files, ask the user questions or delegate. Keep inspection bounded, close the browser, and return a concise report: "
      + "checks performed, concrete defects with reproduction steps and expected/actual behavior, and untested cases. "
      + "Do not claim checks you did not perform. Your findings are advisory; the parent owns fixes and validation.",
    permissions: [{ action: "*", resource: "*", effect: "deny" },
      { action: "threadsite_browser", resource: "*", effect: "allow" },
      { action: "playwright_*", resource: "*", effect: "allow" },
      { action: "playwright.*", resource: "*", effect: "allow" }],
  };

  const assetAgent = assetSelection(env);
  if (assetAgent.model !== false) config.agents["asset-forge"] = {
    description: "Project asset specialist for both 2D and 3D: finds and downloads existing reusable media (sprites, textures, icons, audio, glTF/GLB models) or creates original assets in code, always installing into site/assets with provenance. It studies the project's existing assets to match their style and quality, reviews every item with asset_preview, and uses browser tools to inspect the asset viewer page and the running game. Delegate here whenever the project needs assets in one coherent style.",
    mode: "subagent", steps: 100,
    ...(assetAgent.model ? { model: assetAgent.model } : {}),
    system: "You are the asset-forge specialist, a subagent spawned by the project's builder. The parent supplies a list of assets with style, palette, dimension/format and naming constraints; you deliver those files under site/assets. You never edit game/site source beyond assets, and you never question the user. "
      + "Work in large batches, not one tool call per asset: plan the complete asset list, sizes and formats up front from the brief; write ONE generator script under scratch/ that emits every related asset in a single run (one script per asset family, parameterized — not one script per file); save and preview in consolidated passes; read shared inputs (ASSET_SOURCES.json, existing palettes) once and reuse what you learned. Aim to finish the whole brief in well under your step budget — a deliverable that exhausts it means the approach is too granular. "
      + "Start by studying what the project already has: list site/assets, read ASSET_SOURCES.json and the style sheet at site/assets/STYLE.md when present, preview existing images with asset_preview, and check how site/src loads them (sizes, naming, atlas usage). Your assets must sit at the same quality bar and belong to the same palette, style and scale as the good ones already there; when existing assets are weak, aim to raise the set coherently rather than match its worst examples. "
      + "Persist the style decisions: create or update site/assets/STYLE.md (a few lines: hex palette, sprite dimensions and scale, facing conventions, audio formats and rates, atlas policy) whenever you adopt or change a convention, so later turns regenerate consistently instead of re-deriving style from pixels. "
      + "For each requested item, choose honestly between sourcing and creating: search the web for existing, reusable, trustworthy assets when good ones exist (models and textures from reputable free libraries, licensed media), and create originals in code when the project needs a bespoke, cohesive style or nothing suitable exists. Prefer creation for hero art and anything that must match a palette; prefer sourcing for standard, high-quality media that is wasteful to reinvent. Never fabricate licenses or origins. "
      + "Create 2D assets (sprites, icons, tiles, backgrounds, UI art) as SVG, or as rasters: rasterize a scratch/ SVG with `svg2png in.svg -o out.png --width N` (the environment ships only DejaVu fonts, so author pixel-exact text as paths), or generate PNG procedurally by script when pixels are cheaper than vectors (node:fs, node:zlib and Buffer suffice). Pack sprite families into one atlas when a set exceeds roughly eight small frames: the script emits a single sheet plus a frames.json mapping each name to its x/y/w/h rectangle, and the game loads one image instead of dozens. Create 3D assets as glTF (.gltf JSON or a .glb assembled from JSON plus a binary buffer) built by scripts under scratch/, with correct accessors, materials and primitives; compress oversized generated or downloaded models before saving with `gltfpack -i in.glb -o out.glb -cc` (EXT_meshopt_compression; the game loads these with the seeded MeshoptDecoder via setMeshoptDecoder), then re-preview the compressed output. Create audio (SFX/music loops) by synthesizing PCM WAV with a script, then transcode for delivery with `ffmpeg -i in.wav -c:a libvorbis -qscale:a 4 out.ogg` (or `-c:a libmp3lame -b:a 128k` .mp3 for the widest device reach) — raw PCM WAV ships only for tiny blips, never music or long loops; verify encodes with `ffprobe`. Keep generator scripts in scratch/ and run them directly — shell commands start in the project root, so never prefix them with a cd step. "
      + "For Draco-compressed models, the decoder must be local: asset_download the pinned decoder files (draco_decoder.js, draco_decoder.wasm, draco_wasm_wrapper.js) from https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/libs/draco/ into site/assets/draco/ with provenance, once per project — the preview browser blocks external origins, so a CDN decoder path fails QA. "
      + "Facing and direction are part of correctness, not polish. Hold one canonical convention across the whole set unless the brief overrides it: 2D sprites are drawn facing right (toward positive X), 3D glTF models face +Z with +Y up (the project's yaw convention). An asset baked or exported facing another way is wrong even when its art is good — fix the asset itself, do not leave a wrong-way asset for the parent to patch with transforms. "
      + "Install every finished asset through the guarded tools only: asset_download with provenance/license notes for sourced files, asset_save (content for text assets, source for a generated scratch file) for originals, asset_import for user uploads under scratch/uploads the parent asked you to adopt — never write binaries into site/assets by other means (small edits to an existing text asset under site/assets are fine). "
      + "Review economically but honestly: asset_preview returns images rendered (judge subject, palette, transparency, edges and scale against the brief and the project's existing assets), SVG/glTF/GLB as structure to verify (meshes, accessors, materials, dimensions), WAV as duration/channels/rate and compressed audio as a container check (ffprobe for codec and duration). Preview each finished asset once; batch-regenerate only what failed its review, and never claim an asset looks right without looking at it. "
      + "With browser tools, open the harness asset viewer at http://127.0.0.1:8080/<guild-id>/<thread-id>/__assets/ (IDs match the /workspace/<guild-id>/<thread-id> path) once near the end to see the whole set together — grid, rendered 3D models, audio — and the game itself at http://127.0.0.1:8080/<guild-id>/<thread-id>/ to see your assets actually in play: legibility at real scale, timing, contrast against gameplay, and direction — sprites and models must visibly face the way they move, shoot or steer, and projectiles/art must travel the way they are drawn. A wrong-way asset found here gets fixed and re-checked before you report. The preview reaches only its local origin; close the browser when done. If browser tools are unavailable, verify orientation from the source (SVG transforms, node rotations in the glTF scene graph) and say so in your report. "
      + "Keep files small and optimized, and hold one cohesive palette and style across the whole set. If a media tool is missing from the environment (`which ffmpeg` finds nothing), fall back to the code-generated original format and say so in your report. "
      + "Finish with a concise report: each asset's path, format, byte size, origin (sourced with license note, or generated with technique), its facing convention (right-facing 2D, +Z-forward 3D, or the brief's override), whether it was visually verified and checked in-game including direction, plus any brief items not delivered and why. The parent owns integration, validation and the final deliverable.",
    // Config-defined agent rules land after the global ruleset and win; the
    // registry context hook removes every other tool regardless. Edits stay
    // inside assets and scratch; rm is scoped by the command policy hook.
    permissions: [{ action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "deny" },
      { action: "read", resource: "*.env.*", effect: "deny" },
      { action: "read", resource: "*/.config/opencode/*", effect: "deny" },
      { action: "read", resource: "/etc/threadsite/*", effect: "deny" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
      { action: "list", resource: "*", effect: "allow" },
      { action: "edit", resource: "site/assets/**", effect: "allow" },
      { action: "edit", resource: "*/site/assets/**", effect: "allow" },
      { action: "edit", resource: "scratch/**", effect: "allow" },
      { action: "edit", resource: "*/scratch/**", effect: "allow" },
      { action: "asset_save", resource: "*", effect: "allow" },
      { action: "asset_preview", resource: "*", effect: "allow" },
      { action: "asset_download", resource: "*", effect: "allow" },
      { action: "asset_import", resource: "*", effect: "allow" },
      { action: "websearch", resource: "*", effect: "allow" },
      { action: "webfetch", resource: "*", effect: "allow" },
      { action: "threadsite_browser", resource: "*", effect: "allow" },
      { action: "playwright_*", resource: "*", effect: "allow" },
      { action: "playwright.*", resource: "*", effect: "allow" },
      // Read-only inspection and comparison utilities mirror the builder's
      // root policy so asset review (sizes, atlas maps, regen diffs, palette
      // greps) never dies on a denial; git, npm, curl and friends stay absent.
      ...["node", "node *", "ls", "ls *", "file", "file *", "wc", "wc *", "head *", "tail *",
        "grep", "grep *", "rg", "rg *", "cat", "cat *", "sed -n *", "sort", "sort *", "cut", "cut *",
        "tr", "tr *", "uniq", "uniq *", "diff", "diff *", "basename", "basename *", "dirname", "dirname *",
        "test", "test *", "stat *", "pwd", "find site *", "find scratch *",
        "mkdir *", "cp *", "mv *", "echo", "echo *", "unzip *", "tar *",
        "rm", "rm *", "which *", "ffmpeg *", "ffprobe *", "gltfpack *", "svg2png *",
        "cd", "cd *"]
        .map((resource) => ({ action: "shell", resource, effect: "allow" })),
      // Credential paths the creator's read/grep/node commands must not touch;
      // last match wins, so these override every shell allow above.
      ...["*/.config/opencode/*", "*/etc/threadsite/*", "*/proc/*environ*", "*$HOME*", "*${HOME}*", "*~/*"]
        .map((resource) => ({ action: "shell", resource, effect: "deny" }))],
  };

  config.websearch = websearchSelection(env);
  config.plugins = [{ package: pluginPath, options: { lsp: lspSettings(config.lsp), browserQaModel,
    assetModel: assetAgent.model === false ? false : assetAgent.model,
    assetFallbacks: assetAgent.fallbacks,
    // The prompt hook re-applies this profile to asset-forge children so an
    // inherited text-parent browser denial cannot strip their browser access.
    assetPermissions: config.agents["asset-forge"]?.permissions ?? [],
    contextCaps: config.contextCaps ?? {} } }];
  delete config.contextCaps;
  config.mcp.servers.context7 = {
    type: "remote", url: "https://mcp.context7.com/mcp", oauth: false, codemode: false,
    disabled: env.CONTEXT7_ENABLED === "0",
    ...(env.CONTEXT7_API_KEY?.trim() ? { headers: { Authorization: "Bearer " + env.CONTEXT7_API_KEY.trim() } } : {}),
    timeout: { startup: 5000, catalog: 5000, execution: 30000 },
  };
  return config;
}

const websearchProviders = new Set(["exa", "firecrawl", "parallel", "tavily", "tinyfish"]);

// The asset-forge agent exists by default and inherits the parent's selected
// model; operators may pin a model, list fallbacks for text-only selections,
// or remove the agent entirely.
const assetOffWords = new Set(["off", "disable", "disabled", "false", "none"]);

function assetSelection(env) {
  const modelRef = (value, name) => {
    const trimmed = value.trim();
    if (!/^[^\s/]+\/\S+$/.test(trimmed)) throw new Error(`${name} must use provider/model-id format.`);
    return trimmed;
  };
  const fallbacks = (env.OPENCODE_ASSET_FALLBACK_MODELS ?? "").split(",")
    .map((entry) => entry.trim()).filter(Boolean)
    .map((entry) => modelRef(entry, "OPENCODE_ASSET_FALLBACK_MODELS"));
  const model = (env.OPENCODE_ASSET_MODEL ?? "").trim();
  if (!model) return { model: undefined, fallbacks };
  if (assetOffWords.has(model.toLowerCase())) return { model: false, fallbacks };
  return { model: modelRef(model, "OPENCODE_ASSET_MODEL"), fallbacks };
}

// Without a pre-selected provider OpenCode asks a first-use consent form, which
// the question flow would surface to Discord users who cannot pick a provider
// or supply its credentials. Select it here instead.
function websearchSelection(env) {
  const provider = (env.OPENCODE_WEBSEARCH_PROVIDER ?? "").trim().toLowerCase() || "exa";
  if (["off", "disable", "disabled", "false", "none"].includes(provider)) return false;
  if (provider !== "random" && !websearchProviders.has(provider)) {
    throw new Error("OPENCODE_WEBSEARCH_PROVIDER must be exa, firecrawl, parallel, tavily, tinyfish, random or off (default: exa).");
  }
  return { provider };
}

function lspSettings(lsp) {
  if (!lsp) return false;
  const result = structuredClone(lsp);
  if (result.typescript && !result.typescript.disabled) {
    // Workspaces have no tsconfig; match the lenient ES2022 compiler gate.
    result.typescript.initialization = { ...result.typescript.initialization,
      disableAutomaticTypingAcquisition: true,
      implicitProjectConfiguration: { target: "ES2022", module: "ESNext", checkJs: false,
        strictNullChecks: false, strictFunctionTypes: false },
    };
  }
  return result;
}
