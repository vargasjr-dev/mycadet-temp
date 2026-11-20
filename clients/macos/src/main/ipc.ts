import { createIpcRegistrar } from "@mycadet/electron-desktop";

import { isAllowedOrigin } from "@mycadet/electron-desktop/app-origin";
import { resolveAllowedOrigin } from "./app-origin";

export const { handle, handleSync, on } = createIpcRegistrar(
  resolveAllowedOrigin,
  isAllowedOrigin,
);
