import type { CadetBridge } from "@mycadet/ipc-contract";
import { createFileOpenPreloadBridge } from "../../file-open-preload";

export const install = (bridge: Partial<CadetBridge>): void => {
  const fileOpenBridge = createFileOpenPreloadBridge();
  bridge.fileOpen = fileOpenBridge.fileOpen;
  bridge.paths = fileOpenBridge.paths;
};
