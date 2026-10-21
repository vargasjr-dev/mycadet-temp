import { logoutAccountSession } from "@app/lib/auth/session-client";
import { getElectronBridge } from "@app/runtime/electron-bridge";
import { isLocalModeHostAvailable } from "@app/runtime/local-host-transport";
import { deleteBiometricToken } from "@app/runtime/native-biometric";
import { setMenuCloudSession } from "@app/runtime/menu";

/** Revoke account credentials and clear host credentials without assistant state. */
export async function logoutAccount(): Promise<void> {
  try {
    await logoutAccountSession();
  } finally {
    const bridge = getElectronBridge();
    await Promise.allSettled([
      Promise.resolve().then(() => bridge?.auth?.signOut?.()),
      deleteBiometricToken(),
      setMenuCloudSession(false),
      !bridge && isLocalModeHostAvailable()
        ? fetch("/v1/session", { method: "DELETE" })
        : Promise.resolve(),
    ]);
  }
}
