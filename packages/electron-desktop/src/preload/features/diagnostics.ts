import type { IpcRenderer } from "electron";

import type { BridgeCapabilityRegistry } from "../../capability-registry";
import {
  DIAGNOSTICS_SET_SHARE,
  FEEDBACK_DIAGNOSTICS,
  FEEDBACK_LOGS,
  type CadetBridge,
} from "@mycadet/ipc-contract";

export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
  ipc: IpcRenderer,
): void => {
  registry.contribute("diagnostics", {
    setShareDiagnostics: (enabled) => {
      ipc.send(DIAGNOSTICS_SET_SHARE, enabled);
    },
  });
  registry.contribute("feedback", {
    diagnostics: (): Promise<Record<string, unknown>> =>
      Promise.resolve(ipc.invoke(FEEDBACK_DIAGNOSTICS)),
    logs: (): Promise<string> => Promise.resolve(ipc.invoke(FEEDBACK_LOGS)),
  });
};
