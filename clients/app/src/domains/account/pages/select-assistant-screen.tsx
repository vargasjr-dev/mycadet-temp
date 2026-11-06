import { CloudOff, Globe, Link2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { CreateAssistantDialog } from "@app/components/create-assistant-dialog";
import { RetireConfirmDialog } from "@app/components/retire-confirm-dialog";
import { RemoveFromDeviceDialog } from "@app/components/remove-from-device-dialog";
import { OriginCardMenu } from "@app/components/account/origin-card-menu";
import { RetireCardMenu } from "@app/components/account/retire-card-menu";
import { AccountShell } from "@app/components/account/account-shell";
import { AccountHeading } from "@app/components/account/account-form";
import { ChooserAvatarChip } from "@app/components/account/chooser-avatar-chip";
import { ChooserCard } from "@app/components/account/chooser-card";
import { handleRadioCardArrowNav } from "@app/components/account/radio-card-nav";
import { readInjectedConfig } from "@app/lib/injected-config";
import { switchToOrigin, isCurrentOrigin } from "@app/assistant/switch-origin";
import {
  useRememberedOriginsStore,
  type RememberedOrigin,
} from "@app/stores/remembered-origins-store";
import { Button } from "@mycadet/design-library/components/button";
import { useTranslation } from "@app/i18n";
import { useAssistantChoices } from "@app/assistant/use-assistant-choices";
import { retireAssistant } from "@app/assistant/retire-assistant";
import { assistantSelectionState } from "@app/assistant/assistant-selection";
import { routes } from "@app/utils/routes";
import { formatRelativeDate } from "@app/utils/format-date";

/**
 * The chooser's rows come from the origin's own list endpoint, so each row
 * labels itself: the row's own `remote` field — where that assistant lives
 * (the values `cadet hatch --remote` records), stamped by the serving
 * control plane. Rows from servers predating the stamp fall back to the
 * build's injected `remote`. The serving origin alone can't answer this for
 * the mobile shells: the capacitor bundle's origin is the webview's
 * (`capacitor://localhost`), not the assistant's. Web's other branches
 * (paired, local lockfile entries) arrive with their own transports
 * (chooser roadmap steps 4-5).
 */
function assistantSubtitle(
  hostingLabel: string,
  created: string | null | undefined,
): string {
  if (!created) {
    return hostingLabel;
  }
  return `${hostingLabel} · Created ${formatRelativeDate(created)}`;
}

/**
 * What an origin card renders from. The label is the remembered name when one
 * arrived via a pairing artifact, the hostname standing in until then.
 */
function originLabel(origin: Pick<RememberedOrigin, "name" | "url">): string {
  return origin.name ?? new URL(origin.url).hostname;
}

/** Dashed list-level action row under the chooser's cards. */
function DashedActionButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        "flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--border-element)]/50 px-5 py-3 text-[var(--content-tertiary)]",
        "cursor-pointer transition-all duration-200 ease-out",
        "hover:border-[var(--border-element)] hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
      ].join(" ")}
    >
      {icon}
      <span className="text-body-medium-default">{label}</span>
    </button>
  );
}

export function SelectAssistantScreen() {
  const { t } = useTranslation("account");
  const navigate = useNavigate();
  // Each row labels itself with its own `remote`; servers predating the
  // stamp fall back to the build's own (`readInjectedConfig()?.remote`).
  const buildRemote = readInjectedConfig()?.remote;
  const [creating, setCreating] = useState(false);
  const [retireTarget, setRetireTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [retirePending, setRetirePending] = useState(false);
  const [retireError, setRetireError] = useState<string | null>(null);
  // The remembered-origin list and the dialogs that manage it.
  const originEntries = useRememberedOriginsStore.use.origins();
  const [removeOriginTarget, setRemoveOriginTarget] =
    useState<RememberedOrigin | null>(null);
  const [removeOriginPending, setRemoveOriginPending] = useState(false);
  const { state, retry } = useAssistantChoices();
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

  // The remembered origins hydrate from device-local storage on mount, so a
  // returning chooser renders its entries on the first paint after that load.
  useEffect(() => {
    void useRememberedOriginsStore.hydrate();
  }, []);

  const closeRemoveOriginDialog = () => {
    if (removeOriginPending) {
      return;
    }
    setRemoveOriginTarget(null);
  };

  const handleRetireConfirm = async () => {
    if (!retireTarget || retirePending) {
      return;
    }
    setRetirePending(true);
    const outcome = await retireAssistant(retireTarget.id);
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
              subtitle={assistantSubtitle(
                (assistant.remote ?? buildRemote) === "cloud"
                  ? t("selectAssistantScreen.cloudHosted")
                  : t("selectAssistantScreen.selfHosted"),
                assistant.created,
              )}
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
        {status === "error" && (
          <ChooserCard
            icon={
              <CloudOff
                size={22}
                aria-hidden="true"
                className="text-[var(--content-tertiary)]"
              />
            }
            title={t("appShell.error")}
            disabled
          />
        )}
        {originEntries.map((origin, index) => {
          // Selecting a remembered origin leaves the app for that
          // deployment; the one already serving this bundle just re-enters
          // its assistant route.
          const current = isCurrentOrigin(origin);
          return (
            <ChooserCard
              key={origin.url}
              icon={<Globe className="h-5 w-5" />}
              title={originLabel(origin)}
              subtitle={t(
                current
                  ? "selectAssistantScreen.currentWithHost"
                  : "selectAssistantScreen.remoteWithHost",
                {
                  host: new URL(origin.url).hostname,
                },
              )}
              removeMenu={
                <OriginCardMenu
                  label={originLabel(origin)}
                  onRemove={() => setRemoveOriginTarget(origin)}
                />
              }
              tabStop={
                state.status === "selection" &&
                state.assistants.length === 0 &&
                index === 0
              }
              onSelect={() => {
                if (current) {
                  void navigate(routes.assistant);
                } else {
                  void switchToOrigin(origin);
                }
              }}
            />
          );
        })}
        <DashedActionButton
          icon={<Link2 className="h-4 w-4" />}
          label={t("selectAssistantScreen.hatchAssistant")}
          onClick={() => navigate(routes.account.onboarding.hosting)}
        />
        {(status === "unauthenticated" || status === "empty") && (
          <p role="status">{t(`appShell.${status}`)}</p>
        )}
        {status === "unauthenticated" && (
          <Link to={routes.account.login}>{t("accountPage.signIn")}</Link>
        )}
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
        <RetireConfirmDialog
          open={retireTarget != null}
          error={retireError}
          isPending={retirePending}
          onConfirm={() => void handleRetireConfirm()}
          onCancel={closeRetireDialog}
        />
        <RemoveFromDeviceDialog
          url={removeOriginTarget?.url ?? ""}
          open={removeOriginTarget != null}
          assistantName={
            removeOriginTarget
              ? originLabel(removeOriginTarget)
              : t("selectAssistantScreen.unnamedAssistant")
          }
          closeDialog={closeRemoveOriginDialog}
        />
      </div>
    </AccountShell>
  );
}
