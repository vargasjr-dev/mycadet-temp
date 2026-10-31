import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@mycadet/electron-desktop/capability-registry";
import {
  configureLocalMode,
  installLocalMode,
  LOCAL_MODE_SESSION,
} from "@mycadet/electron-desktop/local-mode";
import { refreshLockfileNow } from "@mycadet/electron-desktop/lockfile-watcher";

import { handle } from "../ipc.client";
import { installLinuxLocalModeProviders } from "../local-mode-providers";

const localModeFeature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "local-mode",
  install: (capabilities) => {
    installLinuxLocalModeProviders(capabilities);
    const session = capabilities.require(LOCAL_MODE_SESSION);

    configureLocalMode({
      handle,
      refreshLockfile: refreshLockfileNow,
      session,
    });
    installLocalMode();
  },
};

export default localModeFeature;
