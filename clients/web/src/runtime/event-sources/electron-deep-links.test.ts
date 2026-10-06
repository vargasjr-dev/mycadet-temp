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
import {
  __resetConnectDialogForTesting,
  useConnectDialogStore,
} from "@/stores/connect-dialog-store";

const publishSpy = spyOn(eventBus, "publish");

const { publishElectronDeepLinksSource } =
  await import("@/runtime/event-sources/electron-deep-links");

/** Flush the drain promise chain (then/catch/finally). */
const settleDrain = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  activeCallback = null;
  pendingFixture = [];
  drainError = null;
  subscribeToDeepLinksMock.mockClear();
  drainPendingDeepLinksMock.mockClear();
  unsubscribeMock.mockClear();
  publishSpy.mockClear();
  __resetConnectDialogForTesting();
});

describe("publishElectronDeepLinksSource", () => {
  test("maps each DeepLink kind onto its typed bus event for live links", () => {
    publishElectronDeepLinksSource();

    activeCallback!({ kind: "send", message: "hi" });
    activeCallback!({ kind: "openThread", threadId: "t-1" });
    activeCallback!({
      kind: "billingCheckoutComplete",
      status: "success",
      sessionId: "cs_test_a1B2",
      flow: "subscription",
    });
    activeCallback!({
      kind: "billingCheckoutComplete",
      status: "cancel",
      sessionId: null,
      flow: "top_up",
    });
    activeCallback!({ kind: "connect", legacy: true });
    activeCallback!({
      kind: "connect",
      url: "https://assistant.example.com",
      code: "DEVICE-CODE-1",
    });
    activeCallback!({ kind: "unknown", url: "javascript:alert(1)" });

    expect(publishSpy.mock.calls).toEqual([
      ["deeplink.send", { message: "hi" }],
      ["deeplink.openThread", { threadId: "t-1" }],
      [
        "deeplink.billingCheckoutComplete",
        { status: "success", sessionId: "cs_test_a1B2", flow: "subscription" },
      ],
      [
        "deeplink.billingCheckoutComplete",
        { status: "cancel", sessionId: null, flow: "top_up" },
      ],
      ["deeplink.connect", { url: null, code: null, legacy: true }],
      [
        "deeplink.connect",
        {
          url: "https://assistant.example.com",
          code: "DEVICE-CODE-1",
          legacy: false,
        },
      ],
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

  test("latches the drain-settled flag only after the backlog has published", async () => {
    pendingFixture = [
      { kind: "connect", url: "https://assistant.example.com", code: "CODE-1" },
    ];

    publishElectronDeepLinksSource();
    expect(useConnectDialogStore.getState().deepLinkDrainSettled).toBe(false);

    await settleDrain();

    expect(publishSpy.mock.calls).toEqual([
      [
        "deeplink.connect",
        {
          url: "https://assistant.example.com",
          code: "CODE-1",
          legacy: false,
        },
      ],
    ]);
    expect(useConnectDialogStore.getState().deepLinkDrainSettled).toBe(true);
  });

  test("a drain failure still latches the drain-settled flag", async () => {
    drainError = new Error("ipc transport failed");

    publishElectronDeepLinksSource();
    await settleDrain();

    expect(useConnectDialogStore.getState().deepLinkDrainSettled).toBe(true);
  });

  test("returns the subscribe-side unsubscribe so cleanup detaches the live bridge", () => {
    const unsubscribe = publishElectronDeepLinksSource();

    expect(unsubscribeMock).not.toHaveBeenCalled();
    unsubscribe();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });
});
