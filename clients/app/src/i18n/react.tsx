import { useContext } from "react";
import { AppI18nContext } from "./provider";
import type { KeyPrefix } from "i18next";
import {
  Trans as ReactTrans,
  useTranslation as useReactTranslation,
  type FallbackNs,
  type UseTranslationOptions,
} from "react-i18next";

import { i18next } from "@app/i18n/instance";
import type { Namespace } from "@app/i18n/namespaces";

export function useTranslation<
  const N extends Namespace | readonly Namespace[] | undefined = undefined,
  const K extends KeyPrefix<FallbackNs<N>> = undefined,
>(namespace?: N, options?: UseTranslationOptions<K>) {
  const instance = useContext(AppI18nContext) ?? i18next;
  return useReactTranslation<N, K>(namespace, { ...options, i18n: instance });
}

export const Trans: typeof ReactTrans = (props) => {
  const instance = useContext(AppI18nContext) ?? i18next;
  return <ReactTrans {...props} i18n={instance} />;
};
