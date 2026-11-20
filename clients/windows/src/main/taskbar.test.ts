import { beforeEach, expect, mock, test } from "bun:test";
import { electronMock } from "@mycadet/electron-desktop/test-setup";

const appListeners = new Map<string, () => void>();
const createFromBitmap = mock((bitmap: Buffer) => ({ bitmap }));
const bundleIcon = { isEmpty: () => false };
mock.module("electron", () =>
  electronMock({
    app: {
      getVersion: () => "0.0.0",
      getName: () => "Cadet",
      isPackaged: false,
      on: (event: string, listener: () => void) =>
        appListeners.set(event, listener),
    },
    nativeImage: { createFromBitmap, createFromPath: () => bundleIcon },
  }),
);;

let avatarListener: (() => void) | null = null;
mock.module("@mycadet/electron-desktop/avatar", () => ({
  setAvatar: () => undefined,
  setCharacter: () => undefined,
  __resetForTesting: () => undefined,
  getAccentHex: () => "#000000",
  getCharacter: () => undefined,
  installAvatarIpc: () => undefined,
  getAvatarPng: () => null,
  onAvatarChange: (listener: () => void) => {
    avatarListener = listener;
    return () => undefined;
  },
}));

let badgeHandler: ((args: [number]) => void) | null = null;
mock.module("./ipc.client", () => ({
  on: (
    _channel: string,
    _schema: unknown,
    listener: (args: [number]) => void,
  ) => {
    badgeHandler = listener;
  },
}));

let status = "idle";
let statusListener: (() => void) | null = null;
const unsubscribe = mock(() => undefined);
mock.module("@mycadet/electron-desktop/status", () => ({
  __resetForTesting: () => undefined,
  installConnectivityIpc: () => undefined,
  installStatusIpc: () => undefined,
  setBackendReachable: () => undefined,
  pulseOpacityFrames: [],
  shouldPulse: () => undefined,
  setStatus: () => undefined,
  getConnectivity: () => undefined,
  setConnectivity: () => undefined,
  setDeviceOnline: () => undefined,
  onConnectivityChange: () => () => undefined,
  statusMenuTitle: () => "Status",
  PULSE_FRAME_COUNT: 12,
  PULSE_FRAME_INTERVAL_MS: 60,
  PULSE_MIN_OPACITY: 0.4,
  PULSE_MAX_OPACITY: 1,
  getStatus: () => status,
  onStatusChange: (listener: () => void) => {
    statusListener = listener;
    return unsubscribe;
  },
}));

const setOverlayIcon = mock(() => undefined);
const setProgressBar = mock(() => undefined);
const setIcon = mock(() => undefined);
const createOverlayIcon = mock((count: number) => ({ count }) as never);
let avatarIcon: { avatar: true } | null = null;
const createAvatarIcon = () => avatarIcon as never;
const win = {
  isDestroyed: () => false,
  setIcon,
  setOverlayIcon,
  setProgressBar,
};

const { createUnreadOverlayIcon, installTaskbar } = await import("./taskbar");

beforeEach(() => {
  appListeners.clear();
  badgeHandler = null;
  status = "idle";
  statusListener = null;
  setOverlayIcon.mockClear();
  setProgressBar.mockClear();
  unsubscribe.mockClear();
  createOverlayIcon.mockClear();
  createFromBitmap.mockClear();
  setIcon.mockClear();
  avatarIcon = null;
  avatarListener = null;
});

test("shows the avatar as the window icon and restores the bundled icon", () => {
  installTaskbar({ getWindow: () => win as never, createAvatarIcon });

  avatarListener?.();
  expect(setIcon).not.toHaveBeenCalled();

  avatarIcon = { avatar: true };
  avatarListener?.();
  expect(setIcon).toHaveBeenLastCalledWith(avatarIcon);

  avatarIcon = null;
  avatarListener?.();
  expect(setIcon).toHaveBeenLastCalledWith(bundleIcon);
});

test("renders the unread count into the overlay bitmap", () => {
  const three = createUnreadOverlayIcon(3) as unknown as { bitmap: Buffer };
  const four = createUnreadOverlayIcon(4) as unknown as { bitmap: Buffer };
  const oneHundred = createUnreadOverlayIcon(100) as unknown as {
    bitmap: Buffer;
  };
  const oneThousand = createUnreadOverlayIcon(1_000) as unknown as {
    bitmap: Buffer;
  };

  expect(three.bitmap.equals(four.bitmap)).toBeFalse();
  expect(oneHundred.bitmap.equals(oneThousand.bitmap)).toBeTrue();
});

test("publishes unread counts and clears the taskbar overlay", () => {
  installTaskbar({
    getWindow: () => win as never,
    createOverlayIcon,
  });

  badgeHandler?.([3.8]);
  expect(createOverlayIcon).toHaveBeenLastCalledWith(3);
  expect(setOverlayIcon).toHaveBeenLastCalledWith(
    { count: 3 },
    "3 unread conversations",
  );

  badgeHandler?.([-2]);
  expect(setOverlayIcon).toHaveBeenLastCalledWith(null, "");
});

test("maps live assistant status to taskbar progress", () => {
  installTaskbar({ getWindow: () => win as never, createOverlayIcon });

  status = "thinking";
  statusListener?.();
  expect(setProgressBar).toHaveBeenLastCalledWith(2, {
    mode: "indeterminate",
  });

  status = "disconnected";
  statusListener?.();
  expect(setProgressBar).toHaveBeenLastCalledWith(1, { mode: "paused" });
});

test("clears attention state and unsubscribes before quit", () => {
  installTaskbar({ getWindow: () => win as never, createOverlayIcon });
  badgeHandler?.([4]);

  appListeners.get("before-quit")?.();

  expect(setOverlayIcon).toHaveBeenLastCalledWith(null, "");
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
