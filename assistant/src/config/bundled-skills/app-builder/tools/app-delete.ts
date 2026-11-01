import * as appStore from "../../../../apps/app-store.js";
import { throwIfCancelled } from "../../../../plugin-api/tool-cancellation.js";
import { executeAppDelete } from "../../../../tools/apps/executors.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  throwIfCancelled(context);
  return executeAppDelete({ app_id: input.app_id as string }, appStore);
}
