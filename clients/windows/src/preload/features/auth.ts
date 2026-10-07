import { ipcRenderer } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@mycadet/electron-desktop/capability-registry";
import {
  AUTH_CANCEL_OAUTH,
  AUTH_GET_SESSION_TOKEN,
  AUTH_SIGN_OUT,
  AUTH_START_OAUTH,
  type CadetBridge,
} from "@mycadet/ipc-contract";

const authFeature: CapabilityModule<BridgeCapabilityRegistry<CadetBridge>> = {
  id: "native-auth",
  install: (registry) => {
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
  },
};

export default authFeature;
