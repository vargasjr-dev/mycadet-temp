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
      start: "/account/onboarding/start",
      hosting: "/account/onboarding/hosting",
      apiKey: "/account/onboarding/api-key",
      vellum: "/account/onboarding/vellum",
    },
    login: "/account/login",
    doctor: "/account/doctor",
    selectAssistant: "/account/select-assistant",
    assistants: "/account/assistants",
    // Deep link to one assistant's management surface (backups, upgrades,
    // export) — the settings page's Manage Assistant button lands here.
    assistantDetail: (assistantId: string) =>
      `/account/assistants/${assistantId}`,
    signup: "/account/signup",
    pair: "/account/pair",
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
    legal: {
      privacyPolicy: "/docs/privacy-policy",
      termsOfUse: "/docs/terms-of-use",
    },
  },
} as const;

export function docsUrl(path: string): string {
  return `https://${WWW_DOMAIN}${path}`;
}
