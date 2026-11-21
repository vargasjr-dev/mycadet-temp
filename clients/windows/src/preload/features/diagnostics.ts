import { ipcRenderer } from "electron";

import type { BridgeCapabilityRegistry } from "@mycadet/electron-desktop/capability-registry";
import {
  DIAGNOSTICS_SET_SHARE,
  FEEDBACK_DIAGNOSTICS,
  FEEDBACK_LOGS,
  type CadetBridge,
} from "@mycadet/ipc-contract";

export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
): void => {
  registry.contribute("diagnostics", {
    setShareDiagnostics: (enabled) => {
      ipcRenderer.send(DIAGNOSTICS_SET_SHARE, enabled);
    },
  });
  registry.contribute("feedback", {
    diagnostics: () =>
      ipcRenderer.invoke(FEEDBACK_DIAGNOSTICS) as Promise<
        Record<string, unknown>
      >,
    logs: () => ipcRenderer.invoke(FEEDBACK_LOGS) as Promise<string>,
  });
};
