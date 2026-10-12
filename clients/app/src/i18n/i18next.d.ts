import type account from "@app/i18n/locales/en/account.json";
import type common from "@app/i18n/locales/en/common.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: TranslationResources;
    returnNull: false;
  }
  interface TranslationResources {
    common: typeof common;
    account: typeof account;
  }
}
