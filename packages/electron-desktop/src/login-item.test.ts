import { beforeEach, expect, mock, test } from "bun:test";

import { electronMock, recordedIpcHandlers } from "../test-setup";

let openAtLogin = false;
const getLoginItemSettings = mock(() => ({ openAtLogin }));
const setLoginItemSettings = mock((settings: { openAtLogin: boolean }) => {
  openAtLogin = settings.openAtLogin;
});

mock.module("electron", () =>
  electronMock({
    app: {
      getLoginItemSettings,
      setLoginItemSettings,
    },
  }),
);

const {
  __resetLoginItemForTesting,
  configureLoginItem,
  installLoginItem,
  installLoginItemIpc,
} = await import("./login-item");

// The handlers ride the shared registrar, whose `ipcMain.handle` the shared
// surface records; the fake events derive their origin from the guard.
const { protocol: allowedProtocol, host: allowedHost } =
  await import("./app-origin").then(({ resolveAllowedOrigin }) =>
    resolveAllowedOrigin(),
  );
const allowedEvent = {
  senderFrame: { origin: `${allowedProtocol}//${allowedHost}` },
};

beforeEach(() => {
  __resetLoginItemForTesting();
  recordedIpcHandlers.clear();
  openAtLogin = false;
  setLoginItemSettings.mockClear();
  getLoginItemSettings.mockClear();
});

test("identifies the app entry for an unpackaged login item", () => {
  const identity = { path: "/path/to/electron", args: ["/path/to/app"] };
  configureLoginItem({ identity });
  installLoginItemIpc();

  expect(
    recordedIpcHandlers.get("cadet:launchAtLogin:get")?.(allowedEvent),
  ).toBe(false);
  recordedIpcHandlers.get("cadet:launchAtLogin:set")?.(allowedEvent, true);

  expect(getLoginItemSettings).toHaveBeenCalledWith(identity);
  expect(setLoginItemSettings).toHaveBeenCalledWith({
    openAtLogin: true,
    ...identity,
  });
});

test("reads and changes the operating-system login item", () => {
  configureLoginItem({});
  installLoginItemIpc();

  const get = recordedIpcHandlers.get("cadet:launchAtLogin:get");
  const set = recordedIpcHandlers.get("cadet:launchAtLogin:set");
  expect(get?.(allowedEvent)).toBe(false);
  set?.(allowedEvent, true);

  expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
  expect(get?.(allowedEvent)).toBe(true);
});

test("keeps a persisted setting synchronized with the login item", () => {
  let stored: boolean | null = null;
  let notify = (): void => undefined;
  const write = mock((enabled: boolean) => {
    stored = enabled;
  });

  configureLoginItem({
    store: {
      read: () => stored,
      subscribe: (next) => {
        notify = next;
        return () => {
          notify = () => undefined;
        };
      },
      write,
    },
  });

  installLoginItem();
  installLoginItemIpc();

  expect(write).toHaveBeenCalledWith(false);
  expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false });

  recordedIpcHandlers.get("cadet:launchAtLogin:set")?.(allowedEvent, true);
  notify();

  expect(write).toHaveBeenLastCalledWith(true);
  expect(setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true });
});
