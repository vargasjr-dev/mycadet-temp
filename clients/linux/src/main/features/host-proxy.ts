/**
 * Installs the shared host-proxy bridge with the Linux runtime so daemon
 * host_* requests reach the portable executors.
 */

import { app } from "electron";

import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@mycadet/electron-desktop/capability-registry";
import { getDeviceId } from "@mycadet/electron-desktop/device-id";
import { installHostProxyBridge } from "@mycadet/electron-desktop/host-proxy/router";
import {
  getWatchedLockfile,
  onLockfileChange,
} from "@mycadet/electron-desktop/lockfile-watcher";
import {
  getSessionToken,
  onSessionTokenChange,
} from "@mycadet/electron-desktop/session-token-store";
import {
  getGuardianAccessToken,
  resolveConfigDir,
  resolveEnvironmentName,
} from "@mycadet/local-mode";

import { createLinuxHostProxyRuntime } from "../host-proxy-adapter";
import log from "../logger";
import { installPresenceMonitor } from "../presence";
import { COMPUTER_USE_ACTION_EXECUTORS } from "./computer-use-actions";

const hostProxy: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "host-proxy",
  install: (capabilities) => {
    // Deferred one microtask: capability modules install synchronously in
    // path order, and the bridge seeds its connections from the lockfile
    // watcher's cache, which the presence module (sorted later) fills with
    // its initial synchronous read. Deferring lets the bridge observe
    // assistants already present at startup.
    queueMicrotask(() => {
      installBridge(capabilities);
    });
  },
};

const installBridge = (capabilities: DesktopCapabilityRegistry): void => {
  const teardown = installHostProxyBridge(
    createLinuxHostProxyRuntime({
      acquireGuardianToken: async (assistantId) => {
        const result = await getGuardianAccessToken(assistantId);
        if (!result.ok) {
          log.warn("[host-proxy] failed to obtain guardian token", {
            assistantId,
            status: result.status,
            error: result.error,
          });
        }
        return result;
      },
      getSessionToken,
      onSessionTokenChange,
      getLockfile: getWatchedLockfile,
      onLockfileChange,
      installPresenceMonitor,
      getClientId: getDeviceId,
      computerUseExecutors: capabilities.get(COMPUTER_USE_ACTION_EXECUTORS),
      logger: log,
    }),
  );
  app.once("before-quit", teardown);
};

export default hostProxy;
