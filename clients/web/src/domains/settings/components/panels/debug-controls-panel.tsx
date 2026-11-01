import { HardDrive, Loader2, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { type Assistant, getAssistant } from "@/assistant/api";
import { AssistantBackups } from "@/domains/settings/components/assistant-backups";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/error-reporting/capture-error";
import { toast } from "@mycadet/design-library/components/toast";

export function DebugControlsPanel() {
  const { t } = useTranslation("settings");

  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchedRef = useRef(false);

  const fetchAssistant = useCallback(async () => {
    if (fetchedRef.current) {
      return;
    }
    setLoading(true);
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
  }, [t]);

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
          <div className="rounded-lg border border-[var(--border-base)] px-4 py-3 dark:border-[var(--border-base)]">
            <div className="mb-3 flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-[var(--content-secondary)]" />
              <h3 className="text-body-medium-default text-[var(--content-default)]">
                {t("debugControlsPanel.backups")}
              </h3>
            </div>
            <AssistantBackups assistantId={assistant.id} />
          </div>
        </div>
      ) : (
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("debugControlsPanel.noAssistant")}
        </p>
      )}
    </div>
  );
}
