import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { toast } from "@mycadet/design-library/components/toast";
import { __resetLocalLockfileForTesting } from "@app/stores/local-lockfile-store";
import { DesktopChrome } from "./standalone";

const request = spyOn(globalThis, "fetch");

afterEach(() => {
  cleanup();
  request.mockReset();
});

// sonner's render loop runs on a frame; a DOM-less environment has none.
let frameHandle = 0;
globalThis.requestAnimationFrame ??= (cb: FrameRequestCallback) => {
  setTimeout(() => cb(performance.now()), 0);
  frameHandle += 1;
  return frameHandle;
};

test("the app's root mounts the toast outlet so every toast.* call renders", async () => {
  // DesktopChrome is the layout every route renders through and both
  // entries boot via; a stub child keeps the test off the network.
  const router = createMemoryRouter(
    [
      {
        path: "/",
        Component: DesktopChrome,
        children: [{ path: "/", Component: () => null }],
      },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
  // Error toasts render with role=alert; the message must be readable.
  toast.error("The retire failed.");
  expect(await screen.findByRole("alert")).toBeDefined();
  expect(await screen.findByText("The retire failed.")).toBeDefined();
});

// The shell's assistant commands. The stub mirrors the screen tests' cadet
// shape and adds the commands channel the dispatcher subscribes through —
// the captured callback is how a test emits a command as the host would.
describe("the shell's assistant commands", () => {
  const originalCadet = Object.getOwnPropertyDescriptor(window, "cadet");
  const localLockfile = {
    assistants: [
      { assistantId: "assistant-1", name: "One", cloud: "local" },
      {
        assistantId: "paired-1",
        name: "Office",
        cloud: "paired",
        runtimeUrl: "https://office.example.com",
      },
    ],
    activeAssistant: null,
  };

  type Sink = { handler?: (command: unknown) => void };

  function stubCadet(opts: {
    lockfile: unknown;
    status?: (assistantId: string) => unknown;
  }): Sink {
    const sink: Sink = {};
    Object.defineProperty(window, "cadet", {
      configurable: true,
      value: {
        platform: "electron",
        menu: { setCloudSession: async () => {} },
        mainWindow: {
          ensureVisible: async () => {},
          setOnboarding: async () => {},
          navigateTo: async () => {},
        },
        commands: {
          on: (callback: (command: unknown) => void) => {
            sink.handler = callback;
            return () => {};
          },
        },
        localMode: {
          // Availability is detected on the pairing channel itself.
          pairingStart: async () => ({ ok: false, error: "unused" }),
          readLockfile: async () => opts.lockfile,
          status: async (assistantId: string) => opts.status?.(assistantId),
        },
      },
    });
    return sink;
  }

  afterEach(() => {
    if (originalCadet) {
      Object.defineProperty(window, "cadet", originalCadet);
    } else {
      Reflect.deleteProperty(window, "cadet");
    }
    __resetLocalLockfileForTesting();
  });

  function renderChrome(initialEntries: string[] = ["/"]) {
    const router = createMemoryRouter(
      [
        {
          path: "/",
          Component: DesktopChrome,
          children: [
            { path: "/assistant", Component: () => null },
            { path: "/account/select-assistant", Component: () => null },
          ],
        },
      ],
      { initialEntries },
    );
    render(<RouterProvider router={router} />);
    return router;
  }

  test("selectAssistant connects a healthy local entry by navigating with the selection state", async () => {
    const sink = stubCadet({
      lockfile: localLockfile,
      status: () => ({ ok: true, state: "healthy" }),
    });
    const router = renderChrome();
    await act(async () => {
      sink.handler!({ kind: "selectAssistant", assistantId: "assistant-1" });
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/assistant"),
    );
    expect(router.state.location.state).toEqual({
      assistantSelection: { id: "assistant-1" },
    });
  });

  test("selectAssistant connects paired entries same-origin (the host routes by path-id)", async () => {
    const sink = stubCadet({ lockfile: localLockfile });
    const router = renderChrome();
    await act(async () => {
      sink.handler!({ kind: "selectAssistant", assistantId: "paired-1" });
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/assistant"),
    );
    expect(router.state.location.state).toEqual({
      assistantSelection: { id: "paired-1" },
    });
  });

  test("selectAssistant routes a down local daemon to the assistant screen (the not-ready panel owns recovery)", async () => {
    const sink = stubCadet({
      lockfile: localLockfile,
      // The shell doesn't probe health: any lockfile entry connects by
      // navigating with the selection state, and an unreachable gateway
      // lands on the not-ready panel's wake, whatever its remote type.
      status: () => ({ ok: false, status: 502, error: "down" }),
    });
    const router = renderChrome();
    await act(async () => {
      sink.handler!({ kind: "selectAssistant", assistantId: "assistant-1" });
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/assistant"),
    );
    expect(router.state.location.state).toEqual({
      assistantSelection: { id: "assistant-1" },
    });
  });

  test("selectAssistant routes an id the lockfile does not know to the chooser", async () => {
    const sink = stubCadet({ lockfile: localLockfile });
    const router = renderChrome();
    await act(async () => {
      sink.handler!({ kind: "selectAssistant", assistantId: "ghost" });
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/account/select-assistant"),
    );
    expect(await screen.findByRole("alert")).toBeDefined();
  });

  test("rePair reconnects the current selection in place", async () => {
    const sink = stubCadet({ lockfile: localLockfile });
    const router = renderChrome();
    // createMemoryRouter's entries carry no state, so the test selects the
    // way the shell itself does: a navigation carrying the selection state.
    await act(async () => {
      router.navigate("/assistant", {
        state: { assistantSelection: { id: "assistant-1" } },
      });
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/assistant"),
    );
    await act(async () => {
      sink.handler!({ kind: "rePair" });
    });
    // Reconnected in place: the selection state is re-carried, never a
    // bounce to the chooser.
    expect(router.state.location.pathname).toBe("/assistant");
    expect(router.state.location.state).toEqual({
      assistantSelection: { id: "assistant-1" },
    });
  });

  test("the retire command confirms into the one same-origin retire endpoint", async () => {
    // The lockfile fixture's LOCAL row retires through the same endpoint a
    // platform row does: the serving host (the desktop proxy) owns the
    // on-machine teardown, so the shell never branches on entry type. The
    // stub's localMode exposes no retire bridge at all — a bridge call would
    // fail the test, not silently pass.
    request.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const sink = stubCadet({
      lockfile: localLockfile,
      status: () => ({ ok: true, state: "healthy" }),
    });
    renderChrome();
    await act(async () => {
      sink.handler!({ kind: "retireAssistant", assistantId: "assistant-1" });
    });
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Retire" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const deleteCall = request.mock.calls.find(([url, init]) =>
      String(url).includes("/retire/"),
    );
    expect(String(deleteCall?.[0])).toBe("/v1/assistants/assistant-1/retire/");
    expect(deleteCall?.[1]?.method).toBe("DELETE");
  });

  test("rePair without a selection does nothing", async () => {
    const statusCalls: string[] = [];
    const sink = stubCadet({
      lockfile: localLockfile,
      status: (assistantId) => {
        statusCalls.push(assistantId);
        return { ok: true, state: "healthy" };
      },
    });
    const router = renderChrome(["/assistant"]);
    await act(async () => {
      sink.handler!({ kind: "rePair" });
    });
    // Give any misrouted navigation a beat to land before asserting.
    await act(async () => {});
    expect(statusCalls).toEqual([]);
    expect(router.state.location.pathname).toBe("/assistant");
  });
});
