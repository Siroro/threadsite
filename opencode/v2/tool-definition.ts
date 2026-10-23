/** Guarded tool definitions registered by the native runtime plugin. */
import { z } from "zod";

interface ToolDefinition<Args extends z.ZodRawShape> {
  description: string;
  args: Args;
  execute(args: z.infer<z.ZodObject<Args>>, context: { directory: string }): Promise<string>;
}

export const tool = Object.assign(<Args extends z.ZodRawShape>(definition: ToolDefinition<Args>) => definition, { schema: z });
