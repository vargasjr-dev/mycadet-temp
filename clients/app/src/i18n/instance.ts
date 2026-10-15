import { createInstance, type i18n } from "i18next";

// Separate resources and language state from the assistant UI. Do not register
// initReactI18next here: it would replace react-i18next's global web instance.
export const i18next: i18n = createInstance();
