import { throwIfCancelled } from "../../../../plugin-api/tool-cancellation.js";
import type { AppCreateInput } from "../../../../tools/apps/executors.js";
import { executeAppCreate } from "../../../../tools/apps/executors.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { bundledAppStore } from "../app-store-adapter.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  throwIfCancelled(context);
  const createInput: AppCreateInput = input as unknown as AppCreateInput;
  return executeAppCreate(
    createInput,
    bundledAppStore,
    context.proxyToolResolver,
    context.conversationId,
  );
}
