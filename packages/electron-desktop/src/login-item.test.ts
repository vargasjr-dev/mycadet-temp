import { beforeEach, expect, mock, test } from "bun:test";

import { electronMock, recordedIpcHandlers } from "../test-setup";

let openAtLogin = false;
let getLoginItemSettingsCalls: unknown[] = [];
let setLoginItemSettingsCalls: unknown[] = [];
const getLoginItemSettings = (...args: unknown[]): { openAtLogin: boolean } => {
  getLoginItemSettingsCalls.push(args);
  return { openAtLogin };
};
const setLoginItemSettings = (settings: { openAtLogin: boolean }): void => {
  setLoginItemSettingsCalls.push(settings);
  openAtLogin = settings.openAtLogin;
};

mock.module("electron", () =>
  electronMock({
    app: {
      getLoginItemSettings,
      setLoginItemSettings,
    },
  }),
);

// The module defaults to the settings-backed store; these tests stand up
// their own stores or drive the OS fallback directly, so the settings
// module here is a working stand-in: writes persist in `setting` and fire
// the change listeners, exactly the chain the real module runs.
let setting: boolean | null = null;
let notify: () => void = () => undefined;
mock.module("./settings", () => ({
  readSetting: () => setting,
  writeSetting: (_key: string, enabled: boolean) => {
    setting = enabled;
    notify();
  },
  onSettingChange: (_key: string, listener: () => void) => {
    notify = listener;
    return () => {
      notify = () => undefined;
    };
  },
}));

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
  setting = null;
  notify = () => undefined;
  getLoginItemSettingsCalls = [];
  setLoginItemSettingsCalls = [];
});

test("identifies the app entry for an unpackaged login item", () => {
  const identity = { path: "/path/to/electron", args: ["/path/to/app"] };
  configureLoginItem({ identity });
  installLoginItem();
  installLoginItemIpc();

  expect(
    recordedIpcHandlers.get("cadet:launchAtLogin:get")?.(allowedEvent),
  ).toBe(false);

  // The seed read happens once at install. Nothing is registered natively
  // until the toggle: the OS already agrees with the stored value, so the
  // sync skips the write (macOS refuses login-item registrations in
  // contexts without the user's LaunchServices consent — QA runners,
  // unsigned builds — and the refusal is an ERROR-level Electron log).
  expect(getLoginItemSettingsCalls[0]).toEqual([identity]);
  expect(setLoginItemSettingsCalls).toEqual([]);

  recordedIpcHandlers.get("cadet:launchAtLogin:set")?.(allowedEvent, true);
  expect(setLoginItemSettingsCalls).toContainEqual({
    openAtLogin: true,
    ...identity,
  });
});

test("reads and changes the operating-system login item", () => {
  configureLoginItem({});
  installLoginItem();
  installLoginItemIpc();

  const get = recordedIpcHandlers.get("cadet:launchAtLogin:get");
  const set = recordedIpcHandlers.get("cadet:launchAtLogin:set");
  expect(get?.(allowedEvent)).toBe(false);
  set?.(allowedEvent, true);

  expect(setLoginItemSettingsCalls).toContainEqual({ openAtLogin: true });
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
  // The OS already agrees with the stored value, so install performs no
  // native registration (macOS refuses login-item writes in contexts
  // without the user's LaunchServices consent — QA runners, unsigned
  // builds — and the refusal is an ERROR-level Electron log line).
  expect(setLoginItemSettingsCalls).toEqual([]);

  recordedIpcHandlers.get("cadet:launchAtLogin:set")?.(allowedEvent, true);
  notify();

  expect(write).toHaveBeenLastCalledWith(true);
  expect(setLoginItemSettingsCalls).toEqual([{ openAtLogin: true }]);
});
