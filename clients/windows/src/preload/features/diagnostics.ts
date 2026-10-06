import { ipcRenderer } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@mycadet/electron-desktop/capability-registry";
import {
  DIAGNOSTICS_SET_SHARE,
  FEEDBACK_DIAGNOSTICS,
  FEEDBACK_LOGS,
  type VellumBridge,
} from "@mycadet/ipc-contract";

const diagnosticsFeature: CapabilityModule<
  BridgeCapabilityRegistry<VellumBridge>
> = {
  id: "diagnostics",
  install: (registry) => {
    // `featureFlags` is contributed by the presence feature module.
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
  },
};

export default diagnosticsFeature;
