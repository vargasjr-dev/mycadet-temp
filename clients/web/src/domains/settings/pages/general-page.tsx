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
import { NativeAppCard } from "@/domains/settings/components/native-app-card";
import { PairDeviceCard } from "@/domains/settings/pair-device/pair-device-card";
import { PreferencesModal } from "@/domains/settings/components/preferences-modal";
import { TimezoneSection } from "@/domains/settings/components/timezone-section";
import { ThisDeviceSection } from "@/domains/settings/components/this-device-section";
import { TeleportCard } from "@/domains/settings/teleport/teleport-card";
import { Button } from "@mycadet/design-library/components/button";

import { isElectron } from "@/runtime/is-electron";
import { useTranslation } from "@/i18n";
import { routes } from "@/utils/routes";

export function GeneralPage() {
  const { t } = useTranslation("settings");
  const { assistantId, healthz, healthzLoading } = useAssistantWithHealthz();
  const navigate = useNavigate();
  const diskPressure = useDiskPressureMonitor();
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

  useEffect(() => {
    if (window.location.hash !== "#storage-resources") {
      return;
    }

    requestAnimationFrame(() => {
      document
        .getElementById("storage-resources")
        ?.scrollIntoView({ block: "start" });
    });
  }, []);

  const versionValue = healthz?.version ?? null;

  const openAssistantChooser = () => {
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
        />
      )}

      <ProfileCard>
        <TimezoneSection />
        <ThisDeviceSection />
      </ProfileCard>

      <DetailCard
        title={t("generalPage.versionTitle")}
        subtitle={t("generalPage.versionSubtitle")}
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-y-3">
            <span className="text-body-medium-default text-[var(--content-tertiary)]">
              {t("generalPage.current")}
            </span>
            {healthzLoading ? (
              <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
                —
              </span>
            ) : (
              <span className="break-all text-body-medium-lighter text-[var(--content-default)]">
                {versionValue ?? "—"}
              </span>
            )}
          </div>
        </div>
      </DetailCard>
      <DetailCard
        title={t("generalPage.accountTitle")}
        subtitle={t("generalPage.accountSubtitle")}
        accessory={
          <Button
            variant="outlined"
            disabled={!assistantId}
            onClick={() =>
              assistantId &&
              void navigate(routes.account.assistantDetail(assistantId))
            }
          >
            {t("generalPage.accountManage")}
          </Button>
        }
      />

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
