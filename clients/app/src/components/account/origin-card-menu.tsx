import { EllipsisVertical } from "lucide-react";

import { useTranslation } from "@app/i18n";
import { ActionMenu } from "@mycadet/design-library/components/action-menu";
import { Button } from "@mycadet/design-library/components/button";

/**
 * Overflow menu on a remembered-origin row, opening the remove-from-this-device
 * confirmation — the origin-arm twin of the retire menu, so both row kinds
 * carry their destructive command the same way.
 */
export function OriginCardMenu({
  label,
  onRemove,
}: {
  /** The row's label, for the trigger's aria name. */
  label: string;
  /** Opens the remove confirmation. */
  onRemove: () => void;
}) {
  const { t } = useTranslation("account");
  const actionsAria = t("selectAssistantScreen.rowActionsAriaLabel", {
    name: label,
  });
  return (
    <ActionMenu.Root>
      <ActionMenu.Trigger asChild>
        <Button
          variant="ghost"
          iconOnly={<EllipsisVertical />}
          aria-label={actionsAria}
        />
      </ActionMenu.Trigger>
      <ActionMenu.Content title={actionsAria} align="end" sideOffset={4}>
        <ActionMenu.Item
          tone="destructive"
          label={t("selectAssistantScreen.removeFromDevice")}
          onSelect={onRemove}
        />
      </ActionMenu.Content>
    </ActionMenu.Root>
  );
}
