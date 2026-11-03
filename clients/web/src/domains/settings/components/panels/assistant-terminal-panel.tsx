import { Terminal } from "lucide-react";
import { useMemo, useState } from "react";

import { TerminalPanel } from "@/components/terminal-panel";
import { useActiveAssistantIsSelfHosted } from "@/assistant/hosting";
import { useTranslation } from "@/i18n";
import { Select } from "@mycadet/design-library/components/select";

type TerminalService = "assistant" | "gateway" | "credential-executor";

export function AssistantTerminalPanel() {
  const { t } = useTranslation("settings");
  // The terminal session is a cloud-routed exec channel — it has no meaning
  // against a self-hosted assistant. Self-hosted assistants early-return
  // null, structurally blocking TerminalPanel from mounting a cloud-routed
  // exec connection against a self-hosted target. The id is the store's —
  // the shell stamped it before the first render.
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
        <Select
          options={[...terminalServiceOptions]}
          value={service}
          onChange={setService}
          aria-label={t("assistantTerminalPanel.targetContainer")}
        />
      </div>

      <TerminalPanel
        key={service}
        service={service}
        className="min-h-0 flex-1"
      />
    </div>
  );
}
