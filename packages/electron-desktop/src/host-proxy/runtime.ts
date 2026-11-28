import { HostBrowserExecutor } from "./executors/host-browser-executor";
import { hostBashExecutor as hostBashExecutorDefault } from "./executors/host-bash-adapter";
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
  /**
   * The client's shell executor: bash on Linux, PowerShell on Windows,
   * bash on macOS. Absent, the shared adapter answers — it picks the
   * host's shell itself.
   */
  bashExecutor?: HostProxyExecutor;
  /**
   * The client's `host_cu` executor. Absent, the native-helper proxy
   * answers — it fails closed where no helper binary exists.
   */
  hostCu?: { executor: HostProxyExecutor; teardown(): void };
  /** Extra executor teardown the shell needs on quit. */
  teardown?: () => void;
  logger: HostProxyLogger;
}

/**
 * The shared host-proxy runtime body for every desktop client: the
 * committed portable executors, the client headers from the device id and
 * machine hostname, and the shell's own executors where it contributes
 * them. The guardian-token mint, the lockfile source, the session-token
 * store, the lockfile listener, and the presence monitor are the router's
 * own — they were identical across all three desktops.
 */
export const createHostProxyRuntime = (
  sources: HostProxyRuntimeSources,
): HostProxyRuntime => {
  const { interfaceId, bashExecutor, hostCu, teardown, logger } = sources;
  const browserExecutor = new HostBrowserExecutor();
  const clientHeaders = createHostProxyClientHeaders({ interfaceId });
  return {
    ...clientHeaders,
    executors: {
      host_bash: bashExecutor ?? hostBashExecutorDefault,
      host_file: hostFileExecutor,
      host_transfer: hostTransferExecutor,
      host_browser: browserExecutor,
      host_ui_snapshot: createHostUiSnapshotExecutor(),
      ...(hostCu ? { host_cu: hostCu.executor } : {}),
    },
    teardownExecutors: () => {
      browserExecutor.destroy();
      hostCu?.teardown();
      teardown?.();
    },
    logger,
  };
};
