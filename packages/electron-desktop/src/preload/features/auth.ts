import { ipcRenderer } from "electron";

import {
  AUTH_CANCEL_OAUTH,
  AUTH_GET_SESSION_TOKEN,
  AUTH_SIGN_OUT,
  AUTH_START_OAUTH,
  type CadetBridge,
} from "@mycadet/ipc-contract";

export const createAuthBridge = (): CadetBridge["auth"] => ({
  startOAuth: (options): Promise<{ sessionToken: string }> =>
    Promise.resolve(ipcRenderer.invoke(AUTH_START_OAUTH, options)),
  cancelOAuth: (): Promise<void> =>
    Promise.resolve(ipcRenderer.invoke(AUTH_CANCEL_OAUTH)),
  getSessionToken: (): string | null =>
    ipcRenderer.sendSync(AUTH_GET_SESSION_TOKEN),
  signOut: (): Promise<void> =>
    Promise.resolve(ipcRenderer.invoke(AUTH_SIGN_OUT)),
});
