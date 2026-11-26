import { createUpdateBridge } from "../factories";
import type { CadetBridge } from "@mycadet/ipc-contract";

export const install = (bridge: Partial<CadetBridge>): void => {
  bridge.update = createUpdateBridge();
};
