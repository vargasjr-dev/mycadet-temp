import { createIpcRegistrar } from "@mycadet/electron-desktop/ipc";

import { isAllowedOrigin } from "@mycadet/electron-desktop/app-origin";
import { resolveAllowedOrigin } from "./app-origin";

export const { handle, handleSync, on } = createIpcRegistrar(
  resolveAllowedOrigin,
  isAllowedOrigin,
);
