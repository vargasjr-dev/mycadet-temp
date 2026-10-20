import { useEffect } from "react";

import { Navigate, useNavigate } from "react-router";

import { CloudLoginNotice } from "@/components/cloud-login-notice";
import { useTranslation } from "@/i18n";
import {
  useActiveAssistantIsCloudHosted,
  useActiveAssistantLifecycleIsLoading,
  useCloudGate,
} from "@/hooks/use-cloud-gate";
import { routes } from "@/utils/routes";
import { Button } from "@mycadet/design-library/components/button";
import { Card } from "@mycadet/design-library/components/card";
import { Notice } from "@mycadet/design-library/components/notice";
import { Typography } from "@mycadet/design-library/components/typography";

/**
 * Stripe Checkout `cancel_url` landing page.
 *
 * When a user bails out of the Stripe-hosted upgrade flow, Stripe redirects
 * them here. Stripe does not create a subscription on cancellation, so there
 * is no backend state to clean up. This page bounces the user back to the
 * billing settings page via `router.replace` (so the cancel route does not
 * pollute browser history), carrying `billing_status=cancel` so the billing
 * page's `BillingStatusHandler` owns the cancel UX in one place: the toast
 * (`billing_context=upgrade` picks the upgrade copy) and the
 * abandoned-checkout bonus offer.
 */
export function UpgradeCancelPage() {
  const { t } = useTranslation("settings");
  // Defense in depth: this page is only reachable from a Stripe Checkout
  // session that started on the Billing tab (itself gated). But deep-link
  // or bookmark navigation can still land a self-hosted user here, together
  // with a stray "upgrade canceled" toast for an upgrade the user never
  // started. Cleaner to short-circuit at this page too.
  const cloudGate = useCloudGate({ cloudHostedOnly: true });
  // Strict hosting predicate for the side effect below. `cloudGate ===
  // "full"` is the *Render*-tier predicate — it's intentionally permissive
  // during the lifecycle-loading window so the page chrome stays mounted.
  // The cancel-redirect side effect is a *Fetch/Interact*-tier action and
  // must wait for positive hosted resolution; otherwise a self-hosted
  // deep-link user gets the stray cancel redirect (and its toast on the
  // billing page) before `<Navigate />` flips below.
  const isCloudHosted = useActiveAssistantIsCloudHosted();
  // Distinguish the genuine *resolving* window from terminal-non-hosted
  // states. The resolving window lets the existing "Returning you to
  // billing settings…" card render (effect short-circuits, but the auto-
  // redirect will fire once lifecycle resolves to hosted). Terminal-non-
  // hosted needs a manual escape hatch since the auto-redirect never
  // fires (Trap 6 cached-state variant applied to side-effect-tier).
  const isLifecycleLoading = useActiveAssistantLifecycleIsLoading();
  const navigate = useNavigate();

  useEffect(() => {
    // Wait for positive hosted resolution before firing the redirect.
    // During the lifecycle-loading window `cloudGate === "full"` AND
    // `isCloudHosted === false`; running the effect here would defeat
    // the gate on a self-hosted deep-link. Once lifecycle resolves, either
    // `isCloudHosted` flips true (run the effect) or `cloudGate`
    // flips to `"gated"` (body's `<Navigate />` takes over, this effect
    // never runs).
    if (!isCloudHosted) {
      return;
    }
    navigate(routes.settings.usage, { replace: true });
  }, [navigate, isCloudHosted]);

  if (cloudGate === "gated") {
    return <Navigate replace to={routes.settings.general} />;
  }
  if (cloudGate === "disabled") {
    return (
      <div className="max-w-4xl space-y-6">
        <CloudLoginNotice>
          {t("upgradeCancelPage.platformLoginNotice")}
        </CloudLoginNotice>
      </div>
    );
  }

  // Terminal non-hosted: the auto-redirect effect never runs because
  // `isCloudHosted` stays false, and the body's "Returning…" message
  // would lie. Render a manual escape hatch instead. The lifecycle-
  // loading window still falls through to the body so the auto-redirect
  // fires once resolution lands.
  if (!isCloudHosted && !isLifecycleLoading) {
    return (
      <div className="max-w-4xl space-y-6">
        <Notice tone="warning">
          {t("upgradeCancelPage.billingUnavailable")}
        </Notice>
        <div className="flex justify-end">
          <Button
            variant="primary"
            onClick={() => navigate(routes.settings.usage, { replace: true })}
          >
            {t("upgradeCancelPage.returnToBilling")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      <Card padding="lg">
        <Typography as="h1" variant="title-large">
          {t("upgradeCancelPage.title")}
        </Typography>
        <Typography as="p" variant="body-medium-default" className="mt-2">
          {t("upgradeCancelPage.redirectingBody")}
        </Typography>
      </Card>
    </div>
  );
}
