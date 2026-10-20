import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { CreateAssistantDialog } from "@app/components/create-assistant-dialog";
import { AccountShell } from "@app/components/account/account-shell";
import { AccountHeading } from "@app/components/account/account-form";
import { ChooserAvatarChip } from "@app/components/account/chooser-avatar-chip";
import { ChooserCard } from "@app/components/account/chooser-card";
import { handleRadioCardArrowNav } from "@app/components/account/radio-card-nav";
import { Button } from "@mycadet/design-library/components/button";
import { useTranslation } from "@app/i18n";
import { readInjectedConfig } from "@app/lib/injected-config";
import { useAssistantRequest } from "@app/assistant/use-assistant-request";
import { assistantSelectionState } from "@app/assistant/assistant-selection";
import { routes } from "@app/utils/routes";

export function SelectAssistantScreen() {
  const { t } = useTranslation("account");
  const config = readInjectedConfig();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const { state, retry } = useAssistantRequest({
    apiBaseUrl: config?.cloudUrl,
    origin: window.location.origin,
    listOnly: true,
  });
  const status =
    state.status === "ready"
      ? "error"
      : state.status === "selection" && state.assistants.length === 0
        ? "empty"
        : state.status;
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
        {status === "empty" && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t("selectAssistantScreen.create")}
          </Button>
        )}
        {(status === "error" || status === "empty") && (
          <Button variant="outlined" onClick={retry}>
            {t("appShell.retry")}
          </Button>
        )}
        {status === "empty" && (
          <CreateAssistantDialog
            open={creating}
            onClose={() => setCreating(false)}
            onCreated={(id) => {
              void navigate(routes.assistant, {
                state: assistantSelectionState(id),
              });
            }}
          />
        )}
      </div>
    </AccountShell>
  );
}
