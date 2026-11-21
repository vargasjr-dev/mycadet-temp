import { app } from "electron";

import {
  configureFileOpen,
  handleFileOpenArgv,
  installFileOpen,
} from "@mycadet/electron-desktop/file-open";

import { handle, on } from "@mycadet/electron-desktop/ipc";
import { ensureVisible } from "../main-window";

export const install = (): void => {
  configureFileOpen({ ensureMainWindowVisible: ensureVisible, handle, on });
  installFileOpen();

  handleFileOpenArgv(process.argv);
  app.on("second-instance", (_event, argv, workingDirectory) => {
    handleFileOpenArgv(argv, workingDirectory);
  });
};
