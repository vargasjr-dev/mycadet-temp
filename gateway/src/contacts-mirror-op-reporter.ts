// Fail-loud reporting for a daemon that rejects a typed contacts mirror op
// with "Unknown method" (old daemon behind a newer gateway). The mirror ops
// deliberately have no raw-SQL fallback, so the gateway write has already
// applied while the assistant mirror silently missed it — divergence persists
// until reconciliation. Emits an error-level log, rate-limited per op per
// process (the state is sticky until the daemon updates, so every op would
// otherwise re-fire it).

import { getLogger } from "./logger.js";

const log = getLogger("contacts-mirror-op-reporter");

// At most one report per op per hour per process.
const REPORT_INTERVAL_MS = 60 * 60 * 1000;

const lastReportAtByKey = new Map<string, number>();

/**
 * True when a daemon IPC failure is the IPC server's unknown-method rejection
 * (`error: "Unknown method: <m>"`, surfaced by ipcCallAssistant as an
 * IpcTransportError carrying that message verbatim).
 */
export function isUnknownIpcMethodError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("Unknown method:");
}

/**
 * Report a mirror op the daemon doesn't implement: a rate-limited error log.
 * Fire-and-forget — never throws, never blocks the caller.
 */
export function reportMirrorOpMissing(
  op: string,
  detail: Record<string, unknown>,
): void {
  const now = Date.now();
  const last = lastReportAtByKey.get(op) ?? Number.NEGATIVE_INFINITY;
  if (now - last < REPORT_INTERVAL_MS) return;
  lastReportAtByKey.set(op, now);
  log.error(
    { op, ...detail },
    "daemon does not implement this contacts mirror op — gateway write applied " +
      "without the assistant mirror (divergence until the daemon updates)",
  );
}
