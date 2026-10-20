import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SelectAssistantScreen } from "./select-assistant-screen";
import { accountRoute } from "../account-route";
import { AssistantPage } from "@app/shell/assistant-page";
import { assistantSelectionState } from "@app/assistant/assistant-selection";

const request = spyOn(globalThis, "fetch");
const originalConfig = Object.getOwnPropertyDescriptor(
  window,
  "__CADET_CONFIG__",
);
const routers: ReturnType<typeof createMemoryRouter>[] = [];
const host = {
  cloudUrl: "https://host.example/admin/proxy/",
};
const detail = {
  id: "assistant-2",
  status: "active",
  version: "1.2.3",
  url: "web/1.2.3/assistant/",
};
function setup(
  entry:
    | string
    | { pathname: string; state: unknown } = "/account/select-assistant",
  useAccountRoute = false,
) {
  Object.defineProperty(window, "__CADET_CONFIG__", {
    configurable: true,
    value: host,
  });
  const router = createMemoryRouter(
    [
      useAccountRoute
        ? accountRoute
        : {
            path: "/account/select-assistant",
            Component: SelectAssistantScreen,
          },
      { path: "/assistant/*", Component: AssistantPage },
    ],
    { initialEntries: [entry] },
  );
  routers.push(router);
  render(<RouterProvider router={router} />);
  return router;
}
afterEach(() => {
  cleanup();
  for (const router of routers.splice(0)) {
    router.dispose();
  }
  request.mockReset();
  if (originalConfig) {
    Object.defineProperty(window, "__CADET_CONFIG__", originalConfig);
  } else {
    Reflect.deleteProperty(window, "__CADET_CONFIG__");
  }
});
afterAll(() => request.mockRestore());

test("the account route lists names, defaulting unnamed assistants, then resolves only the selected iframe", async () => {
  request
    .mockResolvedValueOnce(
      Response.json({
        results: [{ id: "assistant-1", name: "One" }, { id: "assistant-2" }],
      }),
    )
    .mockResolvedValueOnce(Response.json(detail));
  const router = setup(undefined, true);
  expect(await screen.findByRole("button", { name: "One" })).toBeDefined();
  expect(request).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "New Assistant" }));
  const frame = await screen.findByTitle("Assistant");
  expect(frame.getAttribute("src")).toBe(
    "https://host.example/admin/proxy/web/1.2.3/assistant/",
  );
  expect(router.state.location.state).toEqual(
    assistantSelectionState("assistant-2", host),
  );
  expect(request.mock.calls.map(([url]) => String(url))).toEqual([
    "https://host.example/admin/proxy/v1/assistants/?limit=100&offset=0",
    "https://host.example/admin/proxy/v1/assistants/assistant-2/",
  ]);
  expect(request.mock.calls[0][1]?.credentials).toBe("include");
});

test("a sole assistant waits for selection rather than fetching detail on the account page", async () => {
  request.mockResolvedValueOnce(
    Response.json({ results: [{ id: "assistant-1", name: "One" }] }),
  );
  setup();
  await screen.findByRole("button", { name: "One" });
  expect(request).toHaveBeenCalledTimes(1);
  expect(screen.queryByTitle("Assistant")).toBeNull();
});

test("an empty host list can be refreshed", async () => {
  request
    .mockResolvedValueOnce(Response.json({ results: [] }))
    .mockResolvedValueOnce(
      Response.json({ results: [{ id: "assistant-1", name: "One" }] }),
    );
  setup();
  await screen.findByText("No assistant is available.");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("button", { name: "One" });
});

test("401 displays sign-in without running Web account or onboarding probes", async () => {
  request.mockResolvedValueOnce(new Response(null, { status: 401 }));
  setup();
  await screen.findByText("Please sign in to continue.");
  expect(screen.getByRole("link").getAttribute("href")).toBe("/account/login");
  expect(request).toHaveBeenCalledTimes(1);
});

test("a malformed list produces an error and retry can recover", async () => {
  request
    .mockResolvedValueOnce(Response.json({ results: [{ name: "Missing ID" }] }))
    .mockResolvedValueOnce(
      Response.json({ results: [{ id: "assistant-1", name: "One" }] }),
    );
  setup();
  await screen.findByText("Unable to load assistant.");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("button", { name: "One" });
});

test("leaving the chooser aborts its request and ignores a late reply", async () => {
  let finish!: (value: Response) => void;
  request.mockImplementationOnce(
    Object.assign(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
      { preconnect: fetch.preconnect },
    ),
  );
  setup();
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  const signal = request.mock.calls[0][1]?.signal;
  cleanup();
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    finish(Response.json({ results: [{ id: "assistant-1" }] }));
  });
  expect(screen.queryByRole("button", { name: "assistant-1" })).toBeNull();
});

test("browser history restores selection and frame navigation retains it", async () => {
  request.mockResolvedValueOnce(Response.json(detail));
  const router = setup({
    pathname: "/assistant/files",
    state: assistantSelectionState("assistant-2", host),
  });
  const frame = await screen.findByTitle("Assistant");
  if (!(frame instanceof HTMLIFrameElement)) {
    throw new Error("Missing iframe");
  }
  await act(async () => {});
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "https://host.example",
        data: {
          source: "mycadet-web-nav",
          nav: "push",
          path: "/assistant/settings?tab=profile#name",
        },
      }),
    );
  });
  expect(router.state.location.pathname).toBe("/assistant/settings");
  expect(router.state.location.state).toEqual(
    assistantSelectionState("assistant-2", host),
  );
  expect(request).toHaveBeenCalledTimes(1);
});
