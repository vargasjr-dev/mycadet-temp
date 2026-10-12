/**
 * In-memory cache of the cloud owner's diagnostics consent.
 *
 * One value is cached from the owner-consent fetch:
 *  - `share_diagnostics`: gates crash diagnostics (read by the client
 *    diagnostics reporting).
 *
 * Hot-path gates (the client diagnostics consent check) need a synchronous,
 * I/O-free read, so this module owns the value and refreshes it periodically
 * in the background. Consent is opt-out — an owner who never made an explicit
 * choice reports as consented (the client maps a never-chose wire value to
 * `true`).
 *
 * The cached value is tri-state: `true`/`false` are confirmed states from a
 * successful cloud fetch; `"unknown"` means no confirmed state exists — boot
 * before the first refresh, no cloud session, or no resolvable owner
 * identity. A transient fetch failure keeps the previous value so a known
 * opt-in is not flipped mid-session. The diagnostics accessor collapses
 * `"unknown"` to `false` — diagnostics gates are deliberately fail-closed, so
 * no raw diagnostics accessor exists.
 */

import { getLogger } from "../util/logger.js";
import { CadetCloudClient } from "./client.js";

const log = getLogger("consent-cache");

const REFRESH_INTERVAL_MS = 5 * 60_000; // refresh consent every 5 min

/** Cached consent value: a confirmed boolean, or `"unknown"` when no confirmed state exists. */
export type ConsentState = boolean | "unknown";

let cachedShareDiagnostics: ConsentState = "unknown"; // no confirmed state until first success
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Synchronous hot-path accessor for the `share_diagnostics` consent (read
 * by the client's diagnostics consent check). Never does I/O; returns `false` unless a successful
 * refresh confirmed an opt-in (`"unknown"` reads as `false`). Because every
 * crash report re-reads this, a mid-session opt-out is honored within one
 * refresh cycle.
 */
export function getCachedShareDiagnostics(): boolean {
  return cachedShareDiagnostics === true;
}

/**
 * Refresh the cached consent from the cloud.
 *
 * No platform session / features disabled (`create()` is null) → `"unknown"`.
 * No resolvable assistant identity (no owner whose consent we can attest to) →
 * `"unknown"` — losing the owner mapping is not an opt-out, but it also isn't
 * a confirmed opt-in, so we stop riding a stale one. A successful fetch adopts
 * the reported values. A `null` fetch (transient failure / undeployed
 * endpoint) leaves the previous values unchanged so a known opt-in is not
 * flipped off mid-session.
 */
export async function refreshConsentCache(): Promise<void> {
  const client = await CadetCloudClient.create();
  if (!client) {
    resetConsentToUnknown();
    return;
  }

  // No resolvable owner identity → unknown (don't ride a stale opt-in).
  if (!client.cloudAssistantId) {
    resetConsentToUnknown();
    return;
  }

  const consent = await client.getOwnerConsent();
  if (consent) {
    setCachedShareDiagnostics(consent.shareDiagnostics);
  }
}

function resetConsentToUnknown(): void {
  setCachedShareDiagnostics("unknown");
}

function setCachedShareDiagnostics(value: ConsentState): void {
  if (value !== cachedShareDiagnostics) {
    log.debug(
      { from: cachedShareDiagnostics, to: value },
      "share_diagnostics consent changed",
    );
    cachedShareDiagnostics = value;
  }
}

/**
 * Begin periodic consent refresh. Idempotent — a second call is a no-op while a
 * timer is already running. Runs one immediate refresh, then every 5 minutes.
 */
export function startConsentRefresh(): void {
  if (refreshTimer) {
    return;
  }

  refreshConsentCache().catch((err) => {
    log.debug({ err }, "initial consent refresh failed");
  });
  refreshTimer = setInterval(() => {
    refreshConsentCache().catch((err) => {
      log.debug({ err }, "consent refresh failed");
    });
  }, REFRESH_INTERVAL_MS);
}

/** Stop periodic consent refresh and clear the timer. */
export async function stopConsentRefresh(): Promise<void> {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/** Test-only: override the cached diagnostics value without going through a refresh. */
export function __setCachedShareDiagnosticsForTest(value: ConsentState): void {
  cachedShareDiagnostics = value;
}
