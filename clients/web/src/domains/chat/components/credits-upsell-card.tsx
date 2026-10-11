import { useNavigate } from "react-router";

import { CloudLoginNotice } from "@/components/cloud-login-notice";
import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";
import { useIsFreePlan } from "@/hooks/use-is-free-plan";
import { useCloudGate } from "@/hooks/use-cloud-gate";
import { useAddCreditsModalStore } from "@/stores/add-credits-modal-store";
import { routes } from "@/utils/routes";
import { useTranslation } from "@/i18n";

/** Free-plan copy: the wall points at plans rather than at credits. */
export const UPGRADE_COPY = {
  title: "You’re out of Free credits",
  subtitle: "Upgrade your plan to keep the conversation going.",
  ctaLabel: "View plans",
};

/** The default credit-wall copy: any paid or unresolved plan. */
export const ADD_CREDITS_COPY = {
  title: "You’re out of credits",
  subtitle: "Add credits to pick up where you left off.",
  ctaLabel: "Add credits",
};

/**
 * Friendly credits upsell card: a single-CTA credit wall built on
 * {@link BillingErrorBanner}, rendered in the transcript in place of a
 * persisted credits-exhausted provider-error row. Takes no
 * transcript-specific props and resolves its own CTA mode, so it works
 * anywhere under `ActiveChatView`, where the shared `LazyAddCreditsModal` the
 * Add Credits CTA opens (via {@link useAddCreditsModalStore}) is mounted; a
 * mount outside that tree would have a dead Add Credits CTA.
 */
export function CreditsUpsellCard() {
  const { t } = useTranslation("chat");
  const navigate = useNavigate();

  // Managed credits are cloud-hosted billing, so the card follows the
  // cloud-hosted gate (like `MaintenanceModeBanner` and the billing
  // settings tab): "full" renders the real CTA, "disabled" renders the login
  // treatment, "gated" renders nothing. The gate also keys the subscription
  // fetch inside `useIsFreePlan`: without a cloud session `useIsOrgReady`
  // still reports ready, so an ungated fetch would fire unauthenticated.
  const cloudGate = useCloudGate({ cloudHostedOnly: true });
  const isFreePlan = useIsFreePlan(cloudGate === "full");
  // Upgrade CTA shows ONLY for a free-plan org; an unknown/unresolved plan
  // counts as paid.
  const isUpgrade = isFreePlan === true;
  const copy = isUpgrade ? UPGRADE_COPY : ADD_CREDITS_COPY;

  if (cloudGate === "gated") {
    // Self-hosted active assistant: every recovery action the card could
    // offer targets the cloud, so there is nothing useful to render.
    // Defensive rail: every mount point (transcript substitution, proactive
    // tail, empty state) keys off `useBillingBalanceStatus().isExhausted`,
    // which stays false without a cloud billing read, so gated contexts
    // never mount the card through a normal path.
    return null;
  }

  if (cloudGate === "disabled") {
    // Platform reachable but no platform session (e.g. it expired): the
    // add-credits / view-plans CTAs cannot complete a billing request, so
    // offer the shared login affordance instead of a dead-end CTA.
    return (
      <CloudLoginNotice className="mx-auto max-w-[calc(100%-24px)]">
        {t("creditsUpsellCard.loginToAddCredits")}
      </CloudLoginNotice>
    );
  }

  return (
    <BillingErrorBanner
      ariaLabel={`${copy.title}. ${copy.subtitle}`}
      icon={<span className="text-lg opacity-80">💰</span>}
      title={copy.title}
      subtitle={copy.subtitle}
      action={{
        label: copy.ctaLabel,
        onClick: isUpgrade
          ? () => void navigate(routes.plans)
          : () => useAddCreditsModalStore.getState().setOpen(true),
      }}
      detached={true}
    />
  );
}
