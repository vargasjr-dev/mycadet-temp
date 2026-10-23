import { WWW_DOMAIN } from "@app/utils/domains";

export const routes = {
  assistant: "/assistant",
  checkout: "/assistant/checkout",
  onboarding: {
    hatching: "/assistant/onboarding/hatching",
    privacy: "/assistant/onboarding/privacy",
    research: "/assistant/onboarding/research",
  },
  // The local client's front door — ported from web's `/assistant/welcome`
  // (web's copy is deleted; this path renders the app-owned screen).
  welcome: "/account/onboarding/welcome",
  account: {
    root: "/account",
    consent: "/account/consent",
    // The pre-hatch onboarding front door, app-owned like the consent screens
    // above. The remaining funnel steps (hatching, research) still render in
    // the web bundle under /assistant/onboarding/* and are reached through
    // the AssistantPage iframe mount.
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
