import { HardDrive, Loader2, Wrench } from "lucide-react";

import { asGeneratedAssistant } from "@/assistant/queries";
import { useResolvedAssistantStore } from "@/stores/resolved-assistant-store";
import { AssistantBackups } from "@/domains/settings/components/assistant-backups";
import { useTranslation } from "@/i18n";

export function DebugControlsPanel() {
  const { t } = useTranslation("settings");

  // The store IS the resolution — the entry projects straight to the
  // panel's shape, no fetch and no loading window.
  const assistant = useResolvedAssistantStore((s) =>
    s.assistant.assistantId === "" ? null : asGeneratedAssistant(s.assistant),
  );
  const loading = assistant === null;
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
