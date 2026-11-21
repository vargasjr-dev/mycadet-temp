/**
 * Installs the shared host-proxy bridge so daemon host_* requests reach
 * the executors. The runtime is the shared portable body; the shell
 * contributes only what its own build ships — capability flags and its
 * computer-use executor.
 */

import { app } from "electron";

import { createHostProxyRuntime } from "../host-proxy/runtime";
import { installHostProxyBridge } from "../host-proxy/router";
import type { HostProxyExecutor } from "../host-proxy/router";

import log from "../app-logger";
import { computerUseExecutors } from "./computer-use-actions";

export interface ShellHostProxyInputs {
  /** Capability flags the shell's build ships. */
  supports?: {
    windowCapture?: boolean;
    sequence?: boolean;
    coachmarks?: boolean;
  };
  /** The shell's computer-use executor. Absent, the native-helper proxy answers. */
  hostCu?: { executor: HostProxyExecutor; teardown(): void };
  /** Extra teardown the shell needs on quit. */
  teardown?: () => void;
}

export const install = (
  interfaceId: string,
  inputs: ShellHostProxyInputs = {},
): void => {
  // Deferred one microtask: capability modules install synchronously in
  // path order, and the bridge seeds its connections from the lockfile,
  // which the presence module (sorted later) fills with its initial
  // synchronous read. Deferring lets the bridge observe assistants already
  // present at startup.
  queueMicrotask(() => {
    installBridge(interfaceId, inputs);
  });
};

const installBridge = (
  interfaceId: string,
  inputs: ShellHostProxyInputs,
): void => {
  // The shell's computer-use executor when it contributes one; otherwise
  // the native-helper proxy answers — it fails closed where no helper
  // binary exists.
  const shellCu = inputs.hostCu
    ? { executor: inputs.hostCu.executor, teardown: inputs.hostCu.teardown }
    : (() => {
        const cu = computerUseExecutors();
        return { executor: cu.host_cu, teardown: cu.teardown };
      })();
  const teardown = installHostProxyBridge(
    createHostProxyRuntime({
      interfaceId,
      ...(inputs.supports ? { supports: inputs.supports } : {}),
      hostCu: shellCu,
      ...(inputs.teardown ? { teardown: inputs.teardown } : {}),
      logger: log,
    }),
  );
  app.once("before-quit", teardown);
};
