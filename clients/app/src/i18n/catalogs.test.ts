import { expect, test } from "bun:test";

import { FALLBACK_CATALOGS, loadCatalogs } from "@app/i18n/catalogs";
import { NAMESPACES } from "@app/i18n/namespaces";
import { SUPPORTED_LOCALES } from "@app/i18n/supported-locales";

for (const locale of SUPPORTED_LOCALES) {
  test(`${locale}: loads app-owned catalogs for every namespace`, async () => {
    const catalogs = await loadCatalogs(locale);
    expect(Object.keys(catalogs).sort()).toEqual([...NAMESPACES].sort());
    for (const namespace of NAMESPACES) {
      // Translations may be empty while English supplies the fallback.
      expect(catalogs[namespace]).toBeDefined();
    }
    if (locale === "en") {
      expect(catalogs).toEqual(FALLBACK_CATALOGS);
    }
  });
}
