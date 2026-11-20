/**
 * Installs the shared host-proxy bridge with the Windows runtime so daemon
 * host_* requests reach the portable executors.
 */

import { app } from "electron";

import type { DesktopCapabilityRegistry } from "@mycadet/electron-desktop/capability-registry";
import {
  installHostProxyBridge,
  createHostProxyRuntime,
} from "@mycadet/electron-desktop";

import { hostBashExecutor } from "../executors/host-bash-adapter";
import { log } from "@mycadet/electron-desktop";
import { COMPUTER_USE_ACTION_EXECUTORS } from "./computer-use-actions";

export const install = (capabilities: DesktopCapabilityRegistry): void => {
  // Deferred one microtask: capability modules install synchronously in
  // path order, and the bridge seeds its connections from the lockfile,
  // which the presence module (sorted later) fills with its initial
  // synchronous read. Deferring lets the bridge observe assistants already
  // present at startup.
  queueMicrotask(() => {
    installBridge(capabilities);
  });
};

const installBridge = (capabilities: DesktopCapabilityRegistry): void => {
  const teardown = installHostProxyBridge(
    createHostProxyRuntime({
      interfaceId: "windows",
      bashExecutor: hostBashExecutor,
      logger: log,
      computerUseExecutors: capabilities.get(COMPUTER_USE_ACTION_EXECUTORS),
    }),
  );
  app.once("before-quit", teardown);
};
