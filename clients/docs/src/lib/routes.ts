/**
 * URL registry for the docs app: only what docs pages consume.
 * Internal paths are typedRoutes-verified at each Link callsite;
 * app destinations are cross-app absolute URLs.
 */

import { APEX_ORIGIN } from "@/lib/domains";

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
  signup: `https://${APEX_ORIGIN}/account/signup`,
  login: `https://${APEX_ORIGIN}/account/login`,
  assistant: `https://${APEX_ORIGIN}/assistant`,
  plugins: `https://${APEX_ORIGIN}/plugins`,
  downloads: `https://${APEX_ORIGIN}/downloads`,
  iosAppStore: "https://apps.apple.com/us/app/mycadet/id6759934423",
  androidPlayStore:
    "https://play.google.com/store/apps/details?id=ai.mycadet.android",
  chromeWebStore:
    "https://chromewebstore.google.com/detail/mycadet-browser/hphbdmpffeigpcdjkckleobjmhhokpne",
} as const;
