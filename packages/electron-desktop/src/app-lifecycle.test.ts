import { beforeAll, describe, expect, mock, test } from "bun:test";

import type { IpcHandle } from "./ipc";

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

const { runWhenReady } = await import("./app-lifecycle");

const log = {
  info: (...args: unknown[]) => logCalls.push(["info", ...args]),
  error: (...args: unknown[]) => logCalls.push(["error", ...args]),
};

describe("runWhenReady", () => {
  test("logs ready and runs setup once Electron is ready", async () => {
    let ran = false;
    runWhenReady(log, () => {
      ran = true;
    });

    readyResolve!();
    await Promise.resolve();
    await Promise.resolve();

    expect(ran).toBe(true);
    expect(logCalls.some(([level, message]) => level === "info" && message === "[app] ready")).toBe(true);
  });

  test("reports a failed setup as `[app] whenReady setup failed`", async () => {
    const boom = new Error("install blew up");
    runWhenReady(log, () => {
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
