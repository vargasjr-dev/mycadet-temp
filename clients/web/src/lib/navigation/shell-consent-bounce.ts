import { hardNavigate } from "@/lib/auth/hard-navigate";

/**
 * Whether a resolver redirect target leaves this bundle: the consent screen
 * lives in the app bundle's /account/consent route, outside web's route
 * table. A client-side router redirect would splat there, so those bounces
 * ride a full-page navigation — the return trip boots fresh and re-reads the
 * shell-written acks.
 */
export function isCrossBundleRedirect(to: string): boolean {
  return to.startsWith("/account/");
}

/**
 * Full-page navigation for a cross-bundle resolver redirect. Returns false
 * when the target is in-bundle and the caller should redirect client-side.
 */
export function hardNavigateIfCrossBundle(to: string): boolean {
  if (!isCrossBundleRedirect(to)) {
    return false;
  }
  hardNavigate(to);
  return true;
}
