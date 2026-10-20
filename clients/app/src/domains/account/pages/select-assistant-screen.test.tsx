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
const iframeDocument = new Response("<!doctype html><html></html>", {
  headers: { "content-type": "text/html" },
});
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
  respond?: (url: RequestInfo | URL) => Promise<Response>,
) {
  // The shell resolves assistants same-origin now, so the mounted iframe's
  // own document is fetched from the test origin; answer it quietly.
  request.mockImplementation(
    Object.assign(respond ?? (async () => iframeDocument.clone()), {
      preconnect: fetch.preconnect,
    }),
  );
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
  expect(await screen.findByRole("radio", { name: "One" })).toBeDefined();
  expect(request).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("radio", { name: "New Assistant" }));
  const frame = await screen.findByTitle("Assistant");
  expect(frame.getAttribute("src")).toBe(
    "http://localhost:3001/web/1.2.3/assistant/",
  );
  expect(router.state.location.state).toEqual(
    assistantSelectionState("assistant-2"),
  );
  // The account picker lists from the cloud base; the shell resolves the
  // chosen assistant from its own origin, which routes /v1 to the gateway.
  expect(
    request.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("/v1/")),
  ).toEqual([
    "https://host.example/admin/proxy/v1/assistants/?limit=100&offset=0",
    "http://localhost:3001/v1/assistants/assistant-2/",
  ]);
  expect(request.mock.calls[0][1]?.credentials).toBe("include");
});

test("rows render the cloud's synced avatar when the list carries one", async () => {
  request.mockResolvedValueOnce(
    Response.json({
      results: [
        {
          id: "assistant-1",
          name: "One",
          avatar_url: "https://cloud.example/one.png",
        },
        { id: "assistant-2", name: "Two" },
      ],
    }),
  );
  setup();
  const withAvatar = await screen.findByRole("radio", { name: "One" });
  const img = withAvatar.querySelector("img");
  expect(img?.getAttribute("src")).toBe("https://cloud.example/one.png");
  // The chip is decorative: the row's own label names the assistant.
  expect(img?.getAttribute("alt")).toBe("");
  const bare = screen.getByRole("radio", { name: "Two" });
  expect(bare.querySelector("img")).toBeNull();
  // A thumbnail that fails to load demotes to the initial for the row.
  if (!(img instanceof HTMLImageElement)) {
    throw new Error("Missing thumbnail.");
  }
  fireEvent.error(img);
  expect(withAvatar.querySelector("img")).toBeNull();
  expect(withAvatar.textContent).toContain("O");
});

test("arrow keys move focus across cards without selecting", async () => {
  request.mockResolvedValueOnce(
    Response.json({
      results: [
        { id: "assistant-1", name: "One" },
        { id: "assistant-2", name: "Two" },
      ],
    }),
  );
  const router = setup();
  const one = await screen.findByRole("radio", { name: "One" });
  const two = screen.getByRole("radio", { name: "Two" });
  one.focus();
  fireEvent.keyDown(one, { key: "ArrowDown" });
  expect(document.activeElement).toBe(two);
  // Focus-only: arrowing through the list never navigates into an assistant.
  expect(router.state.location.pathname).toBe("/account/select-assistant");
  expect(screen.queryByTitle("Assistant")).toBeNull();
});

test("Enter selects the focused card", async () => {
  request
    .mockResolvedValueOnce(
      Response.json({ results: [{ id: "assistant-1", name: "One" }] }),
    )
    // The shell rejects a detail whose id mismatches the selection, so the
    // queued detail must answer the assistant the card navigated with.
    .mockResolvedValueOnce(Response.json({ ...detail, id: "assistant-1" }));
  const router = setup();
  const one = await screen.findByRole("radio", { name: "One" });
  fireEvent.keyDown(one, { key: "Enter" });
  const frame = await screen.findByTitle("Assistant");
  expect(frame.getAttribute("src")).toBe(
    "http://localhost:3001/web/1.2.3/assistant/",
  );
  expect(router.state.location.state).toEqual(
    assistantSelectionState("assistant-1"),
  );
});

test("a sole assistant waits for selection rather than fetching detail on the account page", async () => {
  request.mockResolvedValueOnce(
    Response.json({ results: [{ id: "assistant-1", name: "One" }] }),
  );
  setup();
  await screen.findByRole("radio", { name: "One" });
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
  await screen.findByRole("radio", { name: "One" });
});

test("an empty list offers creation and lands in the created assistant", async () => {
  const router = setup("/account/select-assistant", false, async (url) => {
    const target = String(url);
    if (target.includes("/v1/assistants/?")) {
      return Response.json({ results: [] });
    }
    // The dialog's create flow resolves the organization, hatches, and the
    // shell then resolves the created assistant's detail same-origin.
    if (target.includes("/v1/organizations/")) {
      return Response.json({ results: [{ id: "org-1" }] });
    }
    if (target.includes("/hatch/")) {
      return Response.json(detail);
    }
    if (target.includes("/v1/assistants/assistant-2/")) {
      return Response.json(detail);
    }
    return iframeDocument.clone();
  });
  await screen.findByText("No assistant is available.");
  fireEvent.click(screen.getByRole("button", { name: "Create an assistant" }));
  fireEvent.click(await screen.findByRole("button", { name: "Create" }));
  await screen.findByTitle("Assistant");
  expect(router.state.location.state).toEqual(
    assistantSelectionState("assistant-2"),
  );
  expect(
    request.mock.calls
      .map(([url]) => String(url))
      // The create flow rides the bundle's own auth machinery, which probes
      // the platform session between API calls; pin the load-bearing chain.
      .filter((url) => url.includes("/v1/") && !url.includes("/_allauth/")),
  ).toEqual([
    "https://host.example/admin/proxy/v1/assistants/?limit=100&offset=0",
    "/v1/organizations/?limit=100&offset=0",
    "/v1/assistants/hatch/?mode=create",
    "http://localhost:3001/v1/assistants/assistant-2/",
  ]);
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
  await screen.findByRole("radio", { name: "One" });
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
  expect(screen.queryByRole("radio", { name: "assistant-1" })).toBeNull();
});

test("browser history restores selection and frame navigation retains it", async () => {
  request.mockResolvedValueOnce(Response.json(detail));
  const router = setup({
    pathname: "/assistant/files",
    state: assistantSelectionState("assistant-2"),
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
        origin: "http://localhost:3001",
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
    assistantSelectionState("assistant-2"),
  );
  expect(request).toHaveBeenCalledTimes(1);
});
