/**
 * Installs the shared host-proxy bridge so daemon host_* requests reach
 * the executors. The runtime is the shared portable body fed by the
 * shell's own values (its interface id, its bash executor, its
 * computer-use wiring) — the shell names itself on `startApp`.
 */

import { app } from "electron";

import { createHostProxyRuntime } from "../host-proxy/runtime";
import { installHostProxyBridge } from "../host-proxy/router";
import type { HostProxyExecutor } from "../host-proxy/router";

import log from "../app-logger";
import { computerUseExecutors } from "./computer-use-actions";

export interface ShellHostProxyInputs {
  /** The client's interface id — rides the SSE headers. */
  interfaceId: string;
  /** Capability flags the shell's build ships. */
  supports?: {
    windowCapture?: boolean;
    sequence?: boolean;
    coachmarks?: boolean;
  };
  /** The shell's shell executor. Absent, the shared adapter answers. */
  bashExecutor?: HostProxyExecutor;
  /** The shell's computer-use executor. Absent, the native-helper proxy answers. */
  hostCu?: { executor: HostProxyExecutor; teardown(): void };
  /** Extra teardown the shell needs on quit. */
  teardown?: () => void;
}

export const install = (inputs: ShellHostProxyInputs): void => {
  // Deferred one microtask: capability modules install synchronously in
  // path order, and the bridge seeds its connections from the lockfile,
  // which the presence module (sorted later) fills with its initial
  // synchronous read. Deferring lets the bridge observe assistants already
  // present at startup.
  queueMicrotask(() => {
    installBridge(inputs);
  });
};

const installBridge = (inputs: ShellHostProxyInputs): void => {
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
      interfaceId: inputs.interfaceId,
      ...(inputs.supports ? { supports: inputs.supports } : {}),
      bashExecutor: inputs.bashExecutor,
      hostCu: shellCu,
      ...(inputs.teardown ? { teardown: inputs.teardown } : {}),
      logger: log,
    }),
  );
  app.once("before-quit", teardown);
};
