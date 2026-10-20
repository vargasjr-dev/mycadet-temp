import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { CreateAssistantDialog } from "@app/components/create-assistant-dialog";
import { RetireConfirmDialog } from "@app/components/retire-confirm-dialog";
import { RetireCardMenu } from "@app/components/account/retire-card-menu";
import { AccountShell } from "@app/components/account/account-shell";
import { AccountHeading } from "@app/components/account/account-form";
import { ChooserAvatarChip } from "@app/components/account/chooser-avatar-chip";
import { ChooserCard } from "@app/components/account/chooser-card";
import { handleRadioCardArrowNav } from "@app/components/account/radio-card-nav";
import { Button } from "@mycadet/design-library/components/button";
import { useTranslation } from "@app/i18n";
import { readInjectedConfig } from "@app/lib/injected-config";
import { useAssistantChoices } from "@app/assistant/use-assistant-choices";
import { retireCloudAssistant } from "@app/assistant/retire-cloud-assistant";
import { assistantSelectionState } from "@app/assistant/assistant-selection";
import { routes } from "@app/utils/routes";
import { formatRelativeDate } from "@app/utils/format-date";

/**
 * The chooser lists cloud assistants only, so web's assistantSubtitle hosting
 * tree (paired, self-hosted, local) collapses to one label here; web's other
 * branches arrive with their own transports (chooser roadmap steps 4-5).
 */
function assistantSubtitle(created: string | null | undefined): string {
  if (!created) {
    return "Cloud-hosted";
  }
  return `Cloud-hosted · Created ${formatRelativeDate(created)}`;
}

export function SelectAssistantScreen() {
  const { t } = useTranslation("account");
  const config = readInjectedConfig();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [retireTarget, setRetireTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [retirePending, setRetirePending] = useState(false);
  const [retireError, setRetireError] = useState<string | null>(null);
  const { state, retry } = useAssistantChoices({
    // The boot bundle's webview origin has no /v1 router, so it resolves
    // against the stamped control plane; served surfaces fall back to the
    // cloud backend base they've always used.
    apiBaseUrl: config?.assistantsApiUrl ?? config?.cloudUrl,
    origin: window.location.origin,
  });
  const status =
    state.status === "selection" && state.assistants.length === 0
      ? "empty"
      : state.status;

  const closeRetireDialog = () => {
    if (retirePending) {
      return;
    }
    setRetireTarget(null);
    setRetireError(null);
  };

  const handleRetireConfirm = async () => {
    if (!retireTarget || retirePending) {
      return;
    }
    setRetirePending(true);
    const outcome = await retireCloudAssistant(retireTarget.id);
    setRetirePending(false);
    // A failure keeps the dialog open with the cloud's detail beside the
    // retry button — web's chooser-remove shape. Success closes and
    // refreshes the list, which is what actually removes the row.
    if (!outcome.ok) {
      setRetireError(outcome.error);
      return;
    }
    closeRetireDialog();
    retry();
  };

  return (
    <AccountShell>
      <AccountHeading title={t("appShell.selection")} />
      <div
        role="radiogroup"
        aria-label={t("selectAssistantScreen.listAriaLabel")}
        onKeyDown={handleRadioCardArrowNav}
        className="flex flex-col gap-3"
      >
        {state.status === "selection" &&
          state.assistants.map((assistant, index) => (
            <ChooserCard
              key={assistant.id}
              icon={
                <ChooserAvatarChip
                  avatarUrl={assistant.avatar_url}
                  name={assistant.name}
                  size={48}
                />
              }
              title={assistant.name}
              subtitle={assistantSubtitle(assistant.created)}
              removeMenu={
                <RetireCardMenu
                  label={assistant.name}
                  onRetire={() =>
                    setRetireTarget({ id: assistant.id, name: assistant.name })
                  }
                />
              }
              tabStop={index === 0}
              onSelect={() => {
                void navigate(routes.assistant, {
                  state: assistantSelectionState(assistant.id),
                });
              }}
            />
          ))}
        {status !== "selection" && (
          <p role="status">{t(`appShell.${status}`)}</p>
        )}
        {status === "unauthenticated" && (
          <Link to={routes.account.login}>{t("accountPage.signIn")}</Link>
        )}
        {/* A dead list still leaves a way forward: hatch a new assistant from
            the chooser itself (the dialog's failures toast on their own), so
            an unreachable API reads as a degraded chooser rather than a dead
            end. */}
        {(status === "empty" || status === "error") && (
          <>
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t("selectAssistantScreen.create")}
            </Button>
            <Button variant="outlined" onClick={retry}>
              {t("appShell.retry")}
            </Button>
            <CreateAssistantDialog
              open={creating}
              onClose={() => setCreating(false)}
              onCreated={(id) => {
                void navigate(routes.assistant, {
                  state: assistantSelectionState(id),
                });
              }}
            />
          </>
        )}
        {/* Gated by retireTarget, not by the list status: a row can be
            retired from any state the chooser renders. */}
        <RetireConfirmDialog
          open={retireTarget != null}
          error={retireError}
          isPending={retirePending}
          onConfirm={() => void handleRetireConfirm()}
          onCancel={closeRetireDialog}
        />
      </div>
    </AccountShell>
  );
}
