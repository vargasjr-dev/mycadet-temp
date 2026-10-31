import { CloudOff, Globe, Link2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { CreateAssistantDialog } from "@app/components/create-assistant-dialog";
import { RetireConfirmDialog } from "@app/components/retire-confirm-dialog";
import { RemoveFromDeviceDialog } from "@app/components/remove-from-device-dialog";
import { AddRemoteOriginDialog } from "@app/components/account/add-remote-origin-dialog";
import { ConnectAssistantDialog } from "@app/components/account/connect-assistant-dialog";
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
  isLocalModeHostAvailable,
  unpairLocalAssistant,
  type LockfileAssistant,
} from "@app/assistant/local-mode-host";
import {
  getGatewayUrl,
  isLoopbackGatewayCloud,
} from "@mycadet/local-mode/contract";
import { useConnectDialogStore } from "@app/stores/connect-dialog-store";
import { useLocalLockfileStore } from "@app/stores/local-lockfile-store";
import {
  useRememberedOriginsStore,
  type RememberedOrigin,
} from "@app/stores/remembered-origins-store";
import { Button } from "@mycadet/design-library/components/button";
import { useTranslation } from "@app/i18n";
import { useAssistantChoices } from "@app/assistant/use-assistant-choices";
import { retireCloudAssistant } from "@app/assistant/retire-cloud-assistant";
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
  const [addOriginOpen, setAddOriginOpen] = useState(false);
  const [removeOriginTarget, setRemoveOriginTarget] =
    useState<RememberedOrigin | null>(null);
  const [removeOriginPending, setRemoveOriginPending] = useState(false);
  const [removeOriginError, setRemoveOriginError] = useState<string | null>(
    null,
  );
  const { state, retry } = useAssistantChoices();
  const status =
    state.status === "selection" && state.assistants.length === 0
      ? "empty"
      : state.status;

  // The connect flow's gate: only a runtime with a local-mode host (the
  // Electron shell) can pair, list the lockfile arm, or wake/retire locals.
  const localModeHostAvailable = isLocalModeHostAvailable();
  // Target of the paired-entry "remove from this device" (unpair) dialog.
  const [unpairTarget, setUnpairTarget] = useState<LockfileAssistant | null>(
    null,
  );
  const [unpairPending, setUnpairPending] = useState(false);
  const [unpairError, setUnpairError] = useState<string | null>(null);
  const connectDialogOpen = useConnectDialogStore.use.open();
  const connectInitialAddress = useConnectDialogStore.use.initialAddress();
  const connectGuidanceKind = useConnectDialogStore.use.guidanceKind();
  const lockfile = useLocalLockfileStore.use.lockfile();

  // The lockfile arm: every entry whose gateway this machine can address —
  // the machine's own local assistants and connect imports (custom remotes)
  // alike.
  const lockfileEntries =
    lockfile?.assistants.filter(
      (entry) =>
        isLoopbackGatewayCloud(entry.cloud) || entry.cloud === "custom",
    ) ?? [];

  // The lockfile hydrates on mount (Electron only — a no-op elsewhere), so a
  // returning chooser renders its paired entries on the first paint after
  // that read.
  useEffect(() => {
    if (localModeHostAvailable) {
      void useLocalLockfileStore.load();
    }
  }, [localModeHostAvailable]);

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
    setRemoveOriginError(null);
  };

  const handleRemoveOriginConfirm = async () => {
    if (!removeOriginTarget || removeOriginPending) {
      return;
    }
    setRemoveOriginPending(true);
    await useRememberedOriginsStore.removeOrigin(removeOriginTarget.url);
    setRemoveOriginPending(false);
    // removeOrigin resolves silently on a persistence failure, so the entry
    // still being listed is the failure signal — the dialog stays open.
    const stillListed = useRememberedOriginsStore
      .getState()
      .origins.some((o) => o.url === removeOriginTarget.url);
    if (stillListed) {
      setRemoveOriginError(t("addRemoteOriginDialog.addFailed"));
      return;
    }
    closeRemoveOriginDialog();
  };

  // `deviceCode` is one-time credential material and is never persisted: the
  // store holds the base alone, and the code lives just long enough to ride
  // the navigation into the origin's own pair page.
  const handleOriginAdded = (
    origin: RememberedOrigin,
    deviceCode: string | null,
  ) => {
    setAddOriginOpen(false);
    // Landing on the origin runs its own pair flow when no session exists.
    void switchToOrigin(origin, deviceCode ?? undefined);
  };

  /**
   * Connect a lockfile entry: navigate, full stop. Recovery is the app
   * shell's job — an entry whose gateway can't resolve lands on the
   * not-ready panel's wake, whatever its remote type.
   */
  const connectEntry = (entry: LockfileAssistant): void => {
    void navigate(routes.assistant, {
      state: assistantSelectionState(entry.assistantId),
    });
  };

  const closeUnpairDialog = () => {
    if (unpairPending) {
      return;
    }
    setUnpairTarget(null);
    setUnpairError(null);
  };

  const handleUnpairConfirm = async () => {
    if (!unpairTarget || unpairPending) {
      return;
    }
    setUnpairPending(true);
    setUnpairError(null);
    const result = await unpairLocalAssistant(unpairTarget.assistantId);
    setUnpairPending(false);
    if (!result.ok) {
      setUnpairError(result.error);
      return;
    }
    closeUnpairDialog();
    void useLocalLockfileStore.load();
  };

  const handleImported = (assistantId: string) => {
    useConnectDialogStore.getState().closeConnectDialog();
    // The import persists the lockfile entry host-side before resolving, so
    // the store already lists the new entry after this load; the fallback
    // keeps the connect alive if the read lags.
    void (async () => {
      await useLocalLockfileStore.load();
      const imported = useLocalLockfileStore
        .getState()
        .lockfile?.assistants.find((a) => a.assistantId === assistantId);
      if (imported) {
        connectEntry(imported);
        return;
      }
      void navigate(routes.assistant, {
        state: assistantSelectionState(assistantId),
      });
    })();
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
        {lockfileEntries.map((entry, index) => {
          // The classification asks the entry's own Remote-typed cloud
          // directly — no intermediate kind to maintain. Every non-local kind
          // names its own gateway host — the actual remote.
          const remoteGateway = entry.cloud === "custom";
          const label = entry.name ?? entry.assistantId;
          const subtitle = remoteGateway
            ? new URL(getGatewayUrl(entry)).hostname
            : entry.cloud === "cloud"
              ? t("selectAssistantScreen.cloudHostedWithHost", {
                  host: new URL(getGatewayUrl(entry)).hostname,
                })
              : t("selectAssistantScreen.localAssistant");
          return (
            <ChooserCard
              key={entry.assistantId}
              icon={
                <ChooserAvatarChip avatarUrl={null} name={label} size={48} />
              }
              title={label}
              subtitle={subtitle}
              removeMenu={
                remoteGateway ? (
                  <OriginCardMenu
                    label={label}
                    onRemove={() => setUnpairTarget(entry)}
                  />
                ) : undefined
              }
              tabStop={
                state.status === "selection" &&
                state.assistants.length === 0 &&
                index === 0
              }
              onSelect={() => connectEntry(entry)}
            />
          );
        })}
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
        {/* A runtime with a local-mode host pairs in place through the
            connect dialog (the exchange runs in the shell's main process);
            hostless surfaces (hub browser, remote-gateway mode, native
            mobile) add an origin by address or pairing link and navigate to
            it. */}
        {localModeHostAvailable ? (
          <DashedActionButton
            icon={<Link2 className="h-4 w-4" />}
            label={t("selectAssistantScreen.connectRemote")}
            onClick={() => useConnectDialogStore.getState().openConnectDialog()}
          />
        ) : (
          <DashedActionButton
            icon={<Globe className="h-4 w-4" />}
            label={t("selectAssistantScreen.addRemote")}
            onClick={() => setAddOriginOpen(true)}
          />
        )}
        {(status === "unauthenticated" || status === "empty") && (
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
        <AddRemoteOriginDialog
          open={addOriginOpen}
          onClose={() => setAddOriginOpen(false)}
          onAdded={handleOriginAdded}
        />
        <RemoveFromDeviceDialog
          open={removeOriginTarget != null}
          assistantName={
            removeOriginTarget
              ? originLabel(removeOriginTarget)
              : t("selectAssistantScreen.unnamedAssistant")
          }
          errorMessage={removeOriginError ?? undefined}
          isPending={removeOriginPending}
          onConfirm={() => void handleRemoveOriginConfirm()}
          onCancel={closeRemoveOriginDialog}
        />
        <RemoveFromDeviceDialog
          open={unpairTarget != null}
          assistantName={
            unpairTarget
              ? (unpairTarget.name ?? unpairTarget.assistantId)
              : t("selectAssistantScreen.unnamedAssistant")
          }
          errorMessage={unpairError ?? undefined}
          isPending={unpairPending}
          onConfirm={() => void handleUnpairConfirm()}
          onCancel={closeUnpairDialog}
        />
        <ConnectAssistantDialog
          open={connectDialogOpen}
          initialAddress={connectInitialAddress ?? undefined}
          guidanceKind={connectGuidanceKind ?? undefined}
          onClose={() => useConnectDialogStore.getState().closeConnectDialog()}
          onImported={handleImported}
        />
      </div>
    </AccountShell>
  );
}
