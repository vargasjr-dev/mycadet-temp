import { WWW_DOMAIN } from "@app/utils/domains";

export const routes = {
  assistant: "/assistant",
  checkout: "/assistant/checkout",
  onboarding: {
    hosting: "/assistant/onboarding/hosting",
    privacy: "/assistant/onboarding/privacy",
    research: "/assistant/onboarding/research",
  },
  welcome: "/assistant/welcome",
  account: {
    root: "/account",
    consent: {
      reviewTerms: "/account/consent/review-terms",
    },
    login: "/account/login",
    selectAssistant: "/account/select-assistant",
    signup: "/account/signup",
    providerSignup: "/account/provider/signup",
    providerCallback: "/account/provider/callback",
    oauth: {
      popupComplete: "/account/oauth/popup-complete",
      complete: "/account/oauth/complete",
      desktopComplete: "/account/oauth/desktop-complete",
    },
  },
  docs: { localHosting: "/docs/hosting-options/local-hosting" },
} as const;

export function docsUrl(path: string): string {
  return `https://${WWW_DOMAIN}${path}`;
}
