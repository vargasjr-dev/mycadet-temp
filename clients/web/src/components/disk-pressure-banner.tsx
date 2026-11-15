import { AlertTriangle, Package } from "lucide-react";
import { useCallback, useState } from "react";

import { formatDiskPressureUsage } from "@/assistant/disk-pressure";
import { cloudAccountBillingUrl } from "@/lib/cloud-runtime-url";
import { openExternalUrl } from "@/runtime/browser";
import { useTranslation } from "@/i18n";
import type { DiskPressureStatus } from "@mycadet/assistant-api";
import { Button, Checkbox, Modal, Notice } from "@mycadet/design-library";

export type DiskPressureBannerMode =
  | "warning"
  | "acknowledgement-required"
  | "cleanup";

export interface DiskPressureBannerProps {
  status: DiskPressureStatus;
  mode: DiskPressureBannerMode;
  isAcknowledging?: boolean;
  acknowledgeError?: string | null;
  onAcknowledge: () => void;
  /**
   * Called when the user dismisses the warning banner. The `permanent` flag is
   * true when the user also checked "Don't show again" — in that case the
   * caller should suppress the warning across state transitions, not just
   * until the next escalation.
   */
  onDismissWarning?: (permanent: boolean) => void;
  onReviewWorkspaceData?: () => void;
}

export function DiskPressureBanner(props: DiskPressureBannerProps) {
  const {
    status,
    mode,
    isAcknowledging = false,
    acknowledgeError,
    onAcknowledge,
    onDismissWarning,
    onReviewWorkspaceData,
  } = props;
  const { t } = useTranslation();
  const [showAcknowledgeModal, setShowAcknowledgeModal] = useState(false);
  const handleUpgradeStorage = useCallback(() => {
    void openExternalUrl(cloudAccountBillingUrl());
  }, []);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const formattedUsage = formatDiskPressureUsage(status);

  if (mode === "warning") {
    const usagePercent = status.usagePercent ?? 0;

    return (
      <Notice
        tone="warning"
        title={t("diskPressureBanner.warningTitle")}
        icon={<Package className="h-4 w-4" aria-hidden="true" />}
        onDismiss={
          onDismissWarning ? () => onDismissWarning(dontShowAgain) : undefined
        }
        className="p-4"
        data-testid="disk-pressure-banner"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-active)]">
              <div
                className="h-full rounded-full transition-[width] duration-300"
                style={{
                  width: `${usagePercent}%`,
                  backgroundColor: "var(--system-mid-strong)",
                }}
              />
            </div>
            <span className="text-body-medium-default shrink-0 tabular-nums text-[color:var(--system-mid-strong)]">
              {formattedUsage}
            </span>
          </div>
          <p className="m-0">
            {t("diskPressureBanner.warningBodyWithUpgrade")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {onReviewWorkspaceData && (
              <Button
                variant="outlined"
                size="compact"
                onClick={onReviewWorkspaceData}
              >
                {t("diskPressureBanner.manageStorage")}
              </Button>
            )}
            <Button
              variant="outlined"
              size="compact"
              onClick={handleUpgradeStorage}
            >
              {t("diskPressureBanner.upgrade")}
            </Button>
            {onDismissWarning ? (
              <Checkbox
                className="ml-auto"
                checked={dontShowAgain}
                onCheckedChange={(next) => setDontShowAgain(next === true)}
                label={t("diskPressureBanner.dontShowAgain")}
                data-testid="disk-pressure-banner-dont-show-again"
              />
            ) : null}
          </div>
        </div>
      </Notice>
    );
  }

  if (mode === "cleanup") {
    const cleanupPercent = status.usagePercent ?? 0;

    return (
      <Notice
        tone="warning"
        title={t("diskPressureBanner.cleanupTitle")}
        icon={<Package className="h-4 w-4" aria-hidden="true" />}
        className="p-4"
        data-testid="disk-pressure-banner"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-active)]">
              <div
                className="h-full rounded-full transition-[width] duration-300"
                style={{
                  width: `${cleanupPercent}%`,
                  backgroundColor: "var(--system-mid-strong)",
                }}
              />
            </div>
            <span className="text-body-medium-default shrink-0 tabular-nums text-[color:var(--system-mid-strong)]">
              {formattedUsage}
            </span>
          </div>
          <p className="m-0">{t("diskPressureBanner.cleanupBody")}</p>
          <div className="flex flex-wrap gap-2">
            {onReviewWorkspaceData && (
              <Button
                variant="outlined"
                size="compact"
                onClick={onReviewWorkspaceData}
              >
                {t("diskPressureBanner.manageStorage")}
              </Button>
            )}
            <Button
              variant="outlined"
              size="compact"
              onClick={handleUpgradeStorage}
            >
              {t("diskPressureBanner.upgrade")}
            </Button>
          </div>
        </div>
      </Notice>
    );
  }

  const criticalPercent = status.usagePercent ?? 0;

  return (
    <>
      <Notice
        tone="error"
        title={t("diskPressureBanner.criticalTitle")}
        icon={<Package className="h-4 w-4" aria-hidden="true" />}
        className="p-4"
        data-testid="disk-pressure-banner"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-active)]">
              <div
                className="h-full rounded-full transition-[width] duration-300"
                style={{
                  width: `${criticalPercent}%`,
                  backgroundColor: "var(--system-negative-strong)",
                }}
              />
            </div>
            <span className="text-body-medium-default shrink-0 tabular-nums text-[color:var(--system-negative-strong)]">
              {formattedUsage}
            </span>
          </div>
          <p className="m-0">{t("diskPressureBanner.criticalBody")}</p>
          {acknowledgeError ? (
            <span className="text-[var(--system-negative-strong)]" role="alert">
              {acknowledgeError}
            </span>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="compact"
              onClick={() => setShowAcknowledgeModal(true)}
            >
              {t("diskPressureBanner.review")}
            </Button>
          </div>
        </div>
      </Notice>

      <Modal.Root
        open={showAcknowledgeModal}
        onOpenChange={(open) => {
          if (!open) {
            setShowAcknowledgeModal(false);
          }
        }}
      >
        <Modal.Content size="sm">
          <Modal.Header icon={AlertTriangle}>
            <Modal.Title>{t("diskPressureBanner.criticalTitle")}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Modal.Description>
              {t("diskPressureBanner.criticalModalDescription")}
            </Modal.Description>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="outlined"
              onClick={() => {
                setShowAcknowledgeModal(false);
                handleUpgradeStorage();
              }}
            >
              {t("diskPressureBanner.upgrade")}
            </Button>
            <Button
              variant="primary"
              disabled={isAcknowledging}
              onClick={() => {
                onAcknowledge();
                setShowAcknowledgeModal(false);
              }}
            >
              {isAcknowledging
                ? t("diskPressureBanner.acknowledging")
                : t("diskPressureBanner.acknowledge")}
            </Button>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
    </>
  );
}
