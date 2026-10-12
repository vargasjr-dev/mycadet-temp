import { expect, mock, spyOn, test } from "bun:test";

mock.module("@app/i18n/system-locale", () => ({ systemLocales: () => ["es"] }));
const { FALLBACK_CATALOGS } = await import("@app/i18n/catalogs");
mock.module("@app/i18n/catalogs", () => ({
  FALLBACK_CATALOGS,
  loadCatalogs: async () => {
    throw new Error("offline");
  },
}));
const { initI18n, currentLocale } = await import("@app/i18n/i18n");
const { i18next } = await import("@app/i18n/instance");

test("an offline catalog leaves readable English and reports the failure", async () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  i18next.isInitialized = false;
  try {
    expect(await initI18n()).toBe("en");
    expect(currentLocale()).toBe("en");
    expect(i18next.t("notFound.title")).toBe("Page not found");
    expect(await initI18n()).toBe("en");
    expect(warning).toHaveBeenCalledTimes(2);
  } finally {
    warning.mockRestore();
  }
});
