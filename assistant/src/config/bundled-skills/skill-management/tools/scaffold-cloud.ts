import { executeScaffoldCloudSkill } from "../../../../tools/skills/scaffold-cloud.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeScaffoldCloudSkill(input, context);
}
