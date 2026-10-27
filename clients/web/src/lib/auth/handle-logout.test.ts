/**
 * Signing out replaces the page with `hardNavigate`, which runs no React
 * unmount cleanup. Everything the app is publishing to a surface that
 * outlives the page has to be given up here instead, in the last tick a
 * renderer still exists to publish from — and the account revocation itself
 * now lives behind the app bundle's logout page, so the hand-off is the last
 * thing that happens.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import type * as WatchController from "@/domains/chat/watch/watch-controller";

/** Every teardown call in the order it happened, which is the whole point. */
const order: string[] = [];

const stopWatchMock = mock(() => {
  order.push("stopWatch");
});
const clearWorkingMock = mock(() => {
  order.push("clearCompanionWorking");
});
const hardNavigateMock = mock((_url: string) => {
  order.push("hardNavigate");
});
const menuMock = mock(async () => {
  order.push("menu");
});
const unregisterPushMock = mock(async () => {
  order.push("unregisterPush");
});
const unregisterLiveActivityMock = mock(async () => {
  order.push("unregisterLiveActivity");
});
const endSessionMock = mock(async () => {
  order.push("endSession");
});
const clearStorageMock = mock(() => {
  order.push("clearStorage");
});
const setActiveAssistantIdMock = mock((_id: string | null) => {
  order.push("setActiveAssistantId");
});
const setSelectedAssistantMock = mock(async (_a: string | null) => {
  order.push("setSelectedAssistant");
});

let isLocal = false;
let activeAssistant: { cloud: string } | null = null;
let selfHostedIngress: string | null = null;

mock.module(
  "@/domains/chat/watch/watch-controller",
  (): Partial<typeof WatchController> => ({
    stopWatch: stopWatchMock,
  }),
);

mock.module("@/runtime/companion-surface", () => ({
  clearCompanionWorking: clearWorkingMock,
}));

mock.module("@/lib/auth/hard-navigate", () => ({
  hardNavigate: hardNavigateMock,
}));

mock.module("@/lib/auth/session-hygiene", () => ({
  endSession: endSessionMock,
}));

mock.module("@/lib/auth/session-cleanup", () => ({
  clearUserScopedStorage: clearStorageMock,
}));

mock.module("@/lib/local-mode", () => ({
  isLocalClient: () => isLocal,
  getActiveAssistant: () => activeAssistant,
  isLocalAssistant: (a: { cloud: string }) => a.cloud === "local",
}));

mock.module("@/lib/self-hosted/connection", () => ({
  getSelfHostedIngressUrl: () => selfHostedIngress,
  setSelfHostedConnection: () => undefined,
}));

mock.module("@/runtime/identity", () => ({
  setAssistantName: () => undefined,
}));

mock.module("@/runtime/menu", () => ({
  setMenuCloudSession: menuMock,
}));

mock.module("@/runtime/push-registration", () => ({
  unregisterFromRemotePush: unregisterPushMock,
}));

mock.module(
  "@/domains/chat/voice/live-voice/live-activity-push-registration",
  () => ({
    unregisterLiveActivityPushToken: unregisterLiveActivityMock,
  }),
);

mock.module("@/assistant/selection", () => ({
  setSelectedAssistant: setSelectedAssistantMock,
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    getState: () => ({
      setActiveAssistantId: setActiveAssistantIdMock,
    }),
  },
}));

const { handleLogout } = await import("./handle-logout");

/**
 * Where a teardown call landed, refusing an absent one rather than reporting
 * `-1`. Without this every ordering assertion below would also pass when the
 * call it is ordering is not made at all.
 */
const at = (label: string): number => {
  const index = order.indexOf(label);
  if (index === -1) {
    throw new Error(`Expected ${label} to have been called, got: ${order}`);
  }
  return index;
};

afterEach(() => {
  order.length = 0;
  stopWatchMock.mockClear();
  clearWorkingMock.mockClear();
  hardNavigateMock.mockClear();
  menuMock.mockClear();
  unregisterPushMock.mockClear();
  unregisterLiveActivityMock.mockClear();
  endSessionMock.mockClear();
  clearStorageMock.mockClear();
  setActiveAssistantIdMock.mockClear();
  setSelectedAssistantMock.mockClear();
  isLocal = false;
  activeAssistant = null;
  selfHostedIngress = null;
});

describe("the watch session when the user signs out", () => {
  /**
   * The failure this guards is a capture indicator that stays lit after the
   * session is gone. A user who signs out and still sees the ring has been
   * told their screen is being read when it is not, which is the same harm as
   * a real capture nothing draws.
   */
  test("is ended on the path that replaces the page", async () => {
    await handleLogout();

    expect(stopWatchMock).toHaveBeenCalledTimes(1);
  });

  test("is ended before the navigation that would strand it", async () => {
    await handleLogout();

    expect(at("stopWatch")).toBeLessThan(at("hardNavigate"));
  });

  /**
   * Stopping republishes the whole context with `working` recomputed from the
   * live stores, so a turn still in flight would put the ring back if the
   * clear ran first.
   */
  test("is ended before the working claim is given up", async () => {
    await handleLogout();

    expect(at("stopWatch")).toBeLessThan(at("clearCompanionWorking"));
  });
});

describe("the account hand-off", () => {
  test("lands on the app bundle's logout page", async () => {
    await handleLogout();

    expect(hardNavigateMock).toHaveBeenCalledWith("/logout");
  });

  /**
   * The push-token cloud delete authenticates with the still-valid session
   * cookie — the app bundle's revocation only runs after the hand-off, so
   * the unregistration must not wait for it.
   */
  test("unregisters push before the navigation that revokes", async () => {
    await handleLogout();

    expect(at("unregisterPush")).toBeLessThan(at("hardNavigate"));
  });
});

describe("the local assistant's sign-out", () => {
  test("only moves the menu toggle — the cloud account stands", async () => {
    isLocal = true;
    activeAssistant = { cloud: "local" };

    await handleLogout();

    expect(menuMock).toHaveBeenCalledTimes(1);
    expect(hardNavigateMock).not.toHaveBeenCalled();
    expect(stopWatchMock).not.toHaveBeenCalled();
    expect(unregisterPushMock).not.toHaveBeenCalled();
  });
});

describe("the self-hosted ingress's sign-out", () => {
  /**
   * The connection slot IS the credential — there is no platform session
   * behind it to revoke, so no hand-off to the app bundle's revocation.
   */
  test("drops the session locally and lands on the front door", async () => {
    isLocal = true;
    selfHostedIngress = "https://gateway.example.internal";

    await handleLogout();

    expect(hardNavigateMock).toHaveBeenCalledWith("/account/onboarding/welcome");
    expect(at("setActiveAssistantId")).toBeLessThan(at("setSelectedAssistant"));
    expect(menuMock).not.toHaveBeenCalled();
  });
});
