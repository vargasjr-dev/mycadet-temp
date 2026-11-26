import type { IpcRenderer } from "electron";

import type { BridgeCapabilityRegistry } from "../../capability-registry";
import {
  AUTH_CANCEL_OAUTH,
  AUTH_GET_SESSION_TOKEN,
  AUTH_SIGN_OUT,
  AUTH_START_OAUTH,
  type CadetBridge,
} from "@mycadet/ipc-contract";

export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
  ipc: IpcRenderer,
): void => {
  registry.contribute("auth", {
    startOAuth: (options): Promise<{ sessionToken: string }> =>
      Promise.resolve(ipc.invoke(AUTH_START_OAUTH, options)),
    cancelOAuth: (): Promise<void> =>
      Promise.resolve(ipc.invoke(AUTH_CANCEL_OAUTH)),
    getSessionToken: (): string | null => ipc.sendSync(AUTH_GET_SESSION_TOKEN),
    signOut: (): Promise<void> => Promise.resolve(ipc.invoke(AUTH_SIGN_OUT)),
  });
};
