import { useAccountCloudSession } from "@app/lib/auth/account-session";
import {
  accountCloudGate,
  type AccountCloudGate,
} from "@app/lib/auth/account-cloud-gate";
import { isLocalClient } from "@app/lib/runtime-mode";
import { useDeadlinePassed } from "@app/hooks/use-deadline-passed";

export const ACCOUNT_SESSION_SETTLE_TIMEOUT_MS = 5_000;

/** Bound the account-session probe without consulting the active assistant. */
export function useAccountCloudGate(
  settleTimeoutMs = ACCOUNT_SESSION_SETTLE_TIMEOUT_MS,
): AccountCloudGate {
  const raw = import.meta.env.VITE_CADET_DISABLE_CLOUD?.toLowerCase();
  const gate = accountCloudGate({
    session: useAccountCloudSession(),
    local: isLocalClient(),
    cloudDisabled: raw === "true" || raw === "1",
  });
  const timedOut = useDeadlinePassed(gate === "pending", settleTimeoutMs);
  return gate === "pending" && timedOut ? "disabled" : gate;
}
