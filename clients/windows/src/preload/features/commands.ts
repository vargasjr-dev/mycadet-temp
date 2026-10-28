import { ipcRenderer } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@mycadet/electron-desktop/capability-registry";
import { createHotkeysBridge } from "@mycadet/electron-desktop/preload";
import {
  MENU_POPUP,
  MENU_TITLES,
  type CadetBridge,
} from "@mycadet/ipc-contract";

const commandsFeature: CapabilityModule<
  BridgeCapabilityRegistry<CadetBridge>
> = {
  id: "commands",
  install: (registry) => {
    registry.contribute("hotkeys", createHotkeysBridge(ipcRenderer));
    registry.contribute("menu", {
      titles: () =>
        ipcRenderer.invoke(MENU_TITLES) as Promise<
          Array<{ id: string; label: string }>
        >,
      popup: (id, x, y) =>
        ipcRenderer.invoke(MENU_POPUP, id, x, y) as Promise<void>,
    });
  },
};

export default commandsFeature;
