import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@mycadet/electron-desktop/capability-registry";
import { installAutoUpdate } from "@mycadet/electron-desktop/auto-update";

import { handle } from "../ipc.client";

const autoUpdateFeature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "auto-update",
  install: () => {
    installAutoUpdate({ ipc: { handle }, platform: "win-electron" });
  },
};

export default autoUpdateFeature;
