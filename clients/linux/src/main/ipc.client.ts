import { createIpcRegistrar } from "@mycadet/electron-desktop";

import {
  isAllowedOrigin,
  resolveAllowedOrigin,
} from "@mycadet/electron-desktop/app-origin";

export const { handle, handleSync, on } = createIpcRegistrar(
  resolveAllowedOrigin,
  isAllowedOrigin,
);
