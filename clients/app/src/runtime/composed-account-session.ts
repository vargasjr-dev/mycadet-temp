/** Assistant-session behavior supplied only by the composed renderer. */
export interface ComposedAccountSessionBridge {
  refresh(): Promise<unknown>;
  logout(revokeAccountSession: () => Promise<void>): Promise<void>;
  beginOAuth(): () => void;
  isOAuthActive(): boolean;
  primeSessionToken(token: string): void;
  waitSessionSettled(): Promise<void>;
  subscribeLogout(listener: () => () => void): () => void;
}

let active: ComposedAccountSessionBridge | undefined;
let disconnect: (() => void) | undefined;
let installation = 0;
const logoutListeners = new Set<() => () => void>();

export function installComposedAccountSession(
  bridge: ComposedAccountSessionBridge,
): () => void {
  const version = ++installation;
  disconnect?.();
  active = bridge;
  disconnect = bridge.subscribeLogout(() => {
    const finishes = [...logoutListeners].map((listener) => listener());
    let finished = false;
    return () => {
      if (!finished) {
        finished = true;
        finishes.forEach((finish) => finish());
      }
    };
  });
  return () => {
    if (version === installation) {
      installation++;
      disconnect?.();
      disconnect = undefined;
      active = undefined;
    }
  };
}

/** Account requests work independently when there is no assistant session. */
export const composedAccountSession = {
  refresh: () => active?.refresh() ?? Promise.resolve(),
  logout: (revoke: () => Promise<void>) => active?.logout(revoke) ?? revoke(),
  beginOAuth: () => active?.beginOAuth() ?? (() => {}),
  isOAuthActive: () => active?.isOAuthActive() ?? false,
  primeSessionToken: (token: string) => active?.primeSessionToken(token),
  waitSessionSettled: () => active?.waitSessionSettled() ?? Promise.resolve(),
  subscribeLogout(listener: () => () => void): () => void {
    logoutListeners.add(listener);
    return () => {
      logoutListeners.delete(listener);
    };
  },
};
