import { useAuthStore } from "@app/stores/auth-store";
import {
  accountCloudGate,
  type AccountCloudGate,
} from "@app/lib/auth/account-cloud-gate";
import { useDeadlinePassed } from "@app/hooks/use-deadline-passed";

export const ACCOUNT_SESSION_SETTLE_TIMEOUT_MS = 5_000;

/** Bound the account-session probe without consulting the active assistant. */
export function useAccountCloudGate(
  settleTimeoutMs = ACCOUNT_SESSION_SETTLE_TIMEOUT_MS,
): AccountCloudGate {
  const gate = accountCloudGate({
    sessionStatus: useAuthStore((state) => state.sessionStatus),
  });
  const timedOut = useDeadlinePassed(gate === "pending", settleTimeoutMs);
  return gate === "pending" && timedOut ? "disabled" : gate;
}
