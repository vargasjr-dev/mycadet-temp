import { ipcRenderer } from "electron";

import {
  DIAGNOSTICS_SET_SHARE,
  FEEDBACK_DIAGNOSTICS,
  FEEDBACK_LOGS,
  type CadetBridge,
} from "@mycadet/ipc-contract";

export const install = (bridge: Partial<CadetBridge>): void => {
  bridge.diagnostics = {
    setShareDiagnostics: (enabled) => {
      ipcRenderer.send(DIAGNOSTICS_SET_SHARE, enabled);
    },
  };
  bridge.feedback = {
    diagnostics: (): Promise<Record<string, unknown>> =>
      Promise.resolve(ipcRenderer.invoke(FEEDBACK_DIAGNOSTICS)),
    logs: (): Promise<string> =>
      Promise.resolve(ipcRenderer.invoke(FEEDBACK_LOGS)),
  };
};
