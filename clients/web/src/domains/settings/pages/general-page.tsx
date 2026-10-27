import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useDiskPressureMonitor } from "@/assistant/use-disk-pressure-monitor";
import { ThemePicker } from "@/domains/settings/components/theme-picker";
import { DetailCard } from "@/components/detail-card";
import {
  DiskPressureBanner,
  type DiskPressureBannerMode,
} from "@/components/disk-pressure-banner";
import { ProfileCard } from "@/components/profile-card";
import { AppIconRow } from "@/domains/settings/components/app-icon-row";
import { useAssistantWithHealthz } from "@/domains/settings/components/assistant-status-panel";
import {
  AssistantUpgrades,
  LocalAssistantUpgrades,
} from "@/domains/settings/components/assistant-upgrades";
import { NativeAppCard } from "@/domains/settings/components/native-app-card";
import { PairDeviceCard } from "@/domains/settings/pair-device/pair-device-card";
import { PreferencesModal } from "@/domains/settings/components/preferences-modal";
import { TimezoneSection } from "@/domains/settings/components/timezone-section";
import { ThisDeviceSection } from "@/domains/settings/components/this-device-section";
import { UpdateWindowModal } from "@/domains/settings/components/update-window-modal";
import { TeleportCard } from "@/domains/settings/teleport/teleport-card";
import { Button } from "@mycadet/design-library/components/button";

import { useActiveAssistantIsCloudHosted } from "@/assistant/hosting";
import { remoteGatewayPublicBaseUrl } from "@/lib/auth/remote-gateway-session";
import {
  getRemoteAssistantDisplayName,
  getRemoteGatewayHubUrl,
  getActiveAssistant,
  isLocalAssistant,
  isLocalClient,
  isCadetCloudRemote,
} from "@/lib/local-mode";
import { isElectron } from "@/runtime/is-electron";
import { useIsNativeMobile } from "@/runtime/platform-detection";
import { useTranslation } from "@/i18n";
import { cloudAccountBillingUrl } from "@/lib/cloud-runtime-url";
import { openExternalUrl } from "@/runtime/browser";
import { routes } from "@/utils/routes";

export function GeneralPage() {
  const { t } = useTranslation("settings");
  const { assistant, healthz, healthzLoading, refetch } =
    useAssistantWithHealthz();
  const isNativeMobile = useIsNativeMobile();
  const navigate = useNavigate();
  const isCloudHosted = useActiveAssistantIsCloudHosted();
  const diskPressure = useDiskPressureMonitor({
    assistantId: assistant?.id ?? null,
    enabled: isCloudHosted,
  });
  const [updateWindowOpen, setUpdateWindowOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  // The keyboard-shortcuts redirect stub and tab aliases land here with
  // `?preferences=open` to surface the Preferences modal directly. Consume
  // the param so refresh/back does not reopen the modal.
  useEffect(() => {
    if (searchParams.get("preferences") !== "open") {
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.delete("preferences");
    setSearchParams(next, { replace: true });
    setPreferencesOpen(true);
  }, [searchParams, setSearchParams]);

  const selected = getActiveAssistant();
  const hasSelectedLocalAssistant =
    isLocalClient() && !!assistant && !!selected && isLocalAssistant(selected);
  const canUpgradeLocally = hasSelectedLocalAssistant && !!isCadetCloudRemote();
  // Whether an upgrade panel (platform or local) is on screen. Both panels
  // render the "Current" version line that carries the 7-tap developer-mode
  // unlock, so when neither shows we must render a standalone version line to
  // avoid dropping both the version display and the only unlock affordance
  // (e.g. logged out of the cloud, or a self-hosted/remote-gateway runtime
  // that can't upgrade locally).
  const showsUpgradePanel = (isCloudHosted || canUpgradeLocally) && !!assistant;

  useEffect(() => {
    if (!assistant || window.location.hash !== "#storage-resources") {
      return;
    }

    requestAnimationFrame(() => {
      document
        .getElementById("storage-resources")
        ?.scrollIntoView({ block: "start" });
    });
  }, [assistant]);

  const versionValue =
    healthz?.version ?? assistant?.current_release_version ?? null;

  const openAssistantChooser = () => {
    const hubUrl = getRemoteGatewayHubUrl();
    if (!isCadetCloudRemote() && !isNativeMobile && hubUrl) {
      // Self-registration handoff: landing on the hub chooser records this
      // origin in the hub's remembered list. `hubUrl` is the hub SPA's
      // assistant root (`<origin>/assistant`), so the absolute chooser route
      // hangs off its origin.
      const params = new URLSearchParams({
        register: remoteGatewayPublicBaseUrl(),
      });
      const assistantName = getRemoteAssistantDisplayName();
      if (assistantName) {
        params.set("name", assistantName);
      }
      const hubOrigin = new URL(hubUrl).origin;
      window.location.assign(
        `${hubOrigin}/account/select-assistant?${params.toString()}`,
      );
      return;
    }
    void navigate(routes.assistant);
  };

  return (
    <div className="space-y-4">
      {diskPressure.status && diskPressure.mode !== "inactive" && (
        <DiskPressureBanner
          status={diskPressure.status}
          mode={diskPressure.mode as DiskPressureBannerMode}
          isAcknowledging={diskPressure.isAcknowledging}
          acknowledgeError={diskPressure.acknowledgeError?.message ?? null}
          onAcknowledge={() => void diskPressure.acknowledge()}
          onReviewWorkspaceData={() =>
            void navigate(`${routes.workspace}?sort=size`)
          }
          onUpgradeStorage={
            isCloudHosted
              ? () => void openExternalUrl(cloudAccountBillingUrl())
              : null
          }
        />
      )}

      <ProfileCard assistant={assistant} showHandles={isCloudHosted}>
        <TimezoneSection />
        <ThisDeviceSection />
      </ProfileCard>

      <DetailCard
        title={t("generalPage.versionTitle")}
        subtitle={t("generalPage.versionSubtitle")}
        accessory={
          isCloudHosted && assistant ? (
            <Button
              variant="outlined"
              onClick={() => setUpdateWindowOpen(true)}
            >
              {t("generalPage.updateWindow")}
            </Button>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-4">
          {isCloudHosted && assistant && (
            <>
              <AssistantUpgrades
                assistantId={assistant.id}
                currentVersion={versionValue}
                onUpgradeComplete={() => {
                  void refetch();
                }}
              />
            </>
          )}
          {canUpgradeLocally && assistant && (
            <LocalAssistantUpgrades
              assistantId={assistant.id}
              currentVersion={versionValue}
              onUpgradeComplete={() => {
                void refetch();
              }}
            />
          )}
          {!showsUpgradePanel && assistant && (
            <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-y-3">
              <span className="text-body-medium-default text-[var(--content-tertiary)]">
                {t("generalPage.current")}
              </span>
              {healthzLoading && !assistant.current_release_version ? (
                <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
                  —
                </span>
              ) : (
                <span className="break-all text-body-medium-lighter text-[var(--content-default)]">
                  {versionValue ?? "—"}
                </span>
              )}
            </div>
          )}
        </div>
      </DetailCard>
      {isCloudHosted && assistant && (
        <UpdateWindowModal
          assistantId={assistant.id}
          open={updateWindowOpen}
          onClose={() => setUpdateWindowOpen(false)}
        />
      )}

      <DetailCard
        title={t("generalPage.preferencesTitle")}
        subtitle={t("generalPage.preferencesSubtitle")}
        accessory={
          <Button variant="outlined" onClick={() => setPreferencesOpen(true)}>
            {t("generalPage.customize")}
          </Button>
        }
      >
        <div className="flex flex-col gap-5">
          <ThemePicker />
          <AppIconRow />
        </div>
      </DetailCard>

      <PreferencesModal
        open={preferencesOpen}
        onClose={() => setPreferencesOpen(false)}
      />

      <NativeAppCard />

      <PairDeviceCard />

      <DetailCard
        title={t("generalPage.switchAssistantTitle")}
        subtitle={t("generalPage.switchAssistantSubtitle")}
        accessory={
          <Button variant="outlined" onClick={openAssistantChooser}>
            {t("generalPage.chooseAssistant")}
          </Button>
        }
      />

      {isElectron() && <TeleportCard />}
    </div>
  );
}
