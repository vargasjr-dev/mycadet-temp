import { Loader2, RotateCcw } from "lucide-react";
import { isRouteErrorResponse, useNavigate, useRouteError } from "react-router";

import { Button } from "@mycadet/design-library/components/button";

import { useTranslation } from "@app/i18n";
import { isChunkLoadError } from "@app/lib/chunk-errors";
import { routes } from "@app/utils/routes";

/**
 * Single error boundary used at every level of the route tree. Picks
 * one of two variants based on the error shape:
 *
 *   - **Chunk-fetch failures** (stale deploy, network blip, browser
 *     module-map rejection): renders an inline "section couldn't
 *     load" message scoped to the route's content area. Mounted via
 *     pathless wrappers inside layout routes (`RootLayout`,
 *     `ChatLayout`) so the parent chrome stays visible.
 *   - **Anything else** (genuine render error, loader exception,
 *     404 route response): renders the full-page "Something went
 *     wrong" treatment.
 *
 * Error reporting happens once at `RouterProvider.onError` in
 * `main.tsx`; this boundary only owns the UI. That keeps a single
 * source of truth for reporting (chunk failures get the
 * `tags.boundary = "lazy-route"` tag) and avoids double-reporting here.
 *
 * References:
 *   - https://reactrouter.com/how-to/error-boundary
 *   - https://reactrouter.com/start/data/route-object
 */
export function RouteErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();
  const { t } = useTranslation();

  if (isChunkLoadError(error)) {
    return (
      <div
        data-slot="route-error-boundary"
        data-variant="chunk-fail"
        role="alert"
        className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <Loader2
          className="size-6 text-[var(--content-tertiary)]"
          aria-hidden
        />
        <p className="max-w-md text-body-medium-lighter text-[var(--content-secondary)]">
          {t("routeErrorBoundary.chunkFailBody")}
        </p>
        <Button
          variant="ghost"
          size="compact"
          leftIcon={<RotateCcw />}
          onClick={() => window.location.reload()}
        >
          {t("routeErrorBoundary.reload")}
        </Button>
      </div>
    );
  }

  const status = isRouteErrorResponse(error) ? error.status : undefined;
  const heading = status === 404 ? "Page not found" : "Something went wrong";
  const message =
    status === 404
      ? "The page you requested doesn't exist."
      : "An unexpected error occurred. Try reloading the page.";

  // The raw error rides the console: the boundary's full-page variant is
  // the one place a routing mystery (a 404 that should have matched, a
  // scheme-handler response) surfaces, and the inspector's network tab
  // can't see custom-scheme traffic. QA reads this line.
  console.error(`Route error (status ${status ?? "unknown"})`, error);

  return (
    <div
      data-slot="route-error-boundary"
      data-variant="full-page"
      className="flex min-h-svh flex-col items-center justify-center gap-4 bg-[var(--surface-base)] p-6 text-center"
    >
      <h1 className="text-2xl font-semibold text-[var(--content-emphasised)]">
        {heading}
      </h1>
      <p className="max-w-md text-[var(--content-secondary)]">{message}</p>
      {status !== 404 ? (
        <Button variant="primary" onClick={() => window.location.reload()}>
          {t("routeErrorBoundary.reload")}
        </Button>
      ) : (
        // A 404 is a dead end otherwise: reloading re-runs the same
        // match, so the escape path is the assistant selection screen.
        <Button
          variant="primary"
          onClick={() => navigate(routes.account.selectAssistant)}
        >
          {t("routeErrorBoundary.chooseAssistant")}
        </Button>
      )}
    </div>
  );
}
