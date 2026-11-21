import "./env-seed";

import { app } from "electron";

import {
  createHelperToastFactory,
  ensureVisible,
  log,
  provisionCliForWrapper,
  resolveHelperToastBinaryPath,
  startApp,
  writeCliLocator,
} from "@mycadet/electron-desktop";
import { installClassicShellFeatures } from "@mycadet/electron-desktop/classic-shell";

// This shell's toast-helper identity: the supervised sidecar's executable
// name, its dev-override env var, and the sidecar client name it registers
// under. Absent a helper binary, startApp's default electron.Notification
// path delivers click-only toasts.
const helperPath = resolveHelperToastBinaryPath({
  executable: "cadet-linux-helper",
  overrideEnvVar: "CADET_LINUX_HELPER_PATH",
});

startApp(
  log,
  () => {
    // Every main-process feature, in the glob-sorted order the old
    // auto-discovery hid — one ordered list in the package now, since both
    // classic-desktop shells ran it identically. The universal installs
    // (protocol stack, identity slice, launch capture, notification
    // runtime, web-contents security) ran earlier, in startApp.
    installClassicShellFeatures();
  },
  {
    ensureVisible,
    ...(helperPath
      ? {
          notifications: {
            create: createHelperToastFactory({
              helperPath,
              name: "linux-helper",
            }),
          },
        }
      : {}),
    provisionCli: () => {
      if (!app.isPackaged) {
        return;
      }
      writeCliLocator();
      void provisionCliForWrapper().catch((err: unknown) => {
        log.error("[app] startup CLI provisioning failed:", err);
      });
    },
  },
);

app.on("second-instance", () => {
  ensureVisible();
});
