/**
 * Installs the shared host-proxy bridge so daemon host_* requests reach
 * the executors. The runtime is the shared portable body, and so is the
 * wiring: the darwin client answers computer-use in this process (the
 * companion surface it draws on is a window the helper cannot see) and
 * everywhere else the native-helper proxy answers — it fails closed where
 * no helper binary exists.
 */

import { app } from "electron";

import { createHostProxyRuntime } from "../host-proxy/runtime";
import { installHostProxyBridge } from "../host-proxy/router";

import log from "../app-logger";
import { computerUseExecutors } from "./computer-use-actions";

export const install = (interfaceId: string): void => {
  // Deferred one microtask: capability modules install synchronously in
  // path order, and the bridge seeds its connections from the lockfile,
  // which the presence module (sorted later) fills with its initial
  // synchronous read. Deferring lets the bridge observe assistants already
  // present at startup.
  queueMicrotask(() => {
    installBridge(interfaceId);
  });
};

const installBridge = (interfaceId: string): void => {
  const cu = computerUseExecutors();
  const teardown = installHostProxyBridge(
    createHostProxyRuntime({
      interfaceId,
      // The client can draw on its own companion surface, capture the
      // screen around it, and walk its element tree in order.
      supports: { windowCapture: true, sequence: true, coachmarks: true },
      hostCu: { executor: cu.host_cu, teardown: cu.teardown },
      logger: log,
    }),
  );
  app.once("before-quit", teardown);
};
