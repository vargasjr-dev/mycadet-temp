import {
  createContext,
  useEffect,
  useMemo,
  type ReactNode,
  type Context,
} from "react";
import { createInstance, type i18n } from "i18next";
import ICU from "i18next-icu";
import { FALLBACK_CATALOGS, loadCatalogs } from "./catalogs";
import { currentLocale } from "./i18n";
import { i18nextInitOptions } from "./config";

export const AppI18nContext: Context<i18n | undefined> = createContext<
  i18n | undefined
>(undefined);

export function AppI18nProvider({ children }: { children: ReactNode }) {
  const instance = useMemo(() => {
    const i18n = createInstance();
    void i18n.use(new ICU()).init({
      ...i18nextInitOptions("en", { en: FALLBACK_CATALOGS }),
      initAsync: false,
    });
    return i18n;
  }, []);
  useEffect(() => {
    let active = true;
    const locale = currentLocale();
    void loadCatalogs(locale)
      .then((catalogs) => {
        if (!active) {
          return;
        }
        for (const [namespace, catalog] of Object.entries(catalogs)) {
          instance.addResourceBundle(locale, namespace, catalog, true, true);
        }
        void instance.changeLanguage(locale);
      })
      .catch(() => {
        if (active) {
          void instance.changeLanguage("en");
        }
      });
    return () => {
      active = false;
    };
  }, [instance]);
  return (
    <AppI18nContext.Provider value={instance}>
      {children}
    </AppI18nContext.Provider>
  );
}
