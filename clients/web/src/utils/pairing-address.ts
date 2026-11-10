/**
 * The copy shared by the surfaces that refuse a pairing address: the settings
 * "Pair a device" card and the dialogs built on it.
 *
 * `@mycadet/service-contracts/remote-web-pairing` owns the link format and
 * the rejection reasons. This module adds the piece those surfaces would
 * otherwise each rebuild: the catalog copy for a base that cannot be one.
 * (The links themselves are the gateway's — the web bundle renders no pair
 * route and builds none since the pairing page moved to the app shell.)
 */

import {
  tunnelProviderWebsiteName,
  type PublicBaseUrlRejection,
} from "@mycadet/service-contracts/remote-web-pairing";

import { t } from "@/i18n";

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
 * Whether an untyped value off a host seam is a reason this module can render.
 */
export function isPublicBaseUrlRejection(
  value: unknown,
): value is PublicBaseUrlRejection {
  return typeof value === "string" && Object.hasOwn(REJECTIONS, value);
}

/**
 * Inline validation message for each rejection reason. `value` is the raw input
 * that was rejected, used to name the specific vendor for a service-website URL.
 */
export function publicBaseUrlRejectionMessage(
  reason: PublicBaseUrlRejection,
  value?: string,
): string {
  switch (reason) {
    case "unparseable":
      return t("settings:pairDeviceUrl.unparseable");
    case "loopback":
      return t("settings:pairDeviceUrl.loopback");
    case "private-address":
      return t("settings:pairDeviceUrl.privateAddress");
    case "non-https":
      return t("settings:pairDeviceUrl.nonHttps");
    case "service-website": {
      const service =
        (value && tunnelProviderWebsiteName(value)) ||
        t("settings:pairDeviceUrl.serviceFallbackName");
      return t("settings:pairDeviceUrl.serviceWebsite", { service });
    }
  }
}
