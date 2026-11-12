// The esbuild flags preview compilation shares with the production bundle in
// bot/src/build.ts (the canonical home). Only the containment plugins,
// absWorkingDir/entryPoints/outdir/outbase and `write` differ between the two
// callers. The preview image ships without bot/, so this is a mirrored copy —
// bot/test/esbuild-parity.test.ts deep-compares it against bot/src/build.ts
// and fails when the two drift.
export const SHARED_BUNDLE_FLAGS = {
  bundle: true,
  format: "esm",
  splitting: true,
  target: "es2022",
  // Vendored libraries carry MIT banners; keep them in the output.
  legalComments: "eof",
  sourcemap: false,
  minify: true,
  metafile: true,
  logLevel: "silent",
  chunkNames: "chunks/[name]-[hash]",
  assetNames: "assets/[name]-[hash]",
  // Models join the other media imports: importing a .glb/.gltf binds the
  // emitted, hashed asset URL, so glTF loading needs no hand-built paths.
  loader: { ".glb": "file", ".gltf": "file" },
  preserveSymlinks: true,
};
