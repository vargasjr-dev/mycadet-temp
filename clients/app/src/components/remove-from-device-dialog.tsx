import { ConfirmDialog } from "@mycadet/design-library/components/confirm-dialog";

import { useTranslation } from "@app/i18n";

/**
 * The "Remove from this device?" confirmation for a remembered remote origin —
 * web's `RemoveFromDeviceDialog` scoped to its origin arm, so the copy cannot
 * drift from the surfaces that share it. No removal touches the assistant
 * itself, which is what the copy explains: only the entry on this device is
 * forgotten.
 */
export function RemoveFromDeviceDialog({
  open,
  assistantName,
  errorMessage,
  isPending,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  /** The entry's label, echoed in the copy. */
  assistantName: string;
  /** Inline failure line under the message when a removal attempt failed. */
  errorMessage?: string;
  isPending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();

  return (
    <ConfirmDialog
      open={open}
      title={t("removeFromDeviceDialog.title")}
      message={
        <>
          {t("removeFromDeviceDialog.messageOrigin", { assistantName })}
          {errorMessage && (
            <span className="mt-2 block text-[var(--system-negative-strong)]">
              {errorMessage}
            </span>
          )}
        </>
      }
      confirmLabel={t("removeFromDeviceDialog.confirm")}
      destructive
      isPending={isPending}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
