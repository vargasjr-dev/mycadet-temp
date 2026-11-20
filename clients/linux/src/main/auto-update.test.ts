import { describe, expect, mock, test } from "bun:test";

import {
  UPDATE_CHECK,
  UPDATE_GET_STATE,
  UPDATE_INSTALL,
} from "@mycadet/ipc-contract";

const registeredChannels: string[] = [];
const feedUrls: string[] = [];

mock.module("electron-updater", () => ({
  autoUpdater: {
    checkForUpdates: () => Promise.resolve(null),
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    channel: "",
    allowDowngrade: false,
    setFeedURL: (options: { url: string }) => {
      feedUrls.push(options.url);
    },
    on: () => undefined,
    quitAndInstall: () => undefined,
  },
}));

mock.module("@mycadet/electron-desktop/app-logger", () => ({
  default: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
  getLogFilePaths: () => [],
}));

mock.module("./ipc.client", () => ({
  handle: (channel: string) => {
    registeredChannels.push(channel);
  },
  handleSync: () => undefined,
  on: () => undefined,
}));

const { installAutoUpdate } = await import("./auto-update");

describe("installAutoUpdate", () => {
  test("registers update IPC but leaves the updater idle when unpackaged", () => {
    installAutoUpdate();

    expect(registeredChannels).toEqual([
      UPDATE_GET_STATE,
      UPDATE_CHECK,
      UPDATE_INSTALL,
    ]);
    expect(feedUrls).toEqual([]);
  });
});
