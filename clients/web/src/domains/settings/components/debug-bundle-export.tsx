import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import { exportLocalDebugBundle } from "./diagnostic-export";
import { assistantsDebugBundleUploadUrlCreate } from "@/generated/api/sdk.gen";
import { useTranslation } from "@/i18n";
import { getResolvedAssistant } from "@/stores/resolved-assistant-store";
import { Button } from "@mycadet/design-library/components/button";
import { toast } from "@mycadet/design-library/components/toast";

export function DebugBundleExport({ assistantId }: { assistantId: string }) {
  const { t } = useTranslation("settings");
  const [sentAt, setSentAt] = useState<Date | null>(null);
  const selectedAssistant = getResolvedAssistant();

  const exportBundle = useMutation({
    mutationFn: async () => {
      const { data } = await assistantsDebugBundleUploadUrlCreate({
        path: { id: assistantId },
        throwOnError: true,
      });
      await exportLocalDebugBundle(selectedAssistant, data.url);
    },
    onSuccess: () => {
      setSentAt(new Date());
      toast.success(t("debugBundleExport.toastSent"));
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      toast.error(
        message
          ? t("debugBundleExport.toastFailedWithReason", { reason: message })
          : t("debugBundleExport.toastFailed"),
      );
    },
  });

  return (
    <div className="mt-3 rounded-md border border-[var(--surface-active)] p-3">
      <p className="text-body-small-lighter text-[var(--content-tertiary)]">
        {t("debugBundleExport.description")}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="outlined"
          size="compact"
          disabled={exportBundle.isPending}
          onClick={() => exportBundle.mutate()}
        >
          {exportBundle.isPending && (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          )}
          {exportBundle.isPending
            ? t("debugBundleExport.exporting")
            : t("debugBundleExport.export")}
        </Button>
        {sentAt !== null && !exportBundle.isPending && (
          <p className="text-body-small-lighter text-[var(--content-tertiary)]">
            {t("debugBundleExport.sentAt", {
              time: sentAt.toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              }),
            })}
          </p>
        )}
      </div>
    </div>
  );
}
