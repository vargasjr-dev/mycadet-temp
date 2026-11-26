import type { VellumMigrationProbe } from "@mycadet/ipc-contract";

const DISMISSED_KEY = "vellum.offer.dismissed-session";

/**
 * The desktop shell's one-time vellum migration offer. There is no offer
 * card to click: the startup screen detects a pending vellum root and
 * navigates straight to the migration screen. A decline or a failed run
 * marks the session, so the offer waits for the next launch — the
 * persistent "don't ask again" is the consent screen's checkbox, which
 * the engine records on decline.
 */
export const dismissVellumOfferForSession = (): void => {
  try {
    sessionStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Session storage unavailable — the offer simply returns next mount.
  }
};

const offerDismissedForSession = (): boolean => {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
};

/** The pending migration offer, or null when there is nothing to offer. */
export const detectVellumOffer = (): Promise<VellumMigrationProbe | null> => {
  const bridge = window.cadet?.vellumMigration;
  if (!bridge || offerDismissedForSession()) {
    return Promise.resolve(null);
  }
  return bridge
    .get()
    .then((probe) => (probe.status === "offer" ? probe : null))
    .catch(() => null);
};
