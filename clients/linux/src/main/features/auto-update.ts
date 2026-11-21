import { installAutoUpdate } from "@mycadet/electron-desktop/auto-update";

import { handle } from "@mycadet/electron-desktop/ipc";

export const install = (): void => {
  installAutoUpdate({ ipc: { handle }, platform: "linux-electron" });
};
