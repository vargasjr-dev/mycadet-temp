import { throwIfCancelled } from "../../../../plugin-api/tool-cancellation.js";
import type { AppUpdateInput } from "../../../../tools/apps/executors.js";
import { executeAppUpdate } from "../../../../tools/apps/executors.js";
import {
  missingAppIdError,
  resolveAppId,
} from "../../../../tools/apps/resolve-app-id.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { bundledAppStore } from "../app-store-adapter.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const appId = resolveAppId(input, context.conversationId);
  if (!appId) {
    return missingAppIdError();
  }
  throwIfCancelled(context);
  return executeAppUpdate(
    { ...input, app_id: appId } as unknown as AppUpdateInput,
    bundledAppStore,
  );
}
