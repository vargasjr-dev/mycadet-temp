import { Loader2 } from "lucide-react";
import { useState } from "react";

import { AssistantBackupsTable } from "@app/domains/account/assistants/assistant-backups-table";
import { AssistantUpgradesPanel } from "@app/domains/account/assistants/assistant-upgrades-panel";
import { AccountHeading } from "@app/components/account/account-form";
import { AccountShell } from "@app/components/account/account-shell";
import { useAssistantChoices } from "@app/assistant/use-assistant-choices";
import { useTranslation } from "@app/i18n";
import { Button } from "@design/components/button";

/**
 * The account's assistants-management page: backups, upgrades, and the
 * export flow for each assistant the operator account holds. The
 * management rows are OPERATOR api — they proxy verbatim to the cloud on
 * the operator's own credentials — which is why this surface lives in the
 * account/client shell and not in the assistant's web bundle.
 */
export function AssistantsPage() {
  const { t } = useTranslation("account");
  const { state, retry } = useAssistantChoices();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (state.status === "loading" || state.status === "error") {
    return (
      <AccountShell>
        <AccountHeading title={t("assistantsPage.title")} />
        {state.status === "error" ? (
          <div className="flex flex-col items-center gap-3">
            <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
              {t("assistantsPage.loadFailed")}
            </p>
            <Button variant="outlined" onClick={retry}>
              {t("assistantsPage.retry")}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("assistantsPage.loading")}
          </div>
        )}
      </AccountShell>
    );
  }

  if (state.status === "unauthenticated") {
    return (
      <AccountShell>
        <AccountHeading title={t("assistantsPage.title")} />
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("assistantsPage.signInRequired")}
        </p>
      </AccountShell>
    );
  }

  const assistants =
    state.status === "selection" ? state.assistants : [];

  const selected =
    selectedId != null
      ? (assistants.find((a) => a.id === selectedId) ?? null)
      : (assistants[0] ?? null);

  return (
    <AccountShell>
      <AccountHeading
        title={t("assistantsPage.title")}
        subtitle={t("assistantsPage.subtitle")}
      />
      {assistants.length === 0 ? (
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("assistantsPage.empty")}
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {assistants.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {assistants.map((assistant) => (
                <button
                  key={assistant.id}
                  type="button"
                  onClick={() => setSelectedId(assistant.id)}
                  className={[
                    "cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors",
                    selected?.id === assistant.id
                      ? "border-[var(--primary-base)] bg-[var(--primary-base)] text-[var(--content-inset)]"
                      : "border-[var(--border-base)] text-[var(--content-default)] hover:bg-[var(--surface-lift)]",
                  ].join(" ")}
                >
                  {assistant.name}
                </button>
              ))}
            </div>
          )}
          {selected && (
            <>
              <section>
                <h3 className="mb-3 text-body-large-default text-[var(--content-default)]">
                  {t("assistantsPage.upgradesSection")}
                </h3>
                <AssistantUpgradesPanel assistantId={selected.id} />
              </section>
              <section>
                <h3 className="mb-3 text-body-large-default text-[var(--content-default)]">
                  {t("assistantsPage.backupsSection")}
                </h3>
                <AssistantBackupsTable assistantId={selected.id} />
              </section>
            </>
          )}
        </div>
      )}
    </AccountShell>
  );
}
