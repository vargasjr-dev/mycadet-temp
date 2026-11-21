import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  electronAppOverride,
  electronMock,
  recordedIpcHandlers,
} from "../test-setup";

// The lifecycle seam owns everything the three shells shipped identically:
// the lock, the schemes, the userData suffix, the launch capture, and — on
// ready — the universal installs, the protocol stack, the identity slice,
// and the notification runtime, before handing over to the client's setup.
// Electron is mocked so the test drives resolve and reject paths without an
// Electron runtime; the shared surface's ipcMain registry records the
// universal channel registrations.
let readyResolve: (() => void) | null = null;
const logCalls: Array<[string, ...unknown[]]> = [];
const appListeners = new Map<string, Array<() => void>>();
let lockWinner = true;

const deferredReady = () =>
  new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

const appCalls: string[] = [];

mock.module("electron", () =>
  electronMock({
    app: electronAppOverride({
      requestSingleInstanceLock: () => lockWinner,
      on: (event: string, handler: () => void) => {
        const list = appListeners.get(event) ?? [];
        list.push(handler);
        appListeners.set(event, list);
      },
      whenReady: deferredReady,
      quit: () => {
        appCalls.push("quit");
      },
    }),
  }),
);

// startApp's single-purpose module is mocked here (nothing else imports it,
// so no co-run pollution).
const calls: string[] = [];
mock.module("./universal-wiring", () => ({
  installUniversalFeatures: () => {
    calls.push("universal-wiring");
  },
}));

const { startApp } = await import("./app-lifecycle");

// The seam's contract is the full electron-log MainLogger; the test drives
// only info/error, so the stub carries those and casts.
const log = {
  info: (...args: unknown[]) => logCalls.push(["info", ...args]),
  error: (...args: unknown[]) => logCalls.push(["error", ...args]),
} as unknown as Parameters<typeof startApp>[0];

const inputs = {
  ensureVisible: () => undefined,
} as Parameters<typeof startApp>[2];

const drain = async () => {
  readyResolve!();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(() => {
  calls.length = 0;
  logCalls.length = 0;
  appCalls.length = 0;
  appListeners.clear();
  recordedIpcHandlers.clear();
  lockWinner = true;
});

describe("startApp", () => {
  test("logs ready, wires the universal installs and channels, and runs setup once Electron is ready", async () => {
    let ran = false;
    startApp(
      log,
      () => {
        ran = true;
      },
      inputs,
    );

    await drain();

    expect(ran).toBe(true);
    expect(calls).toEqual(["universal-wiring"]);
    expect(
      logCalls.some(
        ([level, message]) => level === "info" && message === "[app] ready",
      ),
    ).toBe(true);
    // The universal protocol stack registers through the shared registrar.
    expect(recordedIpcHandlers.size).toBeGreaterThan(0);
    // The web-contents security wiring rides every WebContents.
    expect(appListeners.has("web-contents-created")).toBe(true);
  });

  test("reports a failed setup as `[app] whenReady setup failed`", async () => {
    const boom = new Error("install blew up");
    startApp(
      log,
      () => {
        throw boom;
      },
      inputs,
    );

    await drain();

    const failure = logCalls.find(
      ([level, message]) =>
        level === "error" && message === "[app] whenReady setup failed:",
    );
    expect(failure).toBeDefined();
    expect(failure![2]).toBe(boom);
  });

  test("a lock loser quits and skips its own setup", async () => {
    lockWinner = false;

    let ran = false;
    startApp(
      log,
      () => {
        ran = true;
      },
      inputs,
    );

    await drain();

    expect(appCalls).toContain("quit");
    expect(ran).toBe(false);
    // The universal block still ran; only the client's setup is gated.
    expect(calls).toEqual(["universal-wiring"]);
  });
});
