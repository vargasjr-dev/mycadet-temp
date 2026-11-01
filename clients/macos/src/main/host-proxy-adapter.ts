import { hostname } from "node:os";

import {
  createHostProxyClientHeaders,
  installHostProxyBridge as installSharedHostProxyBridge,
  type HostProxyRuntime,
} from "@mycadet/electron-desktop/host-proxy/router";
import { getDeviceId } from "@mycadet/electron-desktop/device-id";
import {
  getGuardianAccessToken,
  resolveConfigDir,
  resolveEnvironmentName,
} from "@mycadet/local-mode";

import { app } from "electron";

import { HostBrowserExecutor } from "@mycadet/electron-desktop/host-proxy/executors/host-browser-executor";
import { hostFileExecutor } from "@mycadet/electron-desktop/host-proxy/executors/host-file-executor";
import { hostTransferExecutor } from "@mycadet/electron-desktop/host-proxy/executors/host-transfer-executor";
import { createHostUiSnapshotExecutor } from "@mycadet/electron-desktop/host-proxy/executors/host-ui-snapshot-executor";

import { RENDERER_BASE_PROD } from "./app-config";
import { showCompanionCoachmarks } from "./companion-window";
import { hostBashExecutor } from "./executors/host-bash-adapter";
import { createHostCuExecutor } from "./executors/host-cu-executor";
import {
  getWatchedLockfile,
  onLockfileChange,
} from "@mycadet/electron-desktop/lockfile-watcher";
import log from "./logger";
import { installPresenceMonitor } from "./presence";
import { getSessionToken } from "./session-token-store.client";
import { shutdownSharedCuHelper } from "./sidecar/shared-cu-helper";

export const installHostProxyBridge = (): (() => void) => {
  const browserExecutor = new HostBrowserExecutor();
  const uiSnapshotExecutor = createHostUiSnapshotExecutor({
    resolveRendererBase: () => RENDERER_BASE_PROD,
  });
  const runtime: HostProxyRuntime = {
    acquireGuardianToken: async (assistantId) => {
      const configDir = resolveConfigDir();
      const result = await getGuardianAccessToken(assistantId);
      if (!result.ok) {
        log.warn("[host-proxy-router] failed to obtain guardian token", {
          assistantId,
          status: result.status,
          error: result.error,
        });
      }
      return result;
    },
    getSessionToken,
    getLockfile: getWatchedLockfile,
    onLockfileChange,
    installPresenceMonitor,
    ...createHostProxyClientHeaders({
      getClientId: getDeviceId,
      getMachineName: hostname,
      interfaceId: "macos",
      supportsWindowCapture: true,
      supportsSequence: true,
      supportsCoachmarks: true,
    }),
    executors: {
      host_bash: hostBashExecutor,
      host_file: hostFileExecutor,
      host_transfer: hostTransferExecutor,
      host_browser: browserExecutor,
      // Built here rather than imported ready-made: pointing at the shared
      // surface is answered in this process, and what it draws on belongs to
      // the window layer. The wiring is the app's to do.
      host_cu: createHostCuExecutor({
        showCoachmarks: showCompanionCoachmarks,
      }),
      host_ui_snapshot: uiSnapshotExecutor,
    },
    teardownExecutors: () => {
      browserExecutor.destroy();
      shutdownSharedCuHelper();
    },
    logger: log,
  };
  return installSharedHostProxyBridge(runtime);
};
