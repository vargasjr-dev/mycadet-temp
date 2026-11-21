/**
 * Computer-use action executors. `host_cu` proxies `cu.perform` through the
 * native helper, wrapping the shared client so screen capture is protected
 * for the duration of every call. Where no helper binary exists (Linux
 * today) the placeholder client fails closed and the proxy reports the
 * action unavailable.
 */

import { BrowserWindow } from "electron";

import type { CuHelperClient } from "../host-proxy/helper-proxy-executor";
import type { HostProxyExecutor } from "../host-proxy/router";
import { createCuHelperProxyExecutor } from "../host-proxy/cu-executor";

import {
  getSharedHelperClient,
  getWindowsHelperPath,
} from "../native-helper-client";
import { NativeSidecarClient } from "@mycadet/native-sidecar/supervisor";
import log from "../app-logger";

export interface ComputerUseActionExecutors {
  host_cu: HostProxyExecutor;
  teardown: () => void;
}

// Just above the daemon's 60s host-proxy request timeout so the daemon stays
// authoritative and the client timeout only catches a genuinely hung helper.
const CU_HELPER_TIMEOUT_MS = 65_000;

let sharedHelper: NativeSidecarClient | null = null;

// Lazily spawned, so users who never invoke computer use pay nothing.
export const getSharedCuHelper = (): CuHelperClient => {
  if (process.platform !== "win32") {
    // No helper binary on this platform: the placeholder client fails
    // every RPC closed.
    return getSharedHelperClient();
  }
  sharedHelper ??= new NativeSidecarClient({
    name: "windows helper (computer use)",
    resolveExecutablePath: getWindowsHelperPath,
    logger: log,
    responseTimeoutMs: CU_HELPER_TIMEOUT_MS,
    spawnEnv: {
      CADET_HOST_PID: String(process.pid),
    },
  });
  return sharedHelper;
};

type ContentProtectionWindow = Pick<
  BrowserWindow,
  "isContentProtected" | "setContentProtection"
>;

export const protectComputerUseCapture = (
  helper: CuHelperClient,
  getWindows: () => ContentProtectionWindow[],
): CuHelperClient => {
  let activeCalls = 0;
  let protectedWindows: ContentProtectionWindow[] = [];
  return {
    call: async (method, params) => {
      activeCalls += 1;
      if (activeCalls === 1) {
        const windows = getWindows().filter(
          (window) => !window.isContentProtected(),
        );
        try {
          for (const window of windows) {
            window.setContentProtection(true);
            protectedWindows.push(window);
          }
        } catch (error) {
          for (const window of protectedWindows) {
            window.setContentProtection(false);
          }
          protectedWindows = [];
          activeCalls -= 1;
          throw error;
        }
      }
      try {
        return await helper.call(method, params);
      } finally {
        activeCalls -= 1;
        if (activeCalls === 0) {
          for (const window of protectedWindows) {
            window.setContentProtection(false);
          }
          protectedWindows = [];
        }
      }
    },
  };
};

let protectedSharedHelper: CuHelperClient | null = null;

const getProtectedSharedCuHelper = (): CuHelperClient => {
  protectedSharedHelper ??= protectComputerUseCapture(getSharedCuHelper(), () =>
    BrowserWindow.getAllWindows(),
  );
  return protectedSharedHelper;
};

export const shutdownSharedCuHelper = (): void => {
  protectedSharedHelper = null;
  sharedHelper?.shutdown();
  sharedHelper = null;
};

export interface HostCuExecutorDeps {
  helper?: CuHelperClient;
}

export const createHostCuExecutor = (
  deps: HostCuExecutorDeps = {},
): HostProxyExecutor => {
  const { helper } = deps;
  return createCuHelperProxyExecutor({
    logger: log,
    resolveHelper: helper ? () => helper : getProtectedSharedCuHelper,
  });
};

/**
 * The executor set the host-proxy bridge composes — the registry-free
 * successor of the old capability provide, wired by direct import.
 */
export const computerUseExecutors = (): ComputerUseActionExecutors => ({
  host_cu: createHostCuExecutor(),
  teardown: shutdownSharedCuHelper,
});
