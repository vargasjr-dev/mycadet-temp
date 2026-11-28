import { beforeEach, describe, expect, mock, test } from "bun:test";

// The share feature's sanitizer follows the platform's basename rules; this
// suite asserts the Windows shape. The isolated runner gives each test file
// its own process, so the stamp is safe to hold for the whole file.
Object.defineProperty(process, "platform", { value: "win32" });
import { electronMock } from "../../test-setup";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { z } from "zod";

// Windows pieces only: the save-dialog share handler. Shared behavior is
// covered in packages/electron-desktop.

type SaveDialogResult = { canceled: boolean; filePath?: string };
let saveDialogResult: SaveDialogResult = { canceled: true };
const saveDialogCalls: Array<{ options: { defaultPath?: string } }> = [];

const quitListeners: Array<() => void> = [];
const userDataDir = "/nonexistent-user-data";
mock.module("electron", () =>
  electronMock({
    app: {
      getVersion: () => "0.0.0",
      getName: () => "Cadet",
      isPackaged: false,
      getAppPath: () => "/nonexistent-app-path",
      getPath: (name: string) =>
        name === "userData" ? userDataDir : "/nonexistent-path",
      once: (event: string, listener: () => void) => {
        if (event === "before-quit") {
          quitListeners.push(listener);
        }
      },
    },
    dialog: {
      showSaveDialog: (_window: unknown, options: { defaultPath?: string }) => {
        saveDialogCalls.push({ options });
        return Promise.resolve(saveDialogResult);
      },
    },
    BrowserWindow: { fromWebContents: () => ({ id: 1 }) },
  }),
);

type HandleRegistration = {
  channel: string;
  schema: z.ZodType<unknown[]>;
  fn: (args: unknown[], event: unknown) => unknown;
};
const handleRegistrations: HandleRegistration[] = [];
mock.module("../ipc", () => ({
  handle: (
    channel: string,
    schema: z.ZodType<unknown[]>,
    fn: (args: unknown[], event: unknown) => unknown,
  ) => {
    handleRegistrations.push({ channel, schema, fn });
  },
}));
mock.module("../app-logger", () => ({
  getLogFilePaths: () => [],
  default: { info: () => undefined, warn: () => undefined },
}));
mock.module("../main-window", () => ({
  ensureVisible: () => Promise.resolve(),
}));
// The shared module imports `electron.Notification`, which does not exist
// outside an Electron runtime.
mock.module("../notifications", () => ({
  __resetForTesting: () => undefined,
  __setDeliveryTimeoutForTesting: () => undefined,
  CATEGORY_ACTIONS: {},
  NOTIFICATION_CATEGORIES: [],
  createElectronNotification: () => undefined,
  isPreparedNotificationSenderCurrent: () => true,
  configureNotifications: () => undefined,
  installNotifications: () => undefined,
}));
const windowAttentionInstalls = { count: 0 };
const teardownWindowAttention = mock(() => undefined);
mock.module("../window-attention", () => ({
  installWindowAttention: () => {
    windowAttentionInstalls.count += 1;
    return teardownWindowAttention;
  },
}));

const { install: windowAttentionInstall } =
  await import("../features/window-attention");
const { install: shareInstall, sanitizeFilename } =
  await import("../features/share");

beforeEach(() => {
  handleRegistrations.length = 0;
  saveDialogCalls.length = 0;
  saveDialogResult = { canceled: true };
  quitListeners.length = 0;
  windowAttentionInstalls.count = 0;
  teardownWindowAttention.mockClear();
});

describe("window attention feature", () => {
  test("installs the window-attention publisher and tears it down on quit", () => {
    windowAttentionInstall();

    expect(windowAttentionInstalls.count).toBe(1);
    expect(teardownWindowAttention).not.toHaveBeenCalled();

    expect(quitListeners).toHaveLength(1);
    quitListeners[0]!();
    expect(teardownWindowAttention).toHaveBeenCalledTimes(1);
  });
});

describe("share feature", () => {
  const installShare = (): HandleRegistration => {
    shareInstall();
    const registration = handleRegistrations.find(
      (candidate) => candidate.channel === "cadet:share:file",
    );
    if (!registration) throw new Error("share handler was not registered");
    return registration;
  };

  test("sanitizeFilename strips directories and invalid characters", () => {
    // Forward slashes are separators on every host; the host's own
    // basename rules (path.basename) strip the rest, so only the invalid
    // characters survive for the regex.
    expect(sanitizeFilename("nested/dir/受信 rėsumė.txt")).toBe(
      "受信 rėsumė.txt",
    );
    expect(sanitizeFilename("évil<name>.txt")).toBe("évil_name_.txt");
    expect(sanitizeFilename("///")).toBe("download");
  });

  test("writes the bytes to the picked path and cancelling writes nothing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cadet-share-test-"));
    try {
      const target = path.join(dir, "out.bin");
      saveDialogResult = { canceled: false, filePath: target };
      const bytes = new Uint8Array([1, 2, 3]);
      await installShare().fn([bytes, "../report:v1.pdf"], { sender: {} });
      expect(saveDialogCalls[0]!.options.defaultPath).toBe("report_v1.pdf");
      expect(new Uint8Array(await readFile(target))).toEqual(bytes);

      saveDialogResult = { canceled: true };
      await expect(
        installShare().fn([bytes, "a.txt"], { sender: {} }),
      ).resolves.toBeUndefined();
      expect(saveDialogCalls).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
