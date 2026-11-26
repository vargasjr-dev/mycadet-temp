import { Download } from "lucide-react";

import { AppleLogo } from "@/components/icons/apple-logo";
import { NudgeChatBanner } from "@/components/nudges/nudge-chat-banner";
import { useTranslation } from "@/i18n";

interface DesktopAppBannerProps {
  onDownload: () => void;
  onDismiss: () => void;
}

export function DesktopAppBanner({
  onDownload,
  onDismiss,
}: DesktopAppBannerProps) {
  const { t } = useTranslation();

  return (
    <NudgeChatBanner
      icon={<AppleLogo size={16} style={{ color: "var(--content-default)" }} />}
      title={t("desktopAppBanner.titleMacOS")}
      subtitle={t("desktopAppBanner.subtitle")}
      ctaLabel={t("desktopAppBanner.ctaLabel")}
      ctaLeftIcon={<Download />}
      ctaAriaLabel={t("desktopAppBanner.ctaAriaLabelMacOS")}
      ariaLabel={t("desktopAppBanner.ariaLabelMacOS")}
      onAction={onDownload}
      onDismiss={onDismiss}
    />
  );
}
