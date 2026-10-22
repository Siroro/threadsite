// Build-time bridge for the existing, independently guarded tool definitions.
// Neither the v1 plugin API nor its runtime is loaded into OpenCode 2.
import { z } from "zod";
export const tool = Object.assign((definition: unknown) => definition, { schema: z });
