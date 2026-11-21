import { configureFileOpen } from "@mycadet/electron-desktop/file-open";

import { handle, on } from "@mycadet/electron-desktop/ipc";
import { ensureVisible } from "./main-window";

configureFileOpen({ ensureMainWindowVisible: ensureVisible, handle, on });
