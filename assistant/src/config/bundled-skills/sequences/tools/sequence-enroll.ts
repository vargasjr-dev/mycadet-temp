import { throwIfCancelled } from "../../../../plugin-api/tool-cancellation.js";
import { enrollContact, getSequence } from "../../../../sequence/store.js";
import { isAbortLikeError } from "../../../../tools/shared/abort.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { isPlainObject } from "../../../../util/object.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  toolContext: ToolContext,
): Promise<ToolExecutionResult> {
  const sequenceId = input.sequence_id;
  const emails = input.emails;
  const context = isPlainObject(input.context) ? input.context : undefined;

  if (typeof sequenceId !== "string" || !sequenceId) {
    return err("sequence_id is required.");
  }
  if ((!Array.isArray(emails) && typeof emails !== "string") || !emails) {
    return err("emails is required (string or array).");
  }
  throwIfCancelled(toolContext);

  try {
    const seq = getSequence(sequenceId);
    if (!seq) {
      return err(`Sequence not found: ${sequenceId}`);
    }

    // Support comma-separated string or array
    const emailList = Array.isArray(emails)
      ? emails.filter((email): email is string => typeof email === "string")
      : emails
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean);

    if (emailList.length === 0) {
      return err("No valid emails provided.");
    }

    const results: string[] = [];
    let successCount = 0;
    for (const email of emailList) {
      try {
        const enrollment = enrollContact({
          sequenceId,
          contactEmail: email,
          context,
        });
        results.push(`  ${email} - enrolled (ID: ${enrollment.id})`);
        successCount++;
      } catch (e) {
        // A cancelled turn is not an enrollment failure: let it reach the executor's
        // abort handling instead of being rendered as a tool error.
        if (isAbortLikeError(e)) {
          throw e;
        }
        results.push(
          `  ${email} - failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    return ok(
      `Enrolled ${successCount}/${emailList.length} contact(s) in "${
        seq.name
      }":\n${results.join("\n")}`,
    );
  } catch (e) {
    // A cancelled turn is not an enrollment failure: let it reach the executor's
    // abort handling instead of being rendered as a tool error.
    if (isAbortLikeError(e)) {
      throw e;
    }
    return err(e instanceof Error ? e.message : String(e));
  }
}
