import { Terminal } from "lucide-react";
import { useMemo, useState } from "react";

import { TerminalPanel } from "@/components/terminal-panel";
import { useActiveAssistantIsSelfHosted } from "@/assistant/hosting";
import { useAssistantResolution } from "@/assistant/queries";
import { useTranslation } from "@/i18n";
import { Select } from "@mycadet/design-library/components/select";

type TerminalService = "assistant" | "gateway" | "credential-executor";

export function AssistantTerminalPanel() {
  const { t } = useTranslation("settings");
  // The terminal session is a cloud-routed exec channel — it has no meaning
  // against a self-hosted assistant. Self-hosted resolutions early-return
  // null, structurally blocking TerminalPanel from mounting a cloud-routed
  // exec connection against a self-hosted target. The assistant is the
  // shell's — the boot resolution owns the id, the panel runs its own fetch
  // for nothing.
  const { state, result } = useAssistantResolution();
  const assistantId = result?.ok ? result.data.id : null;
  const loading = state.kind === "loading";
  const [service, setService] = useState<TerminalService>("assistant");

  const terminalServiceOptions = useMemo(
    () =>
      [
        { value: "assistant" as const, label: "assistant" },
        { value: "gateway" as const, label: "gateway" },
        {
          value: "credential-executor" as const,
          label: "credential-executor",
        },
      ] as const,
    [],
  );

  // The cloud-routed exec connection — the actual Trap-5 concern — lives
  // inside `<TerminalPanel>` and is structurally blocked from mounting: the
  // gate flips to `"gated"` and returns null when the lifecycle resolves to
  // self-hosted.
  if (useActiveAssistantIsSelfHosted()) {
    return null;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-base)]">
            <Terminal className="h-5 w-5 text-[var(--content-secondary)]" />
          </div>
          <div className="min-w-0">
            <h2 className="text-title-small text-[var(--content-default)]">
              {t("assistantTerminalPanel.title")}
            </h2>
            <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
              {t("assistantTerminalPanel.subtitle")}
            </p>
          </div>
        </div>
        {assistantId && (
          <Select
            options={[...terminalServiceOptions]}
            value={service}
            onChange={setService}
            aria-label={t("assistantTerminalPanel.targetContainer")}
          />
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--border-element)] border-t-[var(--content-secondary)]" />
          {t("assistantTerminalPanel.loading")}
        </div>
      ) : !assistantId ? (
        <div className="rounded-lg border border-[var(--border-base)] px-4 py-3 text-body-medium-lighter text-[var(--content-tertiary)]">
          <div className="flex items-center gap-2 px-1 py-0.5">
            <Terminal className="h-4 w-4 shrink-0" />
            <span>{t("assistantTerminalPanel.noAssistant")}</span>
          </div>
        </div>
      ) : (
        <TerminalPanel
          key={service}
          assistantId={assistantId}
          service={service}
          className="min-h-0 flex-1"
        />
      )}
    </div>
  );
}
