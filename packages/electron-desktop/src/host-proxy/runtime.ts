import { HostBrowserExecutor } from "./executors/host-browser-executor";
import { hostFileExecutor } from "./executors/host-file-executor";
import { hostTransferExecutor } from "./executors/host-transfer-executor";
import { createHostUiSnapshotExecutor } from "./executors/host-ui-snapshot-executor";
import {
  createHostProxyClientHeaders,
  type HostProxyExecutor,
  type HostProxyLogger,
  type HostProxyRuntime,
} from "./router";

export interface HostProxyRuntimeSources {
  /** The client's interface id — rides the SSE headers. */
  interfaceId: string;
  /** The renderer base for the ui-snapshot executor (per-client app-config). */
  resolveRendererBase: () => string;
  /** The client's shell executor: bash on Linux, PowerShell on Windows. */
  bashExecutor: HostProxyExecutor;
  logger: HostProxyLogger;
  /**
   * Computer-use executors contributed by the `computer-use-actions` capability
   * module. Absent when the native helper feature is not installed, in which
   * case `host_cu` is reported as unavailable to the daemon.
   */
  computerUseExecutors?: { host_cu: HostProxyExecutor; teardown(): void };
}

/**
 * The shared host-proxy runtime body for the Linux and Windows clients: the
 * committed portable executors, the client headers from the device id and
 * machine hostname, and the computer-use wiring when the capability is
 * installed. The guardian-token mint, the lockfile source, the session-token
 * store, the lockfile listener, and the presence monitor are the router's
 * own — they were identical across all three desktops.
 */
export const createHostProxyRuntime = (
  sources: HostProxyRuntimeSources,
): HostProxyRuntime => {
  const {
    interfaceId,
    resolveRendererBase,
    bashExecutor,
    logger,
    computerUseExecutors,
  } = sources;
  const browserExecutor = new HostBrowserExecutor();
  const clientHeaders = createHostProxyClientHeaders({ interfaceId });
  return {
    ...clientHeaders,
    sseFallbackClientHeaders: () => ({
      ...clientHeaders.sseClientHeaders(),
      "X-Cadet-Interface-Id": "macos",
    }),
    executors: {
      host_bash: bashExecutor,
      host_file: hostFileExecutor,
      host_transfer: hostTransferExecutor,
      host_browser: browserExecutor,
      host_ui_snapshot: createHostUiSnapshotExecutor({ resolveRendererBase }),
      ...(computerUseExecutors
        ? { host_cu: computerUseExecutors.host_cu }
        : {}),
    },
    teardownExecutors: () => {
      browserExecutor.destroy();
      computerUseExecutors?.teardown();
    },
    logger,
  };
};
