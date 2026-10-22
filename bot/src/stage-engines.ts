/**
 * Build-time CLI for the engine seed payload: stages the exact files and
 * directories the workspace seeder reads (three, excalibur, @dimforge/rapier3d-
 * compat, three-mesh-bvh, and their declarations) out of the bot's full
 * node_modules into a standalone tree. The production Dockerfile runs this
 * in its build stage and copies the result, so the runtime image carries
 * neither full engine trees nor a hand-maintained prune list — the engines.ts
 * spec is the single source of truth, and a spec that outlives an installed
 * package layout fails the build here. Dev checkouts and tests never need
 * it: the seeder reads node_modules when engine-seed/ is absent.
 *
 * Run from bot/ (after npm run build): node dist/stage-engines.js [target]
 */
import { stageEngineSeed } from "./engines.js";

const target = process.argv[2] ?? "engine-seed";
const staged = await stageEngineSeed(target);
console.log(`Staged ${staged.length} engine package(s) into ${target}: ${staged.join(", ")}`);
