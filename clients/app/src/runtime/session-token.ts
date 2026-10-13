import { getElectronBridge } from "@app/runtime/electron-bridge";

/** Read the account token owned by the native host, without web's token cache. */
export function getElectronSessionToken(): string | null {
  return getElectronBridge()?.auth?.getSessionToken?.() ?? null;
}
