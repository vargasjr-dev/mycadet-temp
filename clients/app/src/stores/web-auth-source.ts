import { useAuthStore as webAuthStore } from "@web/stores/auth-store";
import { createAccountAuthReader } from "@app/stores/auth-snapshot";

/** Temporary source adapter while web boot owns session probes and logout cleanup. */
export const accountAuthSource = createAccountAuthReader({
  getSnapshot: () => webAuthStore.getState(),
  subscribe: (listener) => webAuthStore.subscribe(listener),
});
