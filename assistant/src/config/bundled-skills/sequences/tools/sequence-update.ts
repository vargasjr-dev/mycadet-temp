import { throwIfCancelled } from "../../../../plugin-api/tool-cancellation.js";
import {
  exitEnrollment,
  getEnrollment,
  getSequence,
  pauseEnrollment,
  resumeEnrollment,
  updateSequence,
} from "../../../../sequence/store.js";
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
  const id = input.id;
  const enrollmentId = input.enrollment_id;
  const enrollmentAction = input.enrollment_action;

  throwIfCancelled(context);

  // ── Enrollment-level lifecycle actions ──────────────────────────────
  if (typeof enrollmentId === "string" && enrollmentId) {
    if (typeof enrollmentAction !== "string" || !enrollmentAction) {
      return err(
        "enrollment_action is required when enrollment_id is provided.",
      );
    }

    try {
      const enrollment = getEnrollment(enrollmentId);
      if (!enrollment) {
        return err(`Enrollment not found: ${enrollmentId}`);
      }

      switch (enrollmentAction) {
        case "pause": {
          if (enrollment.status !== "active") {
            return err(
              `Enrollment is not active (status: ${enrollment.status}).`,
            );
          }
          pauseEnrollment(enrollmentId);
          return ok(
            `Enrollment ${enrollmentId} paused. Resume it later to continue from step ${
              enrollment.currentStep + 1
            }.`,
          );
        }
        case "resume": {
          if (enrollment.status !== "paused") {
            return err(
              `Enrollment is not paused (status: ${enrollment.status}).`,
            );
          }
          const seq = enrollment.sequenceId
            ? getSequence(enrollment.sequenceId)
            : null;
          if (seq && seq.status !== "active") {
            return err(
              `Cannot resume enrollment - parent sequence "${seq.name}" is ${seq.status}. Resume the sequence first.`,
            );
          }
          resumeEnrollment(enrollmentId);
          return ok(`Enrollment ${enrollmentId} resumed.`);
        }
        case "cancel": {
          if (
            enrollment.status !== "active" &&
            enrollment.status !== "paused"
          ) {
            return ok(
              `Enrollment already in terminal state: ${enrollment.status}`,
            );
          }
          exitEnrollment(enrollmentId, "cancelled");
          return ok(`Enrollment for ${enrollment.contactEmail} cancelled.`);
        }
        default:
          return err(
            `Unknown enrollment_action: "${enrollmentAction}". Use "pause", "resume", or "cancel".`,
          );
      }
    } catch (e) {
      // A cancelled turn is not an enrollment failure: let it reach the executor's
      // abort handling instead of being rendered as a tool error.
      if (isAbortLikeError(e)) {
        throw e;
      }
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  // ── Sequence-level update ──────────────────────────────────────────
  if (typeof id !== "string" || !id) {
    return err("id is required.");
  }

  const name = typeof input.name === "string" ? input.name : undefined;
  const description =
    typeof input.description === "string" ? input.description : undefined;
  const status = input.status;
  if (
    status !== undefined &&
    status !== "active" &&
    status !== "paused" &&
    status !== "archived"
  ) {
    return err('status must be "active", "paused", or "archived".');
  }
  const exitOnReply =
    typeof input.exit_on_reply === "boolean" ? input.exit_on_reply : undefined;
  const stepsRaw = input.steps;

  try {
    const steps = stepsRaw == null ? undefined : parseSteps(stepsRaw);

    if (steps !== undefined && steps.length === 0) {
      return err(
        "steps must not be empty. A sequence requires at least one step.",
      );
    }

    const updated = updateSequence(id, {
      name,
      description,
      status,
      exitOnReply,
      steps,
    });
    if (!updated) {
      return err(`Sequence not found: ${id}`);
    }

    return ok(`Sequence updated: ${updated.name} (${updated.status})`);
  } catch (e) {
    // A cancelled turn is not a sequence failure: let it reach the executor's
    // abort handling instead of being rendered as a tool error.
    if (isAbortLikeError(e)) {
      throw e;
    }
    return err(e instanceof Error ? e.message : String(e));
  }
}
