import { z } from "zod";

import { throwIfCancelled } from "../../../../plugin-api/tool-cancellation.js";
import { executeAppCreate } from "../../../../tools/apps/executors.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  throwIfCancelled(context);
  const createInput = z
    .object({
      name: z.string().default("").catch(""),
      description: z.string().optional(),
      schema_json: z.string().optional(),
      html: z.unknown(),
      pages: z.unknown(),
      icon: z.unknown(),
      auto_open: z.boolean().optional(),
      preview: z.record(z.string(), z.unknown()).optional(),
      source_files: z.record(z.string(), z.string()).optional(),
    })
    .safeParse(input);
  if (!createInput.success) {
    return { content: createInput.error.message, isError: true };
  }
  return executeAppCreate(
    createInput.data,
    context.proxyToolResolver,
    context.conversationId,
  );
}
