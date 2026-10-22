import { useMemo } from "react";

import { useAuthStore } from "@app/stores/auth-store";

import { readConsentCurrency, type ConsentCurrency } from "./consent-persistence";

export interface ConsentGateState {
  /** False while the session or user identity is still resolving. */
  settled: boolean;
  /** Whether there is a live platform session to consent against. */
  hasPlatformSession: boolean;
  userId: string | null;
  currency: ConsentCurrency | null;
}

/**
 * The shell consent gate's read model, mirroring web's resolver semantics:
 * consent is a cloud-account concern, so the gate only decides once there is
 * a platform session and a user id to read acks against. Awaiting those
 * signals reads `settled: false`.
 */
export function useConsentGate(): ConsentGateState {
  const user = useAuthStore.use.user();
  const sessionStatus = useAuthStore(
    (state: { sessionStatus: string; cloudSession: string }) =>
      `${state.sessionStatus}:${state.cloudSession}`,
  );

  return useMemo(() => {
    const [status, cloudSession] = sessionStatus.split(":") as [
      string,
      string,
    ];
    const settled =
      status !== "initializing" && cloudSession !== "unknown";
    const hasPlatformSession = cloudSession === "present";
    const userId = user?.id ?? null;
    return {
      settled,
      hasPlatformSession,
      userId,
      currency:
        settled && hasPlatformSession && userId
          ? readConsentCurrency(userId)
          : null,
    };
  }, [sessionStatus, user?.id]);
}
