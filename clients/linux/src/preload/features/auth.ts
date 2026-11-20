import { ipcRenderer } from "electron";

import type { BridgeCapabilityRegistry } from "@mycadet/electron-desktop/capability-registry";
import {
  AUTH_CANCEL_OAUTH,
  AUTH_GET_SESSION_TOKEN,
  AUTH_SIGN_OUT,
  AUTH_START_OAUTH,
  type CadetBridge,
} from "@mycadet/ipc-contract";

export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
): void => {
  registry.contribute("auth", {
    startOAuth: (options) =>
      ipcRenderer.invoke(AUTH_START_OAUTH, options) as Promise<{
        sessionToken: string;
      }>,
    cancelOAuth: () => ipcRenderer.invoke(AUTH_CANCEL_OAUTH) as Promise<void>,
    getSessionToken: () =>
      ipcRenderer.sendSync(AUTH_GET_SESSION_TOKEN) as string | null,
    signOut: () => ipcRenderer.invoke(AUTH_SIGN_OUT) as Promise<void>,
  });
};
