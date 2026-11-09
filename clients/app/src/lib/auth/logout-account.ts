import { logoutAccountSession } from "@app/lib/auth/session-client";
import { getElectronBridge } from "@app/runtime/electron-bridge";
import { deleteBiometricToken } from "@app/runtime/native-biometric";

/** Revoke account credentials and clear host credentials without assistant state. */
export async function logoutAccount(): Promise<void> {
  try {
    await logoutAccountSession();
  } finally {
    const bridge = getElectronBridge();
    await Promise.allSettled([
      Promise.resolve().then(() => bridge?.auth?.signOut?.()),
      deleteBiometricToken(),
      !bridge ? fetch("/v1/session", { method: "DELETE" }) : Promise.resolve(),
    ]);
  }
}
