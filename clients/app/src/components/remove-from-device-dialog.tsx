import { ConfirmDialog } from "@mycadet/design-library/components/confirm-dialog";

import { useTranslation } from "@app/i18n";
import { useCallback, useState } from "react";
import { useRememberedOriginsStore } from "@app/stores/remembered-origins-store";

export function RemoveFromDeviceDialog({
  url,
  open,
  assistantName,
  closeDialog,
}: {
  url: string;
  open: boolean;
  assistantName: string;
  closeDialog: () => void;
}) {
  const { t } = useTranslation();
  const [isPending, setIsPending] = useState(false);
  const [errorMessage, setRemoveOriginError] = useState<string | null>(null);

  const handleRemoveOriginConfirm = useCallback(async () => {
    if (!isPending) {
      return;
    }
    setIsPending(true);
    await useRememberedOriginsStore.removeOrigin(url);
    setIsPending(false);
    // removeOrigin resolves silently on a persistence failure, so the entry
    // still being listed is the failure signal — the dialog stays open.
    const stillListed = useRememberedOriginsStore
      .getState()
      .origins.some((o) => o.url === url);
    if (stillListed) {
      setRemoveOriginError(t("removeFromDeviceDialog.removeFailed"));
      return;
    }
    closeDialog();
  }, [isPending]);

  const onCancel = useCallback(() => {
    setRemoveOriginError(null);
    closeDialog();
  }, []);

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
      onConfirm={handleRemoveOriginConfirm}
      onCancel={onCancel}
    />
  );
}
