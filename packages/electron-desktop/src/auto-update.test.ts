import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { DesktopAutoUpdater } from "./auto-update-contract";

mock.module("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}));

/**
 * Regression cover for the auto-updater's leaked download promise.
 *
 * With `autoDownload` enabled, `checkForUpdates()` resolves with the in-flight
 * download on `result.downloadPromise` instead of folding it into the returned
 * promise, and electron-updater re-throws every download failure on it (see
 * `AppUpdater.downloadUpdate`). A `.catch()` on `checkForUpdates()` alone
 * therefore never sees a failed download, and the rejection escapes into the
 * main process as an unhandled rejection.
 */

let downloadResult: { downloadPromise: Promise<unknown> | null } = {
  downloadPromise: null,
};

const fakeUpdater: DesktopAutoUpdater = {
  checkForUpdates: () => Promise.resolve(downloadResult),
  logger: null,
  autoDownload: false,
  autoInstallOnAppQuit: false,
  channel: "",
  allowDowngrade: false,
  setFeedURL: () => undefined,
  on: () => undefined,
  quitAndInstall: () => undefined,
};

const { checkForUpdates, configureAutoUpdate, resolveUpdateFeedUrl } =
  await import("./auto-update");

configureAutoUpdate({
  updater: fakeUpdater,
  ipc: { handle: () => undefined },
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
  feedUrl: "https://updates.example.com/win-electron/x64/",
});

/** Collect unhandled rejections raised while `run` settles. */
const unhandledDuring = async (run: () => void): Promise<unknown[]> => {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    run();
    // Two macrotask hops: one for `checkForUpdates()` to resolve and the
    // handler to attach, one for the runtime to report anything still
    // unhandled after that.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return seen;
};

describe("checkForUpdates", () => {
  beforeEach(() => {
    downloadResult = { downloadPromise: null };
  });

  afterEach(() => {
    downloadResult = { downloadPromise: null };
  });

  test("swallows a rejected downloadPromise instead of leaking it", async () => {
    const readOnlyVolume = new Error(
      "Cannot update while running on a read-only volume.",
    );
    downloadResult = { downloadPromise: Promise.reject(readOnlyVolume) };

    const unhandled = await unhandledDuring(() => {
      checkForUpdates();
    });

    expect(unhandled).toEqual([]);
  });

  test("tolerates a check that reports no download in flight", async () => {
    downloadResult = { downloadPromise: null };

    const unhandled = await unhandledDuring(() => {
      checkForUpdates();
    });

    expect(unhandled).toEqual([]);
  });
});

describe("resolveUpdateFeedUrl", () => {
  const withEnvironment = (environment: string, run: () => void): void => {
    const previous = process.env.CADET_ENVIRONMENT;
    process.env.CADET_ENVIRONMENT = environment;
    try {
      run();
    } finally {
      if (previous === undefined) {
        delete process.env.CADET_ENVIRONMENT;
      } else {
        process.env.CADET_ENVIRONMENT = previous;
      }
    }
  };

  test("resolves the release channel itself and keeps platforms and architectures isolated", () => {
    withEnvironment("production", () => {
      expect(resolveUpdateFeedUrl("linux-electron", "x64")).toBe(
        "https://storage.googleapis.com/mycadet-prod-releases/linux-electron/x64/",
      );
      expect(resolveUpdateFeedUrl("mac-electron", "arm64")).toBe(
        "https://storage.googleapis.com/mycadet-prod-releases/mac-electron/arm64/",
      );
    });
    withEnvironment("staging", () => {
      expect(resolveUpdateFeedUrl("win-electron", "arm64")).toBe(
        "https://storage.googleapis.com/mycadet-staging-releases/win-electron/arm64/",
      );
      expect(resolveUpdateFeedUrl("linux-electron", "x64")).toBe(
        "https://storage.googleapis.com/mycadet-staging-releases/linux-electron/x64/",
      );
    });
  });
});
