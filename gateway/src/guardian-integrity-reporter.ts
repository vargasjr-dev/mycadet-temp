// Fail-loud reporting for guardian-integrity failures: a gateway DB that has
// lost its guardian rows while carrying evidence of prior onboarding
// (`gateway_guardian_missing`, see auth/guardian-integrity.ts) and a refused
// cadet-guardian mint (`gateway_guardian_mint_refused`, see
// auth/guardian-bootstrap.ts). Emits an error-level log, rate-limited per
// check per process (both states are sticky until repair, so every verdict
// or mint attempt would otherwise re-fire them).

import { getLogger } from "./logger.js";

const log = getLogger("guardian-integrity-reporter");

// At most one report per check per hour per process.
const REPORT_INTERVAL_MS = 60 * 60 * 1000;

const lastReportAtByKey = new Map<string, number>();

/**
 * Report the missing-guardian state: a rate-limited error log. Fires on the
 * first detection per process and at most hourly thereafter (the state is
 * sticky until the guardian is re-seeded, so every verdict would otherwise
 * re-fire it). Fire-and-forget — never throws, never blocks the caller.
 */
export function reportMissingGuardian(detail: Record<string, unknown>): void {
  report(
    "gateway_guardian_missing",
    "gateway DB has no guardian rows but evidence of prior onboarding — " +
      "trust verdicts will fail closed until the guardian is re-seeded",
    detail,
  );
}

/**
 * Report a refused cadet-guardian mint: a rate-limited error log. Same
 * per-check rate limiting and fire-and-forget semantics as
 * {@link reportMissingGuardian}; the sibling check distinguishes the
 * cadet-binding-lost-but-contact-intact refusal, which the missing-guardian
 * state check cannot see.
 */
export function reportGuardianMintRefused(
  detail: Record<string, unknown>,
): void {
  report(
    "gateway_guardian_mint_refused",
    "refused to mint a cadet guardian principal over evidence of a prior " +
      "guardian — clients get guardian_repair_required until re-pair",
    detail,
  );
}

function report(
  check: string,
  message: string,
  detail: Record<string, unknown>,
): void {
  const now = Date.now();
  const last = lastReportAtByKey.get(check) ?? Number.NEGATIVE_INFINITY;
  if (now - last < REPORT_INTERVAL_MS) return;
  lastReportAtByKey.set(check, now);
  log.error({ check, ...detail }, message);
}
