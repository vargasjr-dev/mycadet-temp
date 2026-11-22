import { useEffect, useState } from "react";

import { setAssistantAdminAccess } from "@app/domains/account/assistants/assistants-management-api";
import { useTranslation } from "@app/i18n";
import { Button } from "@design/components/button";
import { toast } from "@design/components/toast";

/**
 * The admin-access toggle for one assistant, on the account's
 * assistants-management page. The flag opts the assistant's row into the
 * cloud's internal-admin seam (log downloads today) — the owner flips it
 * here, which is what makes a down cadet debuggable: the assistant itself
 * can't consent to anything while it's failing health checks. The flag's
 * current value rides the row the selection state already holds (the
 * cloud's list union carries it); a row without one (self-hosted) reads
 * as not available.
 */
export function AssistantAdminAccessPanel({
  assistantId,
  adminAccessEnabled,
}: {
  assistantId: string;
  adminAccessEnabled: boolean | null | undefined;
}) {
  const { t } = useTranslation("account");
  // Local optimism: the toggle writes through and reflects its own flip;
  // the prop re-seeds whenever the selection (or its row) changes.
  const [enabled, setEnabled] = useState<boolean | null | undefined>(
    adminAccessEnabled,
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEnabled(adminAccessEnabled);
  }, [assistantId, adminAccessEnabled]);

  async function toggle() {
    if (enabled === null || enabled === undefined) {
      return;
    }
    setBusy(true);
    const next = !enabled;
    const result = await setAssistantAdminAccess(assistantId, next);
    setBusy(false);
    if (result.ok) {
      setEnabled(result.data);
      toast.success(t("assistantsPage.adminAccess.updated"));
    } else {
      toast.error(t("assistantsPage.adminAccess.updateFailed"));
    }
  }

  if (enabled === null || enabled === undefined) {
    return (
      <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
        {t("assistantsPage.adminAccess.notAvailable")}
      </p>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <span className="text-body-medium-lighter text-[var(--content-default)]">
        {enabled
          ? t("assistantsPage.adminAccess.stateOn")
          : t("assistantsPage.adminAccess.stateOff")}
      </span>
      <Button
        variant="outlined"
        disabled={busy}
        onClick={() => {
          void toggle();
        }}
      >
        {busy
          ? t("assistantsPage.adminAccess.working")
          : enabled
            ? t("assistantsPage.adminAccess.disable")
            : t("assistantsPage.adminAccess.enable")}
      </Button>
    </div>
  );
}
