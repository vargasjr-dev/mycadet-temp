import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// Type-only, so it is erased before `mock.module` replaces the module.
import type { DeepLink } from "@/runtime/deep-links";

let activeCallback: ((link: DeepLink) => void) | null = null;
let pendingFixture: DeepLink[] = [];
let drainError: Error | null = null;
const unsubscribeMock = mock(() => {
  activeCallback = null;
});
const subscribeToDeepLinksMock = mock((cb: (link: DeepLink) => void) => {
  activeCallback = cb;
  return unsubscribeMock;
});
const drainPendingDeepLinksMock = mock(async (): Promise<DeepLink[]> => {
  if (drainError) {
    throw drainError;
  }
  const drained = pendingFixture;
  pendingFixture = [];
  return drained;
});

mock.module("@/runtime/deep-links", () => ({
  drainPendingDeepLinks: drainPendingDeepLinksMock,
  subscribeToDeepLinks: subscribeToDeepLinksMock,
}));

const consoleWarnMock = mock(() => {});
console.warn = consoleWarnMock as typeof console.warn;

import * as eventBus from "@/lib/event-bus";
const publishSpy = spyOn(eventBus, "publish");

const { publishElectronDeepLinksSource } =
  await import("@/runtime/event-sources/electron-deep-links");

beforeEach(() => {
  activeCallback = null;
  pendingFixture = [];
  drainError = null;
  subscribeToDeepLinksMock.mockClear();
  drainPendingDeepLinksMock.mockClear();
  unsubscribeMock.mockClear();
  publishSpy.mockClear();
});

describe("publishElectronDeepLinksSource", () => {
  test("maps each DeepLink kind onto its typed bus event for live links", () => {
    publishElectronDeepLinksSource();

    activeCallback!({ kind: "send", message: "hi" });
    activeCallback!({ kind: "openThread", threadId: "t-1" });
    activeCallback!({ kind: "unknown", url: "javascript:alert(1)" });

    expect(publishSpy.mock.calls).toEqual([
      ["deeplink.send", { message: "hi" }],
      ["deeplink.openThread", { threadId: "t-1" }],
      ["deeplink.unknown", { url: "javascript:alert(1)" }],
    ]);
  });

  test("subscribes BEFORE draining — covers the in-flight race", async () => {
    publishElectronDeepLinksSource();

    expect(subscribeToDeepLinksMock).toHaveBeenCalled();
    expect(drainPendingDeepLinksMock).toHaveBeenCalled();
    const subscribeOrder =
      subscribeToDeepLinksMock.mock.invocationCallOrder[0]!;
    const drainOrder = drainPendingDeepLinksMock.mock.invocationCallOrder[0]!;
    expect(subscribeOrder).toBeLessThan(drainOrder);
  });

  test("publishes drained links once the drain promise settles", async () => {
    pendingFixture = [
      { kind: "send", message: "one" },
      { kind: "openThread", threadId: "thread-1" },
    ];

    publishElectronDeepLinksSource();
    await Promise.resolve();
    await Promise.resolve();

    expect(publishSpy.mock.calls).toEqual([
      ["deeplink.send", { message: "one" }],
      ["deeplink.openThread", { threadId: "thread-1" }],
    ]);
  });

  test("reports a drain failure instead of propagating", async () => {
    drainError = new Error("ipc transport failed");

    publishElectronDeepLinksSource();
    await Promise.resolve();
    await Promise.resolve();

    expect(consoleWarnMock).toHaveBeenCalledWith(
      "[deep_link_drain]",
      drainError,
      "",
    );
  });

  test("returns the subscribe-side unsubscribe so cleanup detaches the live bridge", () => {
    const unsubscribe = publishElectronDeepLinksSource();

    expect(unsubscribeMock).not.toHaveBeenCalled();
    unsubscribe();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });
});
