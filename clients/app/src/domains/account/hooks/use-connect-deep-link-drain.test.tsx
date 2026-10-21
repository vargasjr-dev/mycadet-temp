/**
 * Tests for `useConnectDeepLinkDrain` — the app-side consumer of the shell's
 * `cadet://` deep-link channel.
 *
 * The bridge is stubbed at `window.cadet` (the same seam the production
 * preload populates), so the tests drive live links and the startup backlog
 * through the hook's real subscribe-then-drain order. Assertions read the
 * connect-dialog store and a location probe, since the hook's whole job is
 * parking dialog state and navigating.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";

import {
  __resetConnectDialogForTesting,
  useConnectDialogStore,
} from "@app/stores/connect-dialog-store";
import { useConnectDeepLinkDrain } from "./use-connect-deep-link-drain";
import type { DeepLink } from "@app/runtime/deep-links";
import { pairingLinkForBase } from "@app/utils/pairing-address";

const CHOOSER = "/account/select-assistant";

type LinkSink = (link: DeepLink) => void;

const ensureVisible = mock(async () => undefined);
const handlers: LinkSink[] = [];
let backlog: DeepLink[] = [];
let drained = 0;

function bridgeFor(platform: string | undefined) {
  return {
    platform,
    menu: { setCloudSession: async () => undefined },
    commands: { on: () => () => undefined },
    deepLinks: {
      onLink(callback: LinkSink) {
        handlers.push(callback);
        return () => {
          const index = handlers.indexOf(callback);
          if (index >= 0) handlers.splice(index, 1);
        };
      },
      async drain() {
        drained += 1;
        const pending = backlog;
        backlog = [];
        return pending;
      },
    },
    mainWindow: {
      ensureVisible,
      setOnboarding: async () => undefined,
      navigateTo: async () => undefined,
    },
  } as unknown as Window["cadet"] & object;
}

const initialBridge = window.cadet;

afterEach(() => {
  cleanup();
  window.cadet = initialBridge;
  handlers.length = 0;
  backlog = [];
  drained = 0;
  ensureVisible.mockClear();
  __resetConnectDialogForTesting();
});

function DrainMount(): React.ReactElement {
  useConnectDeepLinkDrain();
  const { pathname } = useLocation();
  return <div data-testid="loc">{pathname}</div>;
}

function renderDrained(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={["/assistant"]}>
      <DrainMount />
    </MemoryRouter>,
  );
}

function emit(link: DeepLink): void {
  for (const handler of handlers) handler(link);
}

function flushTasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("useConnectDeepLinkDrain", () => {
  test("off the shell it is inert and never touches the dialog", () => {
    window.cadet = undefined;
    renderDrained();

    expect(handlers).toEqual([]);
    expect(useConnectDialogStore.getState().open).toBe(false);
  });

  test("a live pairing link parks its address and lands on the chooser", async () => {
    window.cadet = bridgeFor("electron");
    const view = renderDrained();
    await flushTasks();
    ensureVisible.mockClear();

    const url = "https://my-assistant.example.com";
    const code = "devcode-1";
    await act(async () => {
      emit({ kind: "connect", url, code });
    });

    const state = useConnectDialogStore.getState();
    expect(state.open).toBe(true);
    expect(state.initialAddress).toBe(pairingLinkForBase(url, code));
    expect(state.guidanceKind).toBe(null);
    expect(ensureVisible).toHaveBeenCalled();
    expect(view.getByTestId("loc").textContent).toBe(CHOOSER);
  });

  test("a bare base opens the dialog on that address alone", () => {
    window.cadet = bridgeFor("electron");
    renderDrained();

    emit({ kind: "connect", url: "https://my-assistant.example.com" });

    const state = useConnectDialogStore.getState();
    expect(state.open).toBe(true);
    expect(state.initialAddress).toBe("https://my-assistant.example.com");
  });

  test("an address-less link explains itself, legacy links call it out", () => {
    window.cadet = bridgeFor("electron");
    renderDrained();

    emit({ kind: "connect" });
    expect(useConnectDialogStore.getState().guidanceKind).toBe("generic");

    emit({ kind: "connect", legacy: true });
    expect(useConnectDialogStore.getState().guidanceKind).toBe("legacy");
  });

  test("other link kinds are ignored, not dead-ends", () => {
    window.cadet = bridgeFor("electron");
    renderDrained();

    emit({ kind: "send", message: "hello" });
    emit({ kind: "openThread", threadId: "t1" });
    emit({ kind: "unknown", url: "cadet://nope" });

    expect(useConnectDialogStore.getState().open).toBe(false);
    expect(ensureVisible).not.toHaveBeenCalled();
  });

  test("the startup backlog drains through the same handler, then the latch settles", async () => {
    backlog = [
      { kind: "connect", url: "https://cold.example.com", code: "cold-1" },
    ];
    window.cadet = bridgeFor("electron");
    renderDrained();

    await flushTasks();

    expect(useConnectDialogStore.getState().initialAddress).toBe(
      pairingLinkForBase("https://cold.example.com", "cold-1"),
    );
    expect(useConnectDialogStore.getState().deepLinkDrainSettled).toBe(true);
  });

  test("a failed drain still settles the latch", async () => {
    window.cadet = bridgeFor("electron");
    // Make this render's drain reject by pointing deepLinks.drain at a
    // thrower for the next call only.
    const bridge = window.cadet as unknown as {
      deepLinks: { drain: () => Promise<DeepLink[]> };
    };
    bridge.deepLinks.drain = async () => {
      throw new Error("drain unavailable");
    };
    renderDrained();

    await flushTasks();

    expect(useConnectDialogStore.getState().deepLinkDrainSettled).toBe(true);
    expect(useConnectDialogStore.getState().open).toBe(false);
  });
});
