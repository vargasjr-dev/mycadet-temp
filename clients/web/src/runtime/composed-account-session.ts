import {
  beginCloudAccountOAuth,
  isCloudAccountOAuthInFlight,
  primeCloudAccountSessionToken,
  subscribeCloudAccountLogout,
  useAuthStore,
  whenCloudSessionSettled,
} from "@/stores/auth-store";

export interface ComposedAccountSessionBridge {
  refresh(): Promise<unknown>;
  logout(revokeAccountSession: () => Promise<void>): Promise<void>;
  beginOAuth(): () => void;
  isOAuthActive(): boolean;
  primeSessionToken(token: string): void;
  waitSessionSettled(): Promise<void>;
  subscribeLogout(listener: () => () => void): () => void;
}

/** Web owns assistant reconciliation and cleanup in the composed renderer. */
export function setupComposedAccountSession(
  register: (bridge: ComposedAccountSessionBridge) => () => void,
): () => void {
  return register({
    refresh: () => useAuthStore.getState().refreshSession(),
    logout: (revokeSession) =>
      useAuthStore.getState().logout({ cloudAccount: { revokeSession } }),
    beginOAuth: beginCloudAccountOAuth,
    isOAuthActive: isCloudAccountOAuthInFlight,
    primeSessionToken: primeCloudAccountSessionToken,
    waitSessionSettled: whenCloudSessionSettled,
    subscribeLogout: subscribeCloudAccountLogout,
  });
}
