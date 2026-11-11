import { configureFileOpen } from "@mycadet/electron-desktop/file-open";

import { handle, on } from "./ipc";
import { ensureVisible } from "./main-window";

configureFileOpen({ ensureMainWindowVisible: ensureVisible, handle, on });
