// Stable application boundary. The legacy server and SDK remain available while
// the native v2 implementation is validated against real deployments.
import { config } from "./config.js";
import { OpenCodeHarness as LegacyOpenCodeHarness } from "./opencode-v1.js";
import { OpenCodeV2Harness } from "./opencode-v2.js";

export * from "./opencode-v1.js";
export { LegacyOpenCodeHarness, OpenCodeV2Harness };
export type OpenCodeHarness = Pick<LegacyOpenCodeHarness, keyof LegacyOpenCodeHarness>;
export const OpenCodeHarness = config.opencodeApiVersion === "v2" ? OpenCodeV2Harness : LegacyOpenCodeHarness;
