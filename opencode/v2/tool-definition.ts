/** Guarded tool definitions registered by the native runtime plugin. */
import { z } from "zod";

/** OpenCode tool-result content: text, or a file the runtime can hand to the
 * model as vision input (data URLs for images are normalized and resized). */
export type ToolResultPart =
  | { type: "text"; text: string }
  | { type: "file"; uri: string; mime: string; name?: string };

interface ToolDefinition<Args extends z.ZodRawShape> {
  description: string;
  args: Args;
  execute(args: z.infer<z.ZodObject<Args>>, context: { directory: string }): Promise<string | ToolResultPart[]>;
}

export const tool = Object.assign(<Args extends z.ZodRawShape>(definition: ToolDefinition<Args>) => definition, { schema: z });
