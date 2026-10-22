/**
 * Where translation catalogs live, and how they reach the running app.
 *
 * Catalogs are source files under `src/i18n/locales/<locale>/<namespace>.json`,
 * not runtime-fetched assets.
 *
 * English is imported statically, so it is part of the entry's static graph and
 * is readable with no network round trip at all. Every other locale is pulled
 * in with a dynamic `import()`, so Vite emits chunks per locale and the app
 * downloads only the locale it renders. The asymmetry is deliberate: the
 * fallback catalog is what the UI falls back *to*, so it must be the one thing
 * that cannot fail to load.
 *
 * Non-default locales are still bundled output sitting next to the JS, which is
 * why this is not `i18next-http-backend` (the usual default, which GETs
 * `/locales/{lng}/{ns}.json` from `public/`):
 *
 * - Capacitor serves the bundle from `capacitor://localhost` and the app is
 *   expected to work offline. An HTTP fetch for UI copy makes first paint
 *   depend on the network and fails outright on a cold offline launch.
 * - Electron loads the renderer from a local file/custom scheme where the same
 *   fetch is at best a different origin to get right, at worst blocked.
 * - Bundled chunks are cache-busted by the build hash. A catalog in `public/`
 *   is served unhashed and can be held by a stale HTTP cache after a deploy,
 *   so users see one release's copy against another release's UI.
 *
 * The registry below is written out by hand rather than generated with
 * `import.meta.glob`. Two reasons: it is typed as a total map over locale and
 * namespace, so adding either without adding its catalog is a compile error
 * instead of a runtime miss; and `import.meta.glob` is a Vite-only transform
 * absent under Bun's test runner, which would force every test touching i18n
 * through a mock.
 *
 * Reference: https://vite.dev/guide/features#dynamic-import
 */
import enAccount from "@app/i18n/locales/en/account.json";
import enCommon from "@app/i18n/locales/en/common.json";
import enConsent from "@app/i18n/locales/en/consent.json";
import { NAMESPACES, type Namespace } from "@app/i18n/namespaces";
import {
  DEFAULT_LOCALE,
  type SupportedLocale,
} from "@app/i18n/supported-locales";

/**
 * A parsed catalog. Values are ICU MessageFormat strings; nesting mirrors the
 * dotted key path used at the call site (`t("notFound.title")`).
 */
export type Catalog = Record<string, unknown>;

/** Every namespace of one locale. */
export type LocaleCatalogs = Record<Namespace, Catalog>;

type CatalogLoader = () => Promise<{ default: Catalog }>;

/**
 * The English catalogs, available synchronously. Both the boot path and the
 * test preload seed i18next with these, so a missing or unreachable chunk for
 * any other locale degrades to readable English rather than raw key paths.
 */
export const FALLBACK_CATALOGS: LocaleCatalogs = {
  common: enCommon,
  account: enAccount,
  consent: enConsent,
};

/** Loaders for the locales that are not bundled into the entry chunk. */
const CATALOG_LOADERS: Record<
  Exclude<SupportedLocale, typeof DEFAULT_LOCALE>,
  Record<Namespace, CatalogLoader>
> = {
  es: {
    common: () => import("@app/i18n/locales/es/common.json"),
    account: () => import("@app/i18n/locales/es/account.json"),
    consent: () => import("@app/i18n/locales/es/consent.json"),
  },
  ru: {
    common: () => import("@app/i18n/locales/ru/common.json"),
    account: () => import("@app/i18n/locales/ru/account.json"),
    consent: () => import("@app/i18n/locales/ru/consent.json"),
  },
  zh: {
    common: () => import("@app/i18n/locales/zh/common.json"),
    account: () => import("@app/i18n/locales/zh/account.json"),
    consent: () => import("@app/i18n/locales/zh/consent.json"),
  },
  "zh-TW": {
    common: () => import("@app/i18n/locales/zh-TW/common.json"),
    account: () => import("@app/i18n/locales/zh-TW/account.json"),
    consent: () => import("@app/i18n/locales/zh-TW/consent.json"),
  },
};

/**
 * Load every namespace of one locale.
 *
 * Rejects when any non-default locale's chunk cannot be fetched (offline, or an
 * entry bundle outliving the assets a deploy removed). Callers on the boot path
 * treat that as "stay on {@link FALLBACK_CATALOGS}". Namespaces load together
 * rather than on demand because they are small and first paint can draw from
 * any of them; split this if a namespace ever grows large enough to matter.
 */
export async function loadCatalogs(
  locale: SupportedLocale,
): Promise<LocaleCatalogs> {
  if (locale === DEFAULT_LOCALE) {
    return FALLBACK_CATALOGS;
  }

  const loaders = CATALOG_LOADERS[locale];
  const loaded = await Promise.all(
    NAMESPACES.map(async (namespace) => {
      const module = await loaders[namespace]();
      return [namespace, module.default] as const;
    }),
  );
  return Object.fromEntries(loaded) as LocaleCatalogs;
}

/**
 * Every locale this module can produce catalogs for. Exported for the coverage
 * test that asserts this stays in lockstep with `SUPPORTED_LOCALES`.
 */
export function loadableLocales(): SupportedLocale[] {
  return [
    DEFAULT_LOCALE,
    ...(Object.keys(CATALOG_LOADERS) as SupportedLocale[]),
  ];
}
