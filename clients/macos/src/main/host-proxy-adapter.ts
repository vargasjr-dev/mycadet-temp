import {
  createHostProxyClientHeaders,
  installHostProxyBridge as installSharedHostProxyBridge,
  type HostProxyRuntime,
} from "@mycadet/electron-desktop";

import {
  HostBrowserExecutor,
  hostFileExecutor,
  hostTransferExecutor,
  createHostUiSnapshotExecutor,
} from "@mycadet/electron-desktop";

import { RENDERER_BASE_PROD } from "@mycadet/electron-desktop";
import { showCompanionCoachmarks } from "./companion-window";
import { hostBashExecutor } from "./executors/host-bash-adapter";
import { createHostCuExecutor } from "./executors/host-cu-executor";
import log from "@mycadet/electron-desktop/app-logger";
import { shutdownSharedCuHelper } from "./sidecar/shared-cu-helper";

export const installHostProxyBridge = (): (() => void) => {
  const browserExecutor = new HostBrowserExecutor();
  const uiSnapshotExecutor = createHostUiSnapshotExecutor({
    resolveRendererBase: () => RENDERER_BASE_PROD,
  });
  const runtime: HostProxyRuntime = {
    ...createHostProxyClientHeaders({
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
