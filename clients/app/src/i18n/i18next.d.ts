import type account from "@app/i18n/locales/en/account.json";
import type onboarding from "@app/i18n/locales/en/onboarding.json";
import type common from "@app/i18n/locales/en/common.json";
import type consent from "@app/i18n/locales/en/consent.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: TranslationResources;
    returnNull: false;
  }
  interface TranslationResources {
    common: typeof common;
    account: typeof account;
    consent: typeof consent;
    onboarding: typeof onboarding;
  }
}
