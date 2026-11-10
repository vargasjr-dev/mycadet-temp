/**
 * Plain helper functions and constants for doctor session lifecycle.
 *
 * No hooks — mutations use the generated HeyAPI hooks directly in the
 * component. This module holds only fire-and-forget cleanup and shared
 * constants that multiple consumers reference.
 */

import { doctorSessionsDestroy } from "./doctor-api";
import { captureError } from "@app/lib/error-reporting/capture-error";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DOCTOR_GREETING =
  "Hi! I'm the Doctor. State the nature of the issue you're experiencing with your assistant and I'll help diagnose and fix it.";

export const APPROVAL_RESPONSES = new Set([
  "approve",
  "approve all exec",
  "approve all future exec commands",
  "approve_all_exec",
  "deny",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fire-and-forget server-side cleanup for a doctor session. */
export function cleanupServerSession(sessionId: string): void {
  doctorSessionsDestroy({
    path: { session_id: sessionId },
  }).catch((err) => captureError(err, { context: "doctor_cleanup_destroy" }));
}
