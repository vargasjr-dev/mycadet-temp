import { Suspense, type ReactElement, type ReactNode } from "react";

import { ErrorBoundary } from "@/components/error-boundary";

import { useTranslation } from "@/i18n";

interface LazyBoundaryProps {
  children: ReactNode;
  /** Rendered while the lazy chunk is loading. */
  fallback?: ReactNode;
  /**
   * Rendered when the lazy chunk fails to load (e.g. network drop between
   * the user triggering the lazy component and the chunk arriving). The
   * default message instructs the user to reload — React.lazy memoizes
   * rejected import promises at the module level, so an inline retry would
   * not actually re-fetch; full reload is the realistic remediation.
   *
   * Pass an alternate `errorFallback` for graceful degradation (e.g. a
   * weather card showing the markdown body when the rich chart chunk
   * fails to arrive). Must be a `ReactElement` (wrap bare strings in a
   * `<span>`/`<div>`).
   *
   * An in-place retry is possible, but only by minting a fresh lazy
   * component and remounting this boundary with a new `key`; see
   * `share-feedback-modal-lazy.tsx`.
   */
  errorFallback?: ReactElement;
}

/**
 * Suspense + ErrorBoundary pair for `React.lazy` components rendered
 * *outside* a route boundary (modals, inline lazy widgets, etc.). For
 * lazy *routes*, React Router's `ErrorBoundary` (see
 * `RouteErrorBoundary`) catches the failure instead.
 *
 * The boundary reports through the console via the in-house
 * `ErrorBoundary`; route-level errors report symmetrically through
 * `RouterProvider.onError`.
 *
 * The default error UI matches the inline copy used by
 * `RouteErrorBoundary`'s chunk-fail variant so messaging stays
 * consistent across the app.
 */
export function LazyBoundary({
  children,
  fallback = null,
  errorFallback,
}: LazyBoundaryProps) {
  const { t } = useTranslation();

  return (
    <ErrorBoundary
      fallback={
        errorFallback ?? (
          <div
            role="alert"
            className="p-3 text-body-small-lighter text-[var(--content-tertiary)]"
          >
            {t("lazyBoundary.loadError")}
          </div>
        )
      }
    >
      <Suspense fallback={fallback}>{children}</Suspense>
    </ErrorBoundary>
  );
}
