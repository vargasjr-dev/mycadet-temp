import { app } from "electron";

import {
  configureLoginItem,
  installLoginItem,
  installLoginItemIpc,
} from "../login-item";

export const install = (): void => {
  configureLoginItem({
    identity:
      !app.isPackaged && process.argv[1]
        ? { path: process.execPath, args: [process.argv[1]] }
        : undefined,
  });
  installLoginItem();
  installLoginItemIpc();
};
