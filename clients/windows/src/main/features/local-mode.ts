import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@mycadet/electron-desktop/capability-registry";
import { installLocalMode } from "@mycadet/electron-desktop/local-mode";
import { refreshLockfileNow } from "@mycadet/electron-desktop/lockfile-watcher";

import { handle } from "../ipc.client";

const localModeFeature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "local-mode",
  install: () => {
    installLocalMode({
      handle,
      refreshLockfile: refreshLockfileNow,
    });
  },
};

export default localModeFeature;
