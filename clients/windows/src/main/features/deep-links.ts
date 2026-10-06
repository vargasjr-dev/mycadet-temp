import { app } from "electron";

import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@mycadet/electron-desktop/capability-registry";
import {
  configureDeepLinks,
  DEEP_LINK_PROTOCOL_REGISTRATION,
  installDeepLinks,
  resolveRegisteredSchemes,
} from "@mycadet/electron-desktop/deep-links";
import {
  configureLoginItem,
  installLoginItem,
  installLoginItemIpc,
  STARTUP_REGISTRATION,
} from "@mycadet/electron-desktop/login-item";
import {
  onSettingChange,
  readSetting,
  writeSetting,
} from "@mycadet/electron-desktop/settings";
import { resolveEnvironmentName } from "@mycadet/local-mode";

import { handle, on } from "../ipc.client";
import { ensureVisible } from "../main-window";

const deepLinksFeature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "deep-links",
  install: (capabilities) => {
    const schemes = resolveRegisteredSchemes(
      resolveEnvironmentName(process.env),
    );
    capabilities.provide(DEEP_LINK_PROTOCOL_REGISTRATION, { schemes });
    capabilities.provide(STARTUP_REGISTRATION, {
      settingsPage: "startup-apps",
    });

    configureDeepLinks({
      ensureVisible,
      handle,
      initialArgv: process.argv,
      on,
    });
    installDeepLinks();

    configureLoginItem({
      handle,
      identity:
        !app.isPackaged && process.argv[1]
          ? { path: process.execPath, args: [process.argv[1]] }
          : undefined,
      store: {
        read: () => readSetting("launchAtLogin"),
        subscribe: (listener) => onSettingChange("launchAtLogin", listener),
        write: (enabled) => {
          writeSetting("launchAtLogin", enabled);
        },
      },
    });
    installLoginItem();
    installLoginItemIpc();
  },
};

export default deepLinksFeature;
