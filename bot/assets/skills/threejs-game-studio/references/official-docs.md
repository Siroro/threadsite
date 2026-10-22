<!-- ThreadSite-maintained skill, originally derived from chrislaupama/threejs-game-studio (MIT). ThreadSite context: three.js is preinstalled in this workspace's harness-managed node_modules — import it by its bare name ("three") with full TypeScript types. This workspace has NO npm, NO Vite, NO dev server, and NO project scaffold: author TypeScript under site/src, keep assets under site/assets, and the harness runs the only build (site/src TypeScript -> site/js ESM via esbuild). Map every project-setup/scaffold/build step of this skill onto the existing ThreadSite workspace layout; skip its npm/Vite instructions entirely. Verification happens in a real browser via the preview URL; see AGENTS.md. -->

# Installed API references

ThreadSite supplies three.js 0.186.1, @dimforge/rapier3d-compat 0.21.0 and
three-mesh-bvh 0.9.16. The harness owns their versions, declarations and build.
Read root AGENTS.md and use the installed packages directly.

## Verify an API

1. Inspect the installed package's exports, declarations and source for the
   method, constructor or renderer feature you need.
2. Use official documentation and examples that match those installed APIs.
3. Run the project's required type check and exercise the behavior in preview
   when browser tools are available.

Do not infer an API from a package's name or copy a remembered signature.
Rendering backends, shader systems, addons and async initialization have
separate contracts. Keep a single renderer path and inspect its actual types
before composing features.

## Sources

- [Three.js documentation](https://threejs.org/docs/)
- [Three.js manual](https://threejs.org/manual/)
- [Three.js source](https://github.com/mrdoob/three.js)
- [Rapier JavaScript guide](https://rapier.rs/docs/user_guides/javascript/)
- [three-mesh-bvh source](https://github.com/gkjohnson/three-mesh-bvh)

The installed runtime and declarations determine what can ship. Live examples
are useful references, and must still pass the project's own build and checks.
