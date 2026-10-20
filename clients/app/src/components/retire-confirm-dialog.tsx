import { ConfirmDialog } from "@mycadet/design-library/components/confirm-dialog";
import { useTranslation } from "@app/i18n";

/**
 * Canonical destructive confirmation for retiring an assistant — port of
 * web's `RetireConfirmDialog`, so the irreversible-action warning reads the
 * same on every surface that retires through it.
 */
export function RetireConfirmDialog({
  open,
  error,
  isPending,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  /** Inline failure line; the dialog stays open so the user can retry. */
  error?: string | null;
  isPending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={open}
      title={t("retireConfirmDialog.title")}
      message={t("retireConfirmDialog.message")}
      error={error}
      confirmLabel={t("retireConfirmDialog.confirmLabel")}
      destructive
      isPending={isPending}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
