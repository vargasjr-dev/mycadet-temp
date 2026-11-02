/**
 * Installs the shared host-proxy bridge with the Linux runtime so daemon
 * host_* requests reach the portable executors.
 */

import { app } from "electron";

import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@mycadet/electron-desktop/capability-registry";
import { installHostProxyBridge } from "@mycadet/electron-desktop/host-proxy/router";
import { createHostProxyRuntime } from "@mycadet/electron-desktop/host-proxy/runtime";

import { hostBashExecutor } from "../executors/host-bash-adapter";
import log from "../logger";
import { COMPUTER_USE_ACTION_EXECUTORS } from "./computer-use-actions";

const hostProxy: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "host-proxy",
  install: (capabilities) => {
    // Deferred one microtask: capability modules install synchronously in
    // path order, and the bridge seeds its connections from the lockfile,
    // which the presence module (sorted later) fills with its initial
    // synchronous read. Deferring lets the bridge observe assistants already
    // present at startup.
    queueMicrotask(() => {
      installBridge(capabilities);
    });
  },
};

const installBridge = (capabilities: DesktopCapabilityRegistry): void => {
  const teardown = installHostProxyBridge(
    createHostProxyRuntime({
      interfaceId: "linux",
      bashExecutor: hostBashExecutor,
      logger: log,
      computerUseExecutors: capabilities.get(COMPUTER_USE_ACTION_EXECUTORS),
    }),
  );
  app.once("before-quit", teardown);
};

export default hostProxy;
