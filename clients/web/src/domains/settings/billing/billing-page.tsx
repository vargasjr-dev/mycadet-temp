import { getCloudRuntimeUrl } from "@/lib/cloud-runtime-url";

import { ExternalAnchor } from "@/components/external-anchor";
import { useTranslation } from "@/i18n";
import { Button } from "@mycadet/design-library/components/button";
import { Card } from "@mycadet/design-library/components/card";

/**
 * The settings billing tab hands off to the cloud's account pages. Plans,
 * payment methods, invoices, and usage all live on the cloud now — the page
 * carries no billing machinery of its own.
 */
export function BillingPage() {
  const { t } = useTranslation("settings");
  const cloudUrl = getCloudRuntimeUrl();

  return (
    <Card padding="lg" className="max-w-xl space-y-3">
      <h1 className="text-[20px] font-semibold text-[var(--content-emphasised)]">
        {t("billingPage.linkOutTitle")}
      </h1>
      <p className="text-[var(--content-secondary)]">
        {t("billingPage.linkOutBody")}
      </p>
      <div className="flex flex-col gap-2 pt-1 sm:flex-row">
        <Button asChild variant="primary" size="regular">
          <ExternalAnchor href={`${cloudUrl}/account/billing`}>
            {t("billingPage.billingCta")}
          </ExternalAnchor>
        </Button>
        <Button asChild variant="outlined" size="regular">
          <ExternalAnchor href={`${cloudUrl}/account/profile`}>
            {t("billingPage.accountCta")}
          </ExternalAnchor>
        </Button>
      </div>
    </Card>
  );
}
