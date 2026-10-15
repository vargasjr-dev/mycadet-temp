import { DetailCard } from "@/components/detail-card";
import { useTranslation } from "@/i18n";
export function TeleportCard() {
  const { t } = useTranslation("settings");
  return (
    <DetailCard title={t("teleportCard.title")}>
      <p>{t("teleportCard.cliOnly")}</p>
    </DetailCard>
  );
}
