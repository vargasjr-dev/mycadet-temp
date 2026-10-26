/**
 * The repair for a rejected Cadet Cloud credential, offered on the chat
 * error banner.
 *
 * The assistant cannot mint this credential: the cloud issues it and a
 * signed-in client writes it in. The cloud leaves self-hosted and local
 * registrations to their client on purpose, so this button is that client
 * doing its half, and it is the only in-app way back from a rejected key.
 */
import { useState } from "react";

import { useTranslation } from "@/i18n";
import {
  LocalCloudCredentialRecoveryError,
  type LocalCloudCredentialRecoveryReason,
  recoverLocalAssistantCloudCredential,
} from "@/lib/local-cloud-identity";
import { captureError } from "@/lib/error-reporting/capture-error";
import { Button } from "@mycadet/design-library";
import { toast } from "@mycadet/design-library/components/toast";

export interface RestoreCloudCredentialButtonProps {
  /**
   * Runs once the credential is confirmed working. The banner offering this
   * button describes a failure that no longer holds, so its owner retires
   * it here; a failed attempt leaves the banner in place to try again.
   */
  onRestored?: () => void;
}

/**
 * Catalog key for each typed repair failure. The reader gets a sentence in
 * their language that says what to do next; the thrown message stays in
 * error reporting.
 */
const FAILURE_KEYS: Record<
  LocalCloudCredentialRecoveryReason,
  | "restoreCloudCredentialButton.failedNoAssistant"
  | "restoreCloudCredentialButton.failedCannotActHere"
  | "restoreCloudCredentialButton.failedReplacementRejected"
  | "restoreCloudCredentialButton.failedUnconfirmed"
> = {
  no_assistant: "restoreCloudCredentialButton.failedNoAssistant",
  cannot_act_here: "restoreCloudCredentialButton.failedCannotActHere",
  replacement_rejected:
    "restoreCloudCredentialButton.failedReplacementRejected",
  unconfirmed: "restoreCloudCredentialButton.failedUnconfirmed",
};

export function RestoreCloudCredentialButton({
  onRestored,
}: RestoreCloudCredentialButtonProps) {
  const { t } = useTranslation("chat");
  const [isRestoring, setIsRestoring] = useState(false);

  const restore = async () => {
    setIsRestoring(true);
    try {
      await recoverLocalAssistantCloudCredential();
      toast.success(t("restoreCloudCredentialButton.restored"));
      onRestored?.();
    } catch (err) {
      captureError(err, { context: "restoreCloudCredential" });
      // Only a typed reason reaches the reader. Anything else (a cloud or
      // transport failure with its own text) is reported generically, so raw
      // exception text never stands in for translated copy.
      toast.error(
        t(
          err instanceof LocalCloudCredentialRecoveryError
            ? FAILURE_KEYS[err.reason]
            : "restoreCloudCredentialButton.failedGeneric",
        ),
      );
    } finally {
      setIsRestoring(false);
    }
  };

  // The repair rotates the credential through the cloud. Web no longer
  // gates the affordance on session state: the repair runs and surfaces a
  // cloud failure through its own error toasts when the credential source
  // is unreachable.
  return (
    <Button
      variant="outlined"
      size="compact"
      disabled={isRestoring}
      onClick={() => void restore()}
    >
      {isRestoring
        ? t("restoreCloudCredentialButton.restoring")
        : t("restoreCloudCredentialButton.restore")}
    </Button>
  );
}
