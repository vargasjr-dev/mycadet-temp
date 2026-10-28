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

const flagOverrides: Record<string, boolean | string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith("CADET_FLAG_") || value === undefined) {
    continue;
  }
  const flagKey = key
    .slice("CADET_FLAG_".length)
    .toLowerCase()
    .replace(/_/g, "-");
  const lower = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(lower)) {
    flagOverrides[flagKey] = true;
  } else if (["false", "0", "no", "off"].includes(lower)) {
    flagOverrides[flagKey] = false;
  } else {
    flagOverrides[flagKey] = value.trim();
  }
}
if (Object.keys(flagOverrides).length > 0) {
  contextBridge.exposeInMainWorld("__CADET_FLAG_OVERRIDES__", flagOverrides);
}
