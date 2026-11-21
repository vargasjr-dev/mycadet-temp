import { app } from "electron";

import {
  configureFileOpen,
  handleFileOpenArgv,
  installFileOpen,
} from "../file-open";

import { handle, on } from "../ipc";
import { ensureVisible } from "../main-window";

export const install = (): void => {
  configureFileOpen({ ensureMainWindowVisible: ensureVisible, handle, on });
  installFileOpen();

  handleFileOpenArgv(process.argv);
  app.on("second-instance", (_event, argv, workingDirectory) => {
    handleFileOpenArgv(argv, workingDirectory);
  });
};
