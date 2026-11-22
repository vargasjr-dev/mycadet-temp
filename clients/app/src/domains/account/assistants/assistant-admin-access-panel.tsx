import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  fetchAssistantAdminAccess,
  setAssistantAdminAccess,
} from "@app/domains/account/assistants/assistants-management-api";
import { useTranslation } from "@app/i18n";
import { Button } from "@design/components/button";
import { toast } from "@design/components/toast";

/**
 * The admin-access toggle for one assistant, on the account's
 * assistants-management page. The flag opts the assistant's row into the
 * cloud's internal-admin seam (log downloads today) — the owner flips it
 * here, which is what makes a down cadet debuggable: the assistant itself
 * can't consent to anything while it's failing health checks. A
 * self-hosted assistant has no such flag on the cloud (the dial 404s) and
 * the panel reads as not available.
 */
export function AssistantAdminAccessPanel({
  assistantId,
}: {
  assistantId: string;
}) {
  const { t } = useTranslation("account");
  const [enabled, setEnabled] = useState<boolean | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await fetchAssistantAdminAccess(assistantId);
    if (result.ok) {
      setEnabled(result.data);
    } else {
      setEnabled(undefined);
    }
  }, [assistantId]);

  useEffect(() => {
    setEnabled(undefined);
    void load();
  }, [load]);

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

  if (enabled === null) {
    return (
      <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
        {t("assistantsPage.adminAccess.notAvailable")}
      </p>
    );
  }

  return (
    <div className="flex items-center gap-3">
      {enabled === undefined ? (
        <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
      ) : (
        <span className="text-body-medium-lighter text-[var(--content-default)]">
          {enabled
            ? t("assistantsPage.adminAccess.stateOn")
            : t("assistantsPage.adminAccess.stateOff")}
        </span>
      )}
      <Button
        variant="outlined"
        disabled={busy || enabled === undefined}
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
