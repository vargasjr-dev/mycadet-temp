/**
 * Computer-use action executor backed by the Linux native helper. `host_cu`
 * proxies `cu.perform`. Until a Linux sidecar exists, the placeholder helper
 * fails closed and capability modules report unavailable.
 */

import { BrowserWindow } from "electron";

import { createCuHelperProxyExecutor } from "@mycadet/electron-desktop";
import type {
  CuHelperClient,
  HostProxyExecutor,
} from "@mycadet/electron-desktop";

import { getLinuxHelperClient } from "../linux-helper";
import { log } from "@mycadet/electron-desktop";

export interface ComputerUseActionExecutors {
  host_cu: HostProxyExecutor;
  teardown: () => void;
}

export const getSharedCuHelper = () => getLinuxHelperClient();

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
};

export interface LinuxCuExecutorDeps {
  helper?: CuHelperClient;
}

export const createLinuxHostCuExecutor = (
  deps: LinuxCuExecutorDeps = {},
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
  host_cu: createLinuxHostCuExecutor(),
  teardown: shutdownSharedCuHelper,
});
