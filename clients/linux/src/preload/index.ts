import { contextBridge, ipcRenderer } from "electron";

import type {
  AppVersionInfo,
  CadetBridge,
  CadetCommand,
} from "@mycadet/ipc-contract";

import { createLinuxCoreBridge } from "./core-capabilities";
import { composePreloadFeatures } from "./features";

export type { AppVersionInfo, CadetBridge, CadetCommand };

// The always-present core plus every `./features/` module;
// `bridge-parity.test.ts` holds the composed bridge to the full contract.
const bridge = composePreloadFeatures(createLinuxCoreBridge(ipcRenderer));
contextBridge.exposeInMainWorld("cadet", bridge);
