/**
 * Installs the shared host-proxy bridge with this process's runtime so
 * daemon host_* requests reach the portable executors.
 */

import { app } from "electron";

import { createHostProxyRuntime } from "../host-proxy/runtime";
import { installHostProxyBridge } from "../host-proxy/router";

import { hostBashExecutor } from "../host-proxy/executors/host-bash-adapter";
import log from "../app-logger";
import { computerUseExecutors } from "./computer-use-actions";

export const install = (): void => {
  // Deferred one microtask: capability modules install synchronously in
  // path order, and the bridge seeds its connections from the lockfile,
  // which the presence module (sorted later) fills with its initial
  // synchronous read. Deferring lets the bridge observe assistants already
  // present at startup.
  queueMicrotask(() => {
    installBridge();
  });
};

const installBridge = (): void => {
  const teardown = installHostProxyBridge(
    createHostProxyRuntime({
      interfaceId: process.platform === "win32" ? "windows" : "linux",
      bashExecutor: hostBashExecutor,
      logger: log,
      computerUseExecutors: computerUseExecutors(),
    }),
  );
  app.once("before-quit", teardown);
};
