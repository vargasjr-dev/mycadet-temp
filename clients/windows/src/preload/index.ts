import { contextBridge, ipcRenderer } from "electron";

import type {
  AppVersionInfo,
  CadetBridge,
  CadetCommand,
} from "@mycadet/ipc-contract";

import { createWindowsCoreBridge } from "./core-capabilities";
import { composePreloadFeatures } from "./features";

export type { AppVersionInfo, CadetBridge, CadetCommand };

// The always-present core plus every `./features/` module;
// `bridge-parity.test.ts` holds the composed bridge to the full contract.
const bridge = composePreloadFeatures(createWindowsCoreBridge(ipcRenderer));
contextBridge.exposeInMainWorld("cadet", bridge);

const cadetConfig = ipcRenderer.sendSync("cadet:config:get") as {
  baseUrl: string;
  deviceId: string | null;
  version: string;
} | null;
if (cadetConfig) {
  contextBridge.exposeInMainWorld("__CADET_CONFIG__", cadetConfig);
}

