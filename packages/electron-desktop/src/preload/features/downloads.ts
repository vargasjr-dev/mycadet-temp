import type { CadetBridge } from "@mycadet/ipc-contract";
import { createDownloadsBridge } from "../factories";

// Renderer bridge for download outcome reports and the file-manager reveal,
// the same shared factory the macOS preload uses.
export const install = (bridge: Partial<CadetBridge>): void => {
  bridge.downloads = createDownloadsBridge();
};
