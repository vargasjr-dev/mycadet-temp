/**
 * URL registry for the docs app: only what docs pages consume.
 * Internal paths are typedRoutes-verified at each Link callsite;
 * app destinations are cross-app absolute URLs.
 */

import { WWW_DOMAIN } from "@/lib/domains";

export const routes = {
  docs: {
    legal: {
      privacyPolicy: "/docs/privacy-policy",
      termsOfUse: "/docs/terms-of-use",
      prohibitedUse: "/docs/prohibited-use",
      privacyAndData: "/docs/trust-security/privacy-and-data",
    },
  },

  // Cross-app destinations served by other Cadet apps.
  signup: `https://${WWW_DOMAIN}/account/signup`,
  login: `https://${WWW_DOMAIN}/account/login`,
  assistant: `https://${WWW_DOMAIN}/assistant`,
  plugins: `https://${WWW_DOMAIN}/plugins`,
  downloads: `https://${WWW_DOMAIN}/downloads`,
  iosAppStore: "https://apps.apple.com/us/app/mycadet/id6759934423",
  androidPlayStore:
    "https://play.google.com/store/apps/details?id=ai.mycadet.android",
  chromeWebStore:
    "https://chromewebstore.google.com/detail/mycadet-browser/hphbdmpffeigpcdjkckleobjmhhokpne",
} as const;
