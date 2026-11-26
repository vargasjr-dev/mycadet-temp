import { throwIfCancelled } from "../../../../plugin-api/tool-cancellation.js";
import { createSequence } from "../../../../sequence/store.js";
import { isAbortLikeError } from "../../../../tools/shared/abort.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";
import { parseSteps } from "./steps.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const name = input.name;
  const channel = input.channel;
  const stepsRaw = input.steps;
  const description =
    typeof input.description === "string" ? input.description : undefined;
  const exitOnReply =
    typeof input.exit_on_reply === "boolean" ? input.exit_on_reply : undefined;

  if (typeof name !== "string" || !name) {
    return err("name is required.");
  }
  if (typeof channel !== "string" || !channel) {
    return err("channel is required.");
  }
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    return err("steps array is required and must have at least one step.");
  }

  throwIfCancelled(context);

  try {
    const steps = parseSteps(stepsRaw);

    const sequence = createSequence({
      name,
      channel,
      steps,
      description,
      exitOnReply,
    });
    return ok(
      `Sequence created (ID: ${sequence.id}).\n\nName: ${sequence.name}\nChannel: ${sequence.channel}\nSteps: ${steps.length}\nExit on reply: ${sequence.exitOnReply}\nStatus: ${sequence.status}`,
    );
  } catch (e) {
    // A cancelled turn is not a sequence failure: let it reach the executor's
    // abort handling instead of being rendered as a tool error.
    if (isAbortLikeError(e)) {
      throw e;
    }
    return err(e instanceof Error ? e.message : String(e));
  }
}
