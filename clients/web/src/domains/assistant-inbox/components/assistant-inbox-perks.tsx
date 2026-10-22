import { Check } from "lucide-react";

import { useTranslation } from "@/i18n";

export interface AssistantInboxPerksProps {
  /** Empty when the assistant has no name yet; the copy then says "your assistant". */
  assistantName: string;
  rootDomain: string;
}

/**
 * The three perks of Cadet Cloud email as the design's pill rows with a green
 * check. Its own piece so the one-time intro modal can set them over a
 * different ending than the upgrade pitch's plan notice.
 */
export function AssistantInboxPerks({
  assistantName,
  rootDomain,
}: AssistantInboxPerksProps) {
  const { t } = useTranslation("assistant-inbox");
  const perks = [
    t("assistantInboxUpgradeState.perkAddress", { rootDomain }),
    assistantName
      ? t("assistantInboxUpgradeState.perkReads", { name: assistantName })
      : t("assistantInboxUpgradeState.perkReadsNoName"),
    t("assistantInboxUpgradeState.perkHistory"),
  ];
  return (
    <ul className="flex w-full flex-col gap-1">
      {perks.map((perk) => (
        <li
          key={perk}
          className="flex items-center gap-2 rounded-full bg-[color-mix(in_srgb,var(--content-default)_6%,transparent)] py-[5px] pl-1 pr-3 text-label-medium-default text-[var(--content-secondary)]"
        >
          <Check
            className="size-4 shrink-0 text-[var(--system-positive-strong)]"
            strokeWidth={2.5}
            aria-hidden="true"
          />
          {perk}
        </li>
      ))}
    </ul>
  );
}
