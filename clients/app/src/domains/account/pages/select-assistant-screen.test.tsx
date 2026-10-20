import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { within } from "@testing-library/react";
import { SelectAssistantScreen } from "./select-assistant-screen";
import { accountRoute } from "../account-route";
import { AssistantPage } from "@app/shell/assistant-page";
import { assistantSelectionState } from "@app/assistant/assistant-selection";
import {
  REMEMBERED_ORIGINS_STORAGE_KEY,
  resetRememberedOriginsForTesting,
} from "@app/stores/remembered-origins-store";

const request = spyOn(globalThis, "fetch");
const iframeDocument = new Response("<!doctype html><html></html>", {
  headers: { "content-type": "text/html" },
});
const originalConfig = Object.getOwnPropertyDescriptor(
  window,
  "__CADET_CONFIG__",
);
const routers: ReturnType<typeof createMemoryRouter>[] = [];
// The retire mutation's csrf bootstrap reads this cookie; seed it so no
// test fetch is spent (or delayed) on a session probe.
document.cookie = "csrftoken=test; path=/";
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
afterEach(() => {
  localStorage.clear();
  resetRememberedOriginsForTesting();
});

test("the account route lists names, defaulting unnamed assistants, then resolves only the selected iframe", async () => {
  request
    .mockResolvedValueOnce(
      Response.json({
        results: [{ id: "assistant-1", name: "One" }, { id: "assistant-2" }],
      }),
    )
    .mockResolvedValueOnce(Response.json(detail));
  const router = setup(undefined, true);
  expect(await screen.findByRole("radio", { name: /^One/ })).toBeDefined();
  expect(request).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("radio", { name: /^New Assistant/ }));
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
  const withAvatar = await screen.findByRole("radio", { name: /^One/ });
  const img = withAvatar.querySelector("img");
  expect(img?.getAttribute("src")).toBe("https://cloud.example/one.png");
  // The chip is decorative: the row's own label names the assistant.
  expect(img?.getAttribute("alt")).toBe("");
  const bare = screen.getByRole("radio", { name: /^Two/ });
  expect(bare.querySelector("img")).toBeNull();
  // A thumbnail that fails to load demotes to the initial for the row.
  if (!(img instanceof HTMLImageElement)) {
    throw new Error("Missing thumbnail.");
  }
  fireEvent.error(img);
  expect(withAvatar.querySelector("img")).toBeNull();
  expect(withAvatar.textContent).toContain("O");
});

test("rows render the cloud-hosted subtitle with a relative creation date", async () => {
  request.mockResolvedValueOnce(
    Response.json({
      results: [
        {
          id: "assistant-1",
          name: "One",
          // Three whole days back, with a minute of margin so the day floor
          // lands on 3 regardless of how long the test takes to run.
          created: new Date(
            Date.now() - 3 * 24 * 3_600_000 - 60_000,
          ).toISOString(),
        },
        { id: "assistant-2", name: "Two" },
      ],
    }),
  );
  setup();
  const withDate = await screen.findByRole("radio", { name: /^One/ });
  expect(withDate.textContent).toContain("Cloud-hosted · Created 3d ago");
  const withoutDate = screen.getByRole("radio", { name: /^Two/ });
  expect(withoutDate.textContent).toContain("Cloud-hosted");
  expect(withoutDate.textContent).not.toContain("Created");
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
  const one = await screen.findByRole("radio", { name: /^One/ });
  const two = screen.getByRole("radio", { name: /^Two/ });
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
  const one = await screen.findByRole("radio", { name: /^One/ });
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
  await screen.findByRole("radio", { name: /^One/ });
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
  await screen.findByRole("radio", { name: /^One/ });
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

test("the row's menu retires the assistant and refreshes the list", async () => {
  request
    .mockResolvedValueOnce(
      Response.json({
        results: [
          { id: "assistant-1", name: "One" },
          { id: "assistant-2", name: "Two" },
        ],
      }),
    )
    // The DELETE lands, then the refresh re-lists without the retired row.
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(
      Response.json({ results: [{ id: "assistant-2", name: "Two" }] }),
    );
  setup();
  const one = await screen.findByRole("radio", { name: /^One/ });
  // Opening the row menu must not select the card: the menu sits inside the
  // radio with its own event handling.
  // Radix menus open on pointerdown, not click.
  fireEvent.pointerDown(
    within(one).getByRole("button", { name: "Actions for One" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Retire Assistant" }));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getAllByText(/permanently retire/).length,
  ).toBeGreaterThan(0);
  fireEvent.click(within(dialog).getByRole("button", { name: "Retire" }));
  await screen.findByRole("radio", { name: /^Two/ });
  expect(screen.queryByRole("radio", { name: /^One/ })).toBeNull();
  // The retire DELETE runs through the same-origin cloud client.
  const deleteCall = request.mock.calls.find(([url, init]) =>
    String(url).includes("/retire/"),
  );
  expect(String(deleteCall?.[0])).toBe("/v1/assistants/assistant-1/retire/");
  expect(deleteCall?.[1]?.method).toBe("DELETE");
  // Retiring never navigated into an assistant.
  expect(screen.queryByTitle("Assistant")).toBeNull();
});

test("a failed retire keeps the dialog open with the cloud's detail", async () => {
  request
    .mockResolvedValueOnce(
      Response.json({ results: [{ id: "assistant-1", name: "One" }] }),
    )
    .mockResolvedValueOnce(
      Response.json(
        { detail: "You do not own this assistant." },
        { status: 403 },
      ),
    );
  setup();
  const one = await screen.findByRole("radio", { name: /^One/ });
  fireEvent.pointerDown(
    within(one).getByRole("button", { name: "Actions for One" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Retire Assistant" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Retire" }));
  // The detail lands beside the retry button, and the row stays listed.
  await screen.findByText("You do not own this assistant.");
  expect(screen.queryByRole("dialog")).toBeDefined();
  // The open modal aria-hides the page behind it, so the row's presence
  // reads through its text, not its role.
  expect(screen.getByText("One")).toBeDefined();
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
  await screen.findByRole("radio", { name: /^One/ });
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

function seedOrigin(url: string, name?: string): void {
  localStorage.setItem(
    REMEMBERED_ORIGINS_STORAGE_KEY,
    JSON.stringify([
      { url, ...(name ? { name } : {}), addedAt: "2026-01-01T00:00:00.000Z" },
    ]),
  );
}

describe("remembered origins", () => {
  test("the chooser lists remembered origins under the assistants", async () => {
    seedOrigin("https://workshop.example/assistant-9");
    setup("/account/select-assistant", false, async () =>
      Response.json({ results: [] }),
    );
    expect(await screen.findByText("Remote · workshop.example")).toBeTruthy();
    expect(screen.getByText("workshop.example")).toBeTruthy();
  });

  test("selecting a remembered origin navigates the window to its assistant entry", async () => {
    seedOrigin("https://workshop.example/assistant-9", "Workshop");
    const assign = spyOn(window.location, "assign").mockImplementation(
      () => {},
    );
    try {
      setup("/account/select-assistant", false, async () =>
        Response.json({ results: [] }),
      );
      await act(async () => {
        fireEvent.click(await screen.findByText("Workshop"));
      });
      expect(assign).toHaveBeenCalledWith(
        "https://workshop.example/assistant-9/assistant",
      );
    } finally {
      assign.mockRestore();
    }
  });

  test("the add dialog remembers an origin and rides its device code out of the navigation", async () => {
    const assign = spyOn(window.location, "assign").mockImplementation(
      () => {},
    );
    try {
      setup("/account/select-assistant", false, async () =>
        Response.json({ results: [] }),
      );
      fireEvent.click(await screen.findByText("Add a remote assistant"));
      fireEvent.change(screen.getByLabelText("Assistant address"), {
        target: {
          value: "https://workshop.example/assistant/pair#device_code=CODE-1",
        },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Add" }));
      });
      expect(assign).toHaveBeenCalledWith(
        "https://workshop.example/assistant/pair#device_code=CODE-1",
      );
      // The dialog closed and the remembered card took its place in the list.
      expect(await screen.findByText("Remote · workshop.example")).toBeTruthy();
    } finally {
      assign.mockRestore();
    }
  });

  test("a remembered origin can be removed from this device", async () => {
    seedOrigin("https://workshop.example/assistant-9", "Workshop");
    setup("/account/select-assistant", false, async () =>
      Response.json({ results: [] }),
    );
    // Radix menus open on pointerdown, not click.
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Actions for Workshop" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Remove from this device…" }),
    );
    // The confirm modal aria-hides the page behind it, so the row is
    // asserted by text rather than role.
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    });
    await waitFor(() => expect(screen.queryByText("Workshop")).toBeNull());
  });
});
