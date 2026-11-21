import { mock } from "bun:test";

/**
 * Every `ipcMain.handle` registration the package's modules make against the
 * shared surface, keyed by channel. Tests that removed the handle-injection
 * seams (the registrar is always the shared one) capture handlers here
 * instead: `recordedIpcHandlers.get(channel)` returns the origin-validating
 * wrapper — invoke it with `{ senderFrame: { origin } }` built from
 * `resolveAllowedOrigin()`.
 */
export const recordedIpcHandlers = new Map<
  string,
  (...args: unknown[]) => unknown
>();
const handleRecord = (
  channel: string,
  handler: (...args: unknown[]) => unknown,
): void => {
  recordedIpcHandlers.set(channel, handler);
};

/** Every `ipcMain.on` listener, per channel — the sync channels and the
 * fire-and-forget ones. Invoke a listener with a stub event that carries
 * `senderFrame`/`sender` (and reads back `event.returnValue` for sync). */
export const recordedIpcOnListeners = new Map<
  string,
  Array<(...args: unknown[]) => unknown>
>();
const onRecord = (
  channel: string,
  listener: (...args: unknown[]) => unknown,
): void => {
  const list = recordedIpcOnListeners.get(channel) ?? [];
  list.push(listener);
  recordedIpcOnListeners.set(channel, list);
};

const pristineElectronSurface: Record<string, unknown> = {
  app: {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    on: () => undefined,
    once: () => undefined,
    whenReady: () => Promise.resolve(),
    setName: () => undefined,
    setPath: () => undefined,
    setAppUserModelId: () => undefined,
    setActivationPolicy: () => undefined,
    getName: () => "Cadet",
    getVersion: () => "0.0.0",
    getPath: () => "/tmp",
    getAppPath: () => "/tmp",
    hide: () => undefined,
    isReady: () => false,
    isDefaultProtocolClient: () => false,
    setAsDefaultProtocolClient: () => undefined,
    removeAsDefaultProtocolClient: () => undefined,
    relaunch: () => undefined,
    exit: () => undefined,
    quit: () => undefined,
    focus: () => undefined,
    dock: undefined,
    login: () => undefined,
  },
  BrowserWindow: class {
    static getFocusedWindow() {
      return null;
    }
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
    webContents = {
      on: () => undefined,
      send: () => undefined,
      setWindowOpenHandler: () => undefined,
      getZoomFactor: () => 1,
      navigationHistory: undefined,
      session: undefined,
      isDestroyed: () => false,
      getURL: () => "",
      openDevTools: () => undefined,
      close: () => undefined,
      reload: () => undefined,
      goBack: () => undefined,
      goForward: () => undefined,
      canGoBack: () => false,
      canGoForward: () => false,
      executeJavaScript: () => Promise.resolve(undefined),
      focus: () => undefined,
    };
    on() {
      return this;
    }
    once() {
      return this;
    }
    loadURL() {
      return Promise.resolve();
    }
    isDestroyed() {
      return false;
    }
    isMinimized() {
      return false;
    }
    isMaximized() {
      return false;
    }
    isFullScreen() {
      return false;
    }
    getNormalBounds() {
      return { x: 0, y: 0, width: 1280, height: 800 };
    }
    getBounds() {
      return { x: 0, y: 0, width: 1280, height: 800 };
    }
    restore() {}
    show() {}
    hide() {}
    focus() {}
    close() {}
    destroy() {}
    setTitle() {}
    getTitle() {
      return "";
    }
    setMenuBarVisibility() {}
    setAutoHideMenuBar() {}
  },
  Menu: {
    buildFromTemplate: () => ({ popup: () => undefined }),
    setApplicationMenu: () => undefined,
    getApplicationMenu: () => null,
  },
  Tray: class {
    setIgnoreDoubleClickEvents() {}
    setToolTip() {}
    setImage() {}
    on() {
      return this;
    }
    popUpContextMenu() {}
    destroy() {}
  },
  Notification: class {
    static isSupported() {
      return false;
    }
    on() {
      return this;
    }
    show() {}
  },
  ipcMain: {
    handle: handleRecord,
    handleOnce: () => undefined,
    on: onRecord,
    removeHandler: (channel: string) => {
      recordedIpcHandlers.delete(channel);
    },
  },
  nativeImage: {
    createEmpty: () => ({
      isEmpty: () => true,
      toBitmap: () => Buffer.alloc(0),
    }),
    createFromBitmap: () => ({ setTemplateImage: () => undefined }),
    // Real createFromPath never returns null and the tray reads isEmpty()
    // off the result, so the default image answers it (empty) alongside the
    // template flag — the tray tests need no per-file delta for it.
    createFromPath: () => ({
      isEmpty: () => true,
      setTemplateImage: () => undefined,
    }),
    createFromBuffer: () => ({ setTemplateImage: () => undefined }),
  },
  protocol: {
    handle: () => undefined,
    registerSchemesAsPrivileged: () => undefined,
    registerFileProtocol: () => undefined,
    interceptFileProtocol: () => undefined,
  },
  session: {
    defaultSession: {
      webRequest: {
        onHeadersReceived: () => undefined,
        onBeforeRequest: () => undefined,
        onBeforeSendHeaders: () => undefined,
      },
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
      setWindowOpenHandler: () => undefined,
      getPreloads: () => [],
      setPreloads: () => undefined,
    },
    fromPartition: () => ({
      webRequest: { onHeadersReceived: () => undefined },
      setPermissionRequestHandler: () => undefined,
    }),
  },
  net: {
    // Import-time stub only — returns an empty Response so module-eval
    // calls succeed. Tests that exercise response bodies should re-mock
    // `net.fetch` locally with their own fixture.
    fetch: () => Promise.resolve(new Response("")),
  },
  safeStorage: {
    // Use no-op shims by default instead of touching keychain.
    // Re-mock `safeStorage` locally if needed for tests.
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (blob: Buffer) => blob.toString(),
  },
  screen: {
    getDisplayMatching: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
    getAllDisplays: () => [],
    on: () => undefined,
  },
  shell: {
    openExternal: () => Promise.resolve(),
    openPath: () => Promise.resolve(""),
    showItemInFolder: () => undefined,
    beep: () => undefined,
  },
  clipboard: {
    availableFormats: () => [],
    clear: () => undefined,
    readBookmark: () => ({ title: "", url: "" }),
    readBuffer: () => Buffer.alloc(0),
    readHTML: () => "",
    readImage: () => ({ isEmpty: () => true }),
    readRTF: () => "",
    readText: () => "",
    write: () => undefined,
    writeBuffer: () => undefined,
    writeText: () => undefined,
  },
  globalShortcut: {
    register: () => false,
    unregister: () => undefined,
    unregisterAll: () => undefined,
    isRegistered: () => false,
  },
  powerMonitor: {
    on: () => undefined,
  },
  systemPreferences: {
    getUserDefault: () => undefined,
    on: () => undefined,
  },
  nativeTheme: {
    shouldUseDarkColors: false,
    shouldUseHighContrastColors: false,
    themeSource: "system",
    on: () => undefined,
  },
  dialog: {
    showErrorBox: () => undefined,
    showMessageBox: () =>
      Promise.resolve({ response: 0, checkboxChecked: false }),
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    showSaveDialog: () => Promise.resolve({ canceled: true, filePath: "" }),
  },
};

const electronSurface: Record<string, unknown> = { ...pristineElectronSurface };
// `import electron from "electron"` (electron-store does) resolves the
// default key, and bun's interop refuses a default that IS the namespace —
// so the default is a second copy the patch keeps in sync.
const electronDefaultSurface: Record<string, unknown> = {
  ...pristineElectronSurface,
};

/**
 * The mock's `app` member merged over the base surface — a test's
 * `electronMock({ app: { ... } })` replaces the whole `app` object (the
 * top-level rule), so tests that need most of the base app plus a tweak
 * build the override with this.
 */
export const electronAppOverride = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ...(pristineElectronSurface.app as Record<string, unknown>),
  ...overrides,
});

/**
 * The setup's electron surface with a test's overrides merged in (two
 * levels deep, so `electronMock({ app: { getPath } })` keeps the rest of
 * the app surface). Tests that re-mock `electron` must route through this:
 * their graphs pull the whole package root, and a narrow replacement mock
 * would fall through to the real (unloadable) module.
 */
export const electronMock = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => {
  // Top-level replacement (not a merge): a test's stub object must BE the
  // mock's member — main-window tests mutate `nativeTheme.themeSource`
  // through the mock, which a spread copy would break. Overrides that need
  // the base's members list them themselves.
  return {
    ...electronSurface,
    ...overrides,
    default: { ...electronDefaultSurface, ...overrides },
  };
};

export const electronModuleMock = (): unknown => electronMock();

/**
 * Complete `electron` module mock, shared by the three desktop clients and
 * this package's own suite. The real module is a native binary that
 * isn't loadable off-Electron (CI runs `bun test` on plain Node Linux), so
 * `import { app, BrowserWindow, … } from "electron"` would throw the moment
 * any main-process file is imported. The desktop clients import package
 * modules through the package root, whose graph pulls most of electron's
 * main-process surface at load time — so every named value import anywhere
 * under `packages/electron-desktop` must resolve here. Individual tests can
 * still re-mock specific call sites (e.g. `screen.getDisplayMatching`) via
 * their own `mock.module("electron", …)` call inside the test file — bun
 * snapshots a mocked module's namespace at first import, so a re-registration
 * (not an in-place patch) is what a later import sees.
 */
mock.module("electron", electronModuleMock);

/**
 * Mock surface for `electron-log/main`. The package's app-logger calls
 * `log.initialize()` and configures a file transport at import time, and
 * electron-log resolves that transport to a real path under the user's log
 * directory. Any test that reaches the real app-logger (directly, or
 * through the package root's graph) therefore appends to a developer's
 * actual log directory; this mock resolves it to `/dev/null` instead.
 *
 * Individual tests can still re-mock the app-logger to assert on log
 * calls; this only guarantees that a test which forgets to cannot write
 * to disk.
 */
export const electronLogModuleMock = () => ({
  default: {
    initialize: () => undefined,
    transports: { file: { getFile: () => ({ path: "/dev/null" }) } },
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
    silly: () => undefined,
  },
});

mock.module("electron-log/main", electronLogModuleMock);
