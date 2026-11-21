import { describe, expect, mock, test } from "bun:test";

// The lifecycle helper owns the whenReady + catch shape every desktop main
// shares. Electron's `app` is mocked so the test drives resolve and reject
// paths without an Electron runtime.
let readyResolve: (() => void) | null = null;
const logCalls: Array<[string, ...unknown[]]> = [];

mock.module("electron", () => ({
  app: {
    whenReady: () =>
      new Promise<void>((resolve) => {
        readyResolve = resolve;
      }),
  },
}));

// startApp owns the universal wiring now; the single-purpose module it
// calls is mocked here (nothing else imports it, so no co-run pollution).
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

describe("startApp", () => {
  test("logs ready, wires the universal installs, and runs setup once Electron is ready", async () => {
    let ran = false;
    startApp(log, () => {
      ran = true;
    });

    readyResolve!();
    await Promise.resolve();
    await Promise.resolve();

    expect(ran).toBe(true);
    expect(calls).toEqual(["universal-wiring"]);
    expect(
      logCalls.some(
        ([level, message]) => level === "info" && message === "[app] ready",
      ),
    ).toBe(true);
  });

  test("reports a failed setup as `[app] whenReady setup failed`", async () => {
    const boom = new Error("install blew up");
    startApp(log, () => {
      throw boom;
    });

    readyResolve!();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    const failure = logCalls.find(
      ([level, message]) =>
        level === "error" && message === "[app] whenReady setup failed:",
    );
    expect(failure).toBeDefined();
    expect(failure![2]).toBe(boom);
  });
});
