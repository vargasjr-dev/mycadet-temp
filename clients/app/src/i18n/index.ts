/**
 * Public surface for app translation. Import from `@app/i18n`, not from the
 * modules behind it or from `i18next` / `react-i18next` directly. That keeps
 * the library choice replaceable and gives call sites one place to look.
 *
 * In components, naming the namespace that owns the string (see
 * `namespaces.ts` for which one that is):
 *
 * ```tsx
 * const { t } = useTranslation("account");
 * return <h1>{t("loginPage.signIn")}</h1>;
 * ```
 *
 * `common` is the default, so cross-domain components can omit it:
 *
 * ```tsx
 * const { t } = useTranslation();
 * return <h1>{t("notFound.title")}</h1>;
 * ```
 *
 * Outside React (stores, event handlers, toasts) use the bound `t`:
 *
 * ```ts
 * import { t } from "@app/i18n";
 * toast.error(t("notFound.title"));
 * ```
 *
 * Keys are type-checked against `locales/en/common.json` via the `i18next`
 * module augmentation in `i18next.d.ts`, so a typo or a key deleted from the
 * catalog fails `tsc`, not QA.
 */
import { type TFunction } from "i18next";
import { i18next } from "@app/i18n/instance";

import type { Namespace } from "@app/i18n/namespaces";

export { Trans, useTranslation } from "@app/i18n/react";

export {
  changeLocale,
  currentLocale,
  formatLocale,
  initI18n,
  resolveInitialLocale,
} from "@app/i18n/i18n";

export {
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  negotiateLocale,
  type SupportedLocale,
} from "@app/i18n/supported-locales";

export { systemLocales } from "@app/i18n/system-locale";

export {
  DEFAULT_NAMESPACE,
  NAMESPACES,
  type Namespace,
} from "@app/i18n/namespaces";

/**
 * Namespace-bound `t` for non-React call sites.
 *
 * This is the app instance’s `i18next.t`, so it reads the same active locale the
 * hook does and picks up `changeLocale()`, but it is *not* reactive. A
 * component that renders its result must use `useTranslation()` instead, or
 * it will keep showing the previous language after a switch.
 */
export const t = i18next.t.bind(i18next);

/**
 * The type of a namespace-bound `t`, for a helper that is handed one rather
 * than holding it. A plain function cannot call `useTranslation()`, so it
 * takes a parameter of this type and its component caller owns the reactive
 * binding.
 */
export type { TFunction } from "i18next";

/**
 * The union of valid key paths, derived from the English catalogs. Type a
 * parameter as `ParseKeys<"account">` rather than `string` when it names copy, so
 * the catalog stays the only place copy can come from.
 */
export type { ParseKeys } from "i18next";

/**
 * A `t` bound to one namespace, for call sites outside React that read a
 * single namespace and would otherwise resolve against `common`.
 *
 * Carries the same caveat as {@link t}: it reads the active locale but is not
 * reactive, so anything rendering its result belongs on `useTranslation()`.
 */
export function fixedT<N extends Namespace>(namespace: N): TFunction<N> {
  return i18next.getFixedT(null, namespace);
}
