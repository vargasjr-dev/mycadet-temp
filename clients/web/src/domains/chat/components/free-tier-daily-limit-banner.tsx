import { CalendarClock } from "lucide-react";

import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";
import { useTranslation } from "@/i18n";
import { cloudAccountBillingUrl } from "@/lib/cloud-runtime-url";
import { useAddCreditsModalStore } from "@/stores/add-credits-modal-store";
import { dailyResetTimePhrase } from "@/utils/daily-reset-time";
import { openExternalUrl } from "@/runtime/browser";

/**
 * Composer banner for the cloud's free-tier daily usage-credit cap: the
 * daily counterpart of the credits-exhausted wall, worded so "daily" is
 * unmistakable. Unlike `DailyLimitBanner` there is no setting to raise and
 * no skip: the cap lifts at the UTC reset, on upgrade, or with extra credits,
 * so those are the two ways out it offers. Resolves its own CTAs like
 * `CreditsUpsellCard`, since both open the shared add-credits modal mounted
 * under `ActiveChatView`.
 */
export function FreeTierDailyLimitBanner() {
  const { t } = useTranslation("chat");
  const resetPhrase = dailyResetTimePhrase();

  return (
    <BillingErrorBanner
      ariaLabel={t("freeTierDailyLimitBanner.title")}
      icon={
        <CalendarClock
          className="size-5"
          style={{ color: "var(--content-tertiary)" }}
        />
      }
      title={t("freeTierDailyLimitBanner.title")}
      subtitle={t("freeTierDailyLimitBanner.subtitle", { resetPhrase })}
      secondaryAction={{
        label: t("freeTierDailyLimitBanner.upgrade"),
        onClick: () => void openExternalUrl(cloudAccountBillingUrl()),
      }}
      action={{
        label: t("freeTierDailyLimitBanner.addCredits"),
        onClick: () => useAddCreditsModalStore.getState().setOpen(true),
      }}
    />
  );
}
