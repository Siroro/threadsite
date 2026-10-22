<!-- ThreadSite-maintained skill, originally derived from chrislaupama/threejs-game-studio (MIT). ThreadSite context: three.js is preinstalled in this workspace's harness-managed node_modules — import it by its bare name ("three") with full TypeScript types. This workspace has NO npm, NO Vite, NO dev server, and NO project scaffold: author TypeScript under site/src, keep assets under site/assets, and the harness runs the only build (site/src TypeScript -> site/js ESM via esbuild). Map every project-setup/scaffold/build step of this skill onto the existing ThreadSite workspace layout; skip its npm/Vite instructions entirely. Verification happens in a real browser via the preview URL; see AGENTS.md. -->

## Contents

- Linear workflow checklist
- Tone-mapping starting points
- WebGL OutputPass ordering
- WebGPU RenderOutputNode ordering
- Verification

Physically based lighting produces scene-referred HDR values. Choose the output
transform as part of the art direction, then apply tone mapping and color-space
conversion exactly once.

## Linear Workflow Checklist

1. Display output → `renderer.outputColorSpace = THREE.SRGBColorSpace`
2. Albedo/base-color and emissive textures → `THREE.SRGBColorSpace`
3. Normal, roughness, metalness, AO, displacement, masks → `NoColorSpace`
4. Actual linear color data, such as compatible HDR color textures →
 `LinearSRGBColorSpace` or the loader-provided linear annotation
5. Pick and capture-test one tone mapper and exposure for the art direction
6. In WebGL post: linear/HDR effects → `OutputPass` → FXAA or any other pass
 requiring display-referred sRGB input
7. Use half-float linear intermediates when the post path needs HDR range; do
 not blindly pay that bandwidth cost for every direct-display path

Do not call generic non-color maps “linear textures”: `NoColorSpace` means the
texels are data and must not receive a color-space conversion.

## Tone-Mapping Starting Points

These are skill recommendations to test, not official declarations that one
operator is universally best.

| Operator | Useful starting point | Watch |
| --- | --- | --- |
| `ACESFilmicToneMapping` | Cinematic lit PBR scaffold | Strong film response can reshape saturated highlights |
| `AgXToneMapping` | High-dynamic lighting and a softer shoulder | Recheck authored contrast and emissive hierarchy |
| `NeutralToneMapping` | UI-adjacent 3D, product, or restrained looks | Milder remap can leave highlight control to lighting |
| `NoToneMapping` | Explicit untonemapped debug or intentionally LDR output | Not a neutral substitute for an HDR art-direction decision |

```ts
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
```

## WebGL Post Path

`OutputPass` reads `renderer.toneMapping`, `toneMappingExposure`, and
`outputColorSpace`. Keep those renderer properties as the configuration source;
do not disable them merely because a composer is active, and do not add another
output conversion. Update an FXAA pass's inverse-resolution uniform from the
actual drawing-buffer size.

`material.toneMapped = false` is ignored when rendering into a render target,
using post-processing, or using `WebGPURenderer`. Put display-referred UI after
the output transform when supported, use a DOM overlay, or author it for the
selected output chain.

## WebGPU Path

`RenderPipeline` applies the output transform automatically. For an effect such
as FXAA that must run afterward, take explicit ownership with `renderOutput()`:

## Verification

- Compare ACES / AgX / Neutral on the same lit scene at fixed exposure.
- Inspect neutral gray, saturated color, matte dielectric, metal, skin/organic
 material where relevant, emissive cues, and bright UI reference values.
- Capture the processed and post-disabled paths; check for missing or duplicate
 sRGB conversion.
- Record operator, exposure, intermediate type, output owner, and any
 display-referred passes after conversion.
