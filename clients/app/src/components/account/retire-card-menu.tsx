import { EllipsisVertical } from "lucide-react";
import { ActionMenu } from "@mycadet/design-library/components/action-menu";
import { Button } from "@mycadet/design-library/components/button";
import { useTranslation } from "@app/i18n";

/**
 * Overflow menu on a chooser row opening the retire confirmation. The app's
 * chooser lists cloud assistants only, so unlike web's device-local "Remove
 * from this device" menu, the one destructive command a row offers is the
 * account-wide retire.
 */
export function RetireCardMenu({
  label,
  onRetire,
}: {
  /** The row's label, for the trigger's aria name. */
  label: string;
  /** Opens the retire confirmation. */
  onRetire: () => void;
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
          label={t("selectAssistantScreen.retire")}
          onSelect={onRetire}
        />
      </ActionMenu.Content>
    </ActionMenu.Root>
  );
}
