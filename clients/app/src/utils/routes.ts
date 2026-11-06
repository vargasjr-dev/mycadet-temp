import { WWW_DOMAIN } from "@app/utils/domains";

export const routes = {
  index: "/",
  assistant: "/assistant",
  onboarding: {
    hatching: "/account/onboarding/hatching",
    privacy: "/assistant/onboarding/privacy",
    research: "/assistant/onboarding/research",
  },
  account: {
    root: "/account",
    consent: "/account/consent",
    onboarding: {
      welcome: "/account/onboarding/welcome",
      start: "/account/onboarding/start",
      hosting: "/account/onboarding/hosting",
      apiKey: "/account/onboarding/api-key",
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
  docs: {
    hostingOptions: "/docs/hosting-options",
    localHosting: "/docs/hosting-options/local-hosting",
  },
} as const;

export function docsUrl(path: string): string {
  return `https://${WWW_DOMAIN}${path}`;
}
