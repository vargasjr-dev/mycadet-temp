import { Navigate, useLocation, useSearchParams } from "react-router";

import { routes } from "@/utils/routes";

/**
 * The usage page moved to `/assistant/settings/usage`. Keep the old
 * `/assistant/settings/billing` route as a permanent redirect so existing
 * bookmarks — and the server-configured Stripe checkout/portal return URLs that
 * land here with `billing_status` / `session_id` / `adjust_plan` — continue to
 * work. All query params and the hash carry over verbatim (platform emails
 * deep-link to `#daily-credit-limit` through this route). The destination page
 * is a plain usage page now, so the params land inert.
 */
export function BillingRedirectPage() {
  const [searchParams] = useSearchParams();
  const { hash } = useLocation();

  const query = searchParams.toString();

  return (
    <Navigate
      replace
      to={`${routes.settings.usage}${query ? `?${query}` : ""}${hash}`}
    />
  );
}
