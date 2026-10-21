/**
 * The pairing address, shared by the surfaces that produce or refuse one:
 * the chooser's "Add a remote assistant" dialog and the switch-to-origin
 * navigation.
 *
 * `@mycadet/service-contracts/remote-web-pairing` owns the link format and
 * the rejection reasons. This module adds the two app-level pieces those
 * surfaces would otherwise each rebuild: the pair route a public base has
 * to carry to become a link, and the catalog copy for a base that cannot
 * be one.
 */

import {
  buildRemoteWebPairingUrl,
  normalizePairingBaseUrl,
  tunnelProviderWebsiteName,
  type PublicBaseUrlRejection,
} from "@mycadet/service-contracts/remote-web-pairing";

import { t } from "@app/i18n";

/**
 * The remote deployment's pair page — a web-bundle route the app never
 * renders itself, only navigates to. Mirrors web's `routes.remotePair`;
 * exported so `switchToOrigin` can derive the route-relative form the native
 * shells address.
 */
export const REMOTE_PAIR_PATH = "/assistant/pair";

/**
 * The pairing link for an assistant's public base: its pair page with the
 * device code in the fragment, which is what the pair page reads on load
 * and what `parseRemoteWebPairingParams` reads back off a paste. The base
 * is canonicalized first, so a trailing slash or an already-appended app
 * route cannot produce a doubled path. `null` when the base does not parse
 * as a URL at all.
 */
export function pairingLinkForBase(
  base: string,
  deviceCode: string,
): string | null {
  let normalized: string;
  try {
    normalized = normalizePairingBaseUrl(base);
  } catch {
    return null;
  }
  return buildRemoteWebPairingUrl({
    verificationUri: `${normalized}${REMOTE_PAIR_PATH}`,
    deviceCode,
  });
}

/**
 * The address a `connect` deep link asks the dialog to pair with. A link
 * carrying a device code recomposes into the pairing link the local-mode host
 * exchanges outright; a link carrying only a base becomes the bare address,
 * which mints its own approval code. `null` when the link carried no usable
 * base, leaving the dialog nothing to submit.
 */
export function connectAddress(
  url: string | null,
  code: string | null,
): string | null {
  if (url === null) {
    return null;
  }
  if (code === null) {
    return url;
  }
  // The link the user sees in the address field, so it has to be one they can
  // also paste into another device's browser: the base plus the pair route,
  // not the base with a bare fragment hung off it.
  return pairingLinkForBase(url, code) ?? url;
}

/**
 * The reasons {@link publicBaseUrlRejectionMessage} has copy for. A `Record`
 * rather than a list so a reason added to the contract fails to compile here
 * until it has copy.
 */
const REJECTIONS: Record<PublicBaseUrlRejection, true> = {
  unparseable: true,
  loopback: true,
  "private-address": true,
  "non-https": true,
  "service-website": true,
};

/**
 * Whether an untyped value off a host seam is a reason this module can
 * render.
 */
export function isPublicBaseUrlRejection(
  value: unknown,
): value is PublicBaseUrlRejection {
  return typeof value === "string" && Object.hasOwn(REJECTIONS, value);
}

/**
 * Inline validation message for each rejection reason. `value` is the raw
 * input that was rejected, used to name the specific vendor for a
 * service-website URL.
 */
export function publicBaseUrlRejectionMessage(
  reason: PublicBaseUrlRejection,
  value?: string,
): string {
  switch (reason) {
    case "unparseable":
      return t("pairDeviceUrl.unparseable");
    case "loopback":
      return t("pairDeviceUrl.loopback");
    case "private-address":
      return t("pairDeviceUrl.privateAddress");
    case "non-https":
      return t("pairDeviceUrl.nonHttps");
    case "service-website": {
      const service =
        (value && tunnelProviderWebsiteName(value)) ||
        t("pairDeviceUrl.serviceFallbackName");
      return t("pairDeviceUrl.serviceWebsite", { service });
    }
  }
}
