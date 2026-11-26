import { ipcRenderer } from "electron";

import {
  DIAGNOSTICS_SET_SHARE,
  FEEDBACK_DIAGNOSTICS,
  FEEDBACK_LOGS,
  type CadetBridge,
} from "@mycadet/ipc-contract";

export const diagnosticsBridge: CadetBridge["diagnostics"] = {
  setShareDiagnostics: (enabled) => {
    ipcRenderer.send(DIAGNOSTICS_SET_SHARE, enabled);
  },
};

export const feedbackBridge: CadetBridge["feedback"] = {
  diagnostics: (): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke(FEEDBACK_DIAGNOSTICS),
  logs: (): Promise<string> => ipcRenderer.invoke(FEEDBACK_LOGS),
};
