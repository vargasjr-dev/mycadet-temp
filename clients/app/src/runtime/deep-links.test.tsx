import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";

import type { DeepLink } from "@mycadet/ipc-contract";
import { useDeepLinkConsumer } from "./deep-links";
import {
  __resetConnectDialogForTesting,
  useConnectDialogStore,
} from "@app/stores/connect-dialog-store";
import { pairingLinkForBase } from "@app/utils/pairing-address";

type LinkCallback = (link: DeepLink) => void;

let liveCallback: LinkCallback | null = null;
let backlog: DeepLink[] = [];
let drainFailure: unknown = null;

/**
 * The app bridge stub: `drain` hands back the captured backlog (or throws
 * the injected failure), `onLink` captures the live callback. The app
 * bundle's bridge is feature-detected off `window.cadet`, so tests install
 * it through `Object.defineProperty` and restore the original descriptor
 * afterwards.
 */
function installCadetStub(): void {
  Object.defineProperty(window, "cadet", {
    configurable: true,
    value: {
      platform: "electron",
      deepLinks: {
        drain: async () => {
          if (drainFailure !== null) {
            throw drainFailure;
          }
          return backlog;
        },
        onLink: (callback: LinkCallback) => {
          liveCallback = callback;
          return () => {
            liveCallback = null;
          };
        },
      },
    },
  });
}

function fireLiveLink(link: DeepLink): void {
  act(() => {
    liveCallback?.(link);
  });
}

/** Flush the drain's microtask chain so the backlog publishes and the latch settles. */
async function flushDrain(): Promise<void> {
  await act(async () => {});
}

function locationPathname(): string {
  return screen.getByTestId("location").textContent ?? "";
}

function DeepLinkHarness() {
  useDeepLinkConsumer();
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderHarness(): void {
  render(
    <MemoryRouter initialEntries={["/assistant"]}>
      <DeepLinkHarness />
    </MemoryRouter>,
  );
}

const originalCadet = Object.getOwnPropertyDescriptor(window, "cadet");

describe("useDeepLinkConsumer", () => {
  beforeEach(() => {
    liveCallback = null;
    backlog = [];
    drainFailure = null;
    __resetConnectDialogForTesting();
  });

  afterEach(() => {
    cleanup();
    if (originalCadet) {
      Object.defineProperty(window, "cadet", originalCadet);
    } else {
      Reflect.deleteProperty(window, "cadet");
    }
    __resetConnectDialogForTesting();
  });

  test("a connect link with a base and device code parks the recomposed pairing link and navigates to the chooser", () => {
    installCadetStub();
    renderHarness();
    fireLiveLink({
      kind: "connect",
      url: "https://example.com",
      code: "dev-code",
    });
    const state = useConnectDialogStore.getState();
    expect(state.open).toBe(true);
    expect(state.initialAddress).toBe(
      pairingLinkForBase("https://example.com", "dev-code"),
    );
    expect(state.guidanceKind).toBeNull();
    expect(locationPathname()).toBe("/account/select-assistant");
  });

  test("a connect link carrying only a base parks the bare address", () => {
    installCadetStub();
    renderHarness();
    fireLiveLink({ kind: "connect", url: "https://example.com" });
    const state = useConnectDialogStore.getState();
    expect(state.open).toBe(true);
    expect(state.initialAddress).toBe("https://example.com");
    expect(state.guidanceKind).toBeNull();
    expect(locationPathname()).toBe("/account/select-assistant");
  });

  test("an address-less connect link parks legacy guidance", () => {
    installCadetStub();
    renderHarness();
    fireLiveLink({ kind: "connect", legacy: true });
    const state = useConnectDialogStore.getState();
    expect(state.open).toBe(true);
    expect(state.initialAddress).toBeNull();
    expect(state.guidanceKind).toBe("legacy");
    expect(locationPathname()).toBe("/account/select-assistant");
  });

  test("an address-less connect link without a legacy bundle parks generic guidance", () => {
    installCadetStub();
    renderHarness();
    fireLiveLink({ kind: "connect" });
    const state = useConnectDialogStore.getState();
    expect(state.open).toBe(true);
    expect(state.initialAddress).toBeNull();
    expect(state.guidanceKind).toBe("generic");
  });

  test("the drain publishes the cold-start backlog and then latches the settled flag", async () => {
    installCadetStub();
    backlog = [{ kind: "connect", url: "https://backlog.example" }];
    renderHarness();
    await flushDrain();
    const state = useConnectDialogStore.getState();
    expect(state.open).toBe(true);
    expect(state.initialAddress).toBe("https://backlog.example");
    expect(locationPathname()).toBe("/account/select-assistant");
    expect(state.deepLinkDrainSettled).toBe(true);
  });

  test("an unknown link is ignored", async () => {
    installCadetStub();
    renderHarness();
    fireLiveLink({ kind: "unknown", url: "cadet://gibberish" });
    const state = useConnectDialogStore.getState();
    expect(state.open).toBe(false);
    expect(state.initialAddress).toBeNull();
    expect(locationPathname()).toBe("/assistant");
    await flushDrain();
    expect(useConnectDialogStore.getState().deepLinkDrainSettled).toBe(true);
  });

  test("a failed drain still settles the latch", async () => {
    installCadetStub();
    drainFailure = new Error("drain went sideways");
    renderHarness();
    await flushDrain();
    const state = useConnectDialogStore.getState();
    expect(state.deepLinkDrainSettled).toBe(true);
    expect(state.open).toBe(false);
  });

  test("off Electron nothing subscribes but the latch still settles", async () => {
    Reflect.deleteProperty(window, "cadet");
    renderHarness();
    await flushDrain();
    const state = useConnectDialogStore.getState();
    expect(liveCallback).toBeNull();
    expect(state.deepLinkDrainSettled).toBe(true);
    expect(state.open).toBe(false);
    expect(locationPathname()).toBe("/assistant");
  });
});
