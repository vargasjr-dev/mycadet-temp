import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

const fetchSpy = spyOn(globalThis, "fetch");

// The boot bundle test needs the shell to read itself as native; served
// surfaces (tests included, happy-dom has no Capacitor bridge) stay false.
let isNative = false;
mock.module("@app/runtime/native-platform", () => ({
  isNativePlatform: () => isNative,
  useIsNativePlatform: () => isNative,
}));

// Registered after the mock above — bun's mock.module is not retroactive for
// already-evaluated modules.
const { AssistantPage } = await import("@app/shell/assistant-page");
type ConfigWindow = Window & { __CADET_CONFIG__?: unknown };

afterEach(() => {
  cleanup();
  fetchSpy.mockReset();
  isNative = false;
  delete (window as ConfigWindow).__CADET_CONFIG__;
});

function renderAssistantPage() {
  const router = createMemoryRouter(
    [{ path: "/assistant/*", Component: AssistantPage }],
    { initialEntries: ["/assistant"] },
  );
  return render(<RouterProvider router={router} />);
}

function stamp(config: unknown) {
  (window as ConfigWindow).__CADET_CONFIG__ = config;
}

test("the boot bundle resolves assistants against the stamped control plane", async () => {
  // A 500 keeps the shell in its error body — the only state that doesn't
  // redirect — while the request URL still proves where resolution went.
  fetchSpy.mockResolvedValue(new Response("nope", { status: 500 }));
  isNative = true;
  stamp({ remote: "local", cloudUrl: "http://localhost:8000" });
  renderAssistantPage();
  await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
  const requested = new URL(String(fetchSpy.mock.calls[0][0]));
  expect(requested.origin).toBe("http://localhost:8000");
  expect(requested.pathname).toBe("/v1/assistants/");
});

test("a served surface with no stamped base keeps resolving same-origin", async () => {
  fetchSpy.mockResolvedValue(new Response("nope", { status: 500 }));
  renderAssistantPage();
  await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
  const requested = new URL(String(fetchSpy.mock.calls[0][0]));
  expect(requested.origin).toBe(window.location.origin);
});
