import { useAuthStore } from "@web/stores/auth-store";

/** Temporary bridge to the boot-owned auth store; account gating needs only this signal. */
export function useAccountCloudSession(): "unknown" | "absent" | "present" {
  return useAuthStore((state) => state.cloudSession);
}
