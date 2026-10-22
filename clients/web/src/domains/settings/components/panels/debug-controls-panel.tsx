import { HardDrive, Loader2, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { type Assistant, getAssistant } from "@/assistant/api";
import { CloudLoginNotice } from "@/components/cloud-login-notice";
import { AssistantBackups } from "@/domains/settings/components/assistant-backups";
import { RecoveryModeControls } from "@/domains/settings/components/recovery-mode-controls";
import { RestartAssistant } from "@/domains/settings/components/restart-assistant";
import { useCloudGate } from "@/hooks/use-cloud-gate";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/error-reporting/capture-error";
import { toast } from "@mycadet/design-library/components/toast";

export function DebugControlsPanel() {
  const { t } = useTranslation("settings");
  const cloudGate = useCloudGate();

  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchedRef = useRef(false);

  const fetchAssistant = useCallback(
    async (force?: boolean) => {
      if (!force && fetchedRef.current) {
        return;
      }
      if (!force) {
        setLoading(true);
      }
      try {
        const result = await getAssistant();
        if (result.ok) {
          fetchedRef.current = true;
          setAssistant(result.data);
        } else {
          setAssistant(null);
        }
      } catch (error) {
        captureError(error, { context: "fetch_assistant_for_debug_controls" });
        toast.error(t("debugControlsPanel.loadFailedToast"));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    fetchAssistant();
  }, [fetchAssistant]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--surface-base)]">
          <Wrench className="h-5 w-5 text-[var(--content-secondary)]" />
        </div>
        <div>
          <h2 className="text-title-small text-[var(--content-default)]">
            {t("debugControlsPanel.title")}
          </h2>
          <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
            {t("debugControlsPanel.subtitle")}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("debugControlsPanel.loading")}
        </div>
      ) : assistant ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-[var(--border-base)] px-4 py-3 dark:border-[var(--border-base)]">
            <div className="min-w-0">
              <p className="text-body-medium-default text-[var(--content-default)]">
                {t("debugControlsPanel.restartTitle")}
              </p>
              <p className="text-body-small-lighter text-[var(--content-tertiary)]">
                {t("debugControlsPanel.restartDescription")}
              </p>
            </div>
            <div className="ml-4 shrink-0">
              <RestartAssistant
                assistantId={assistant.id}
                isLocal={assistant.is_local}
              />
            </div>
          </div>

          <RecoveryModeControls
            assistantId={assistant.id}
            maintenanceMode={assistant.maintenance_mode}
            onMaintenanceModeChange={() => fetchAssistant(true)}
          />

          {cloudGate === "disabled" && (
            <CloudLoginNotice>
              {t("debugControlsPanel.loginNotice")}
            </CloudLoginNotice>
          )}
          {cloudGate !== "disabled" && (
            <div className="rounded-lg border border-[var(--border-base)] px-4 py-3 dark:border-[var(--border-base)]">
              <div className="mb-3 flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-[var(--content-secondary)]" />
                <h3 className="text-body-medium-default text-[var(--content-default)]">
                  {t("debugControlsPanel.backups")}
                </h3>
              </div>
              <AssistantBackups assistantId={assistant.id} />
            </div>
          )}
        </div>
      ) : (
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("debugControlsPanel.noAssistant")}
        </p>
      )}
    </div>
  );
}
