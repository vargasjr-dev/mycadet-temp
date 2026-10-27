import { useMemo } from "react";

import { useAuthStore } from "@app/stores/auth-store";

import { readConsentCurrency, type ConsentCurrency } from "./consent-persistence";

export interface ConsentGateState {
  /** False while the session or user identity is still resolving. */
  settled: boolean;
  /** Whether there is a live cloud session to consent against. */
  hasCloudSession: boolean;
  userId: string | null;
  currency: ConsentCurrency | null;
}

/**
 * The shell consent gate's read model, mirroring web's resolver semantics:
 * consent is a cloud-account concern, so the gate only decides once there is
 * a cloud session and a user id to read acks against. Awaiting those
 * signals reads `settled: false`.
 */
export function useConsentGate(): ConsentGateState {
  const user = useAuthStore.use.user();
  const sessionStatus = useAuthStore((state) => state.sessionStatus);

  return useMemo(() => {
    const settled = sessionStatus !== "initializing";
    const hasCloudSession = sessionStatus === "authenticated";
    const userId = user?.id ?? null;
    return {
      settled,
      hasCloudSession,
      userId,
      currency:
        settled && hasCloudSession && userId
          ? readConsentCurrency(userId)
          : null,
    };
  }, [sessionStatus, user?.id]);
}
