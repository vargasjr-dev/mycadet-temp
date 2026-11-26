import { PackageOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { useTranslation } from "@app/i18n";
import { routes } from "@app/utils/routes";
import type { VellumMigrationProbe } from "@mycadet/ipc-contract";
import { Button } from "@mycadet/design-library/components/button";

/**
 * The one-time vellum → cadet migration offer, shown where an upgrading
 * vellum user actually lands — their assistant shell — instead of inside
 * onboarding (which a vellum user with existing assistants never walks).
 * Session-dismissable: the ✕ hides it until the next launch; the real
 * "don't ask again" marker is the consent screen's checkbox.
 */
export function VellumOfferCard() {
  const { t } = useTranslation("account");
  const navigate = useNavigate();
  const [offer, setOffer] = useState<VellumMigrationProbe | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let disposed = false;
    const bridge = window.cadet?.vellumMigration;
    if (!bridge) return;
    bridge
      .get()
      .then((probe) => {
        if (!disposed && probe.status === "offer") setOffer(probe);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  if (!offer || offer.status !== "offer" || dismissed) return null;

  return (
    <div className="w-full border-b border-[var(--border-base)] bg-[var(--surface-lift)]">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-3 p-3 text-left">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--primary-base)] text-[var(--surface-base)]">
          <PackageOpen className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-body-medium-default text-[var(--content-default)]">
            {t("vellumMigration.cardTitle", {
              count: offer.assistantHandles.length,
            })}
          </div>
          <span className="mt-1 line-clamp-2 text-label-medium-default leading-[14px] text-[var(--content-tertiary)]">
            {t("vellumMigration.cardBody")}
          </span>
        </div>
        <Button
          variant="primary"
          size="compact"
          onClick={() => void navigate(routes.account.onboarding.vellum)}
        >
          {t("vellumMigration.cardAction")}
        </Button>
        <button
          type="button"
          aria-label={t("vellumMigration.dismissCard")}
          className="text-[var(--content-tertiary)] hover:text-[var(--content-default)]"
          onClick={() => setDismissed(true)}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
