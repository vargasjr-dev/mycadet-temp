/**
 * The i18next `init()` options, in one place.
 *
 * Production and the app test preload use the same options for the app-owned
 * instance.
 *
 * Kept free of any dependency on locale *resolution* (`system-locale.ts`,
 * `device-settings.ts`) so importing it from the preload does not pull those
 * modules into the registry ahead of the tests that mock them.
 */
import type { InitOptions } from "i18next";

import type { LocaleCatalogs } from "@app/i18n/catalogs";
import { DEFAULT_NAMESPACE, NAMESPACES } from "@app/i18n/namespaces";
import { DEFAULT_LOCALE } from "@app/i18n/supported-locales";

export function i18nextInitOptions(
  locale: string,
  resources: Record<string, LocaleCatalogs>,
): InitOptions {
  return {
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    ns: [...NAMESPACES],
    defaultNS: DEFAULT_NAMESPACE,
    resources,
    // React escapes interpolated values on render; letting i18next escape them
    // too double-encodes apostrophes and ampersands in user data.
    interpolation: { escapeValue: false },
    returnNull: false,
  };
}
