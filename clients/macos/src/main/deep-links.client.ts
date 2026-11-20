import { configureDeepLinks } from "@mycadet/electron-desktop";

import { handle, on } from "@mycadet/electron-desktop/ipc";
import { ensureVisible } from "./main-window";

configureDeepLinks({
  ensureVisible,
  handle,
  initialArgv: [],
  on,
});
