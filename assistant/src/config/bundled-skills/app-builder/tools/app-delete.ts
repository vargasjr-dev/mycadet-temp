import { throwIfCancelled } from "../../../../plugin-api/tool-cancellation.js";
import { executeAppDelete } from "../../../../tools/apps/executors.js";
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
  return executeAppDelete({ app_id: input.app_id as string }, bundledAppStore);
}
