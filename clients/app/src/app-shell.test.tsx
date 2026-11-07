import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { AppShell } from "@app/app-shell";
import { changeLocale } from "@app/i18n";

// The shell derives its origin from the page — same-origin by construction.
const origin = window.location.origin;
const resolution = (id = "assistant-1") => ({
  status: "ready",
  assistant: {
    id,
    version: "1.2.3",
  },
});
const request = spyOn(globalThis, "fetch");
function respond(
  implementation: (
    ...args: Parameters<typeof fetch>
  ) => ReturnType<typeof fetch>,
) {
  request.mockImplementation(
    Object.assign(implementation, { preconnect: fetch.preconnect }),
  );
}
const navigate = mock((_path: string, _options: { replace: boolean }) => {});
afterEach(() => {
  cleanup();
  request.mockReset();
  navigate.mockClear();
});
function json(value: unknown) {
  return new Response(JSON.stringify(value));
}
function props(id: string | undefined = "assistant-1") {
  return {
    assistantId: id,
    onNavigate: navigate,
  };
}
function iframe(): HTMLIFrameElement {
  const frame = screen.getByTitle("Assistant");
  if (!(frame instanceof HTMLIFrameElement)) {
    throw new Error("Missing frame");
  }
  return frame;
}
function message(
  frame: HTMLIFrameElement,
  path: string,
  extra: { origin?: string; source?: Window; nav?: string } = {},
) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: extra.source ?? frame.contentWindow,
      origin: extra.origin ?? origin,
      data: { source: "mycadet-web-nav", nav: extra.nav ?? "push", path },
    }),
  );
}
async function mounted() {
  respond(async () => json(resolution()));
  const view = render(<AppShell {...props()} />);
  await waitFor(() => expect(screen.queryByTitle("Assistant")).not.toBeNull());
  await act(async () => {});
  return view;
}

test("server rendering never fetches or mounts a browser router", () => {
  expect(renderToString(<AppShell {...props()} />)).toContain(
    "Loading assistant",
  );
  expect(request).not.toHaveBeenCalled();
});

test("the frame loads the bundle mount and its echoes reach the host router", async () => {
  await mounted();
  const frame = iframe();
  const route = (path: string) =>
    new URL(path, window.location.origin).href;
  expect(frame.src).toBe(
    route(`/web${window.location.pathname}${window.location.search}${window.location.hash}`),
  );
  message(frame, "/web/assistant/settings?tab=profile#name");
  expect(navigate).toHaveBeenCalledWith("/assistant/settings?tab=profile#name", {
    replace: false,
  });
  message(frame, "/web/admin/assistant/files", { nav: "replace" });
  expect(navigate).toHaveBeenLastCalledWith("/admin/assistant/files", {
    replace: true,
  });
});

test("rejects messages from other origins, windows, versions, or paths", async () => {
  await mounted();
  const frame = iframe();
  message(frame, "/assistant/settings", {
    origin: "https://elsewhere.example",
  });
  message(frame, "/assistant/settings", { source: window });
  for (const path of [
    "/account/login",
    "/assistant/settings",
    "/web/../account",
    "//elsewhere.example/assistant",
  ]) {
    message(frame, path);
  }
  expect(navigate).not.toHaveBeenCalled();
});

test("a rerender keeps the active frame mounted without another API lookup", async () => {
  const view = await mounted();
  const frame = iframe();
  const src = frame.src;
  view.rerender(<AppShell {...props()} />);
  expect(iframe()).toBe(frame);
  expect(frame.src).toBe(src);
  expect(request).toHaveBeenCalledTimes(1);
});

for (const [status, message] of [
  [409, "Your assistant isn't ready."],
  [410, "This assistant is unavailable."],
  [200, "We couldn't reach your assistant"],
] as const) {
  test(`does not mount an iframe for HTTP ${status}`, async () => {
    respond(async () => new Response("{}", { status }));
    render(<AppShell {...props()} />);
    await screen.findByText(message);
    expect(screen.queryByTitle("Assistant")).toBeNull();
  });
}

test("an unauthenticated session pairs at the app level", async () => {
  respond(async () => new Response("{}", { status: 401 }));
  render(<AppShell {...props()} />);
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith("/account/pair", { replace: true }),
  );
  expect(screen.queryByTitle("Assistant")).toBeNull();
});

test("wakes a not-ready assistant and mounts it once ready", async () => {
  request
    .mockResolvedValueOnce(new Response(null, { status: 409 }))
    .mockResolvedValueOnce(json({ ok: true, action: "woke", output: "" }))
    .mockResolvedValueOnce(json(resolution()));
  render(<AppShell {...props()} />);
  await screen.findByText("Your assistant isn't ready.");
  fireEvent.click(screen.getByRole("button", { name: "Wake it up" }));
  await screen.findByTitle("Assistant");
  expect(request).toHaveBeenCalledTimes(3);
  const wakeCall = request.mock.calls.find(([url]) =>
    String(url).endsWith("/v1/assistants/assistant-1/wake/"),
  );
  expect(wakeCall?.[1]?.method).toBe("POST");
});

test("a failed wake shows the node's own punchline and offers the wake again", async () => {
  request
    .mockResolvedValueOnce(new Response(null, { status: 409 }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "hatch_failed",
          reason: "Firecracker exited with error",
        }),
        { status: 502 },
      ),
    );
  render(<AppShell {...props()} />);
  await screen.findByText("Your assistant isn't ready.");
  fireEvent.click(screen.getByRole("button", { name: "Wake it up" }));
  await screen.findByText("Firecracker exited with error");
  expect(request).toHaveBeenCalledTimes(2);
  expect(screen.queryByTitle("Assistant")).toBeNull();
});

test("retries an API failure without account session probes", async () => {
  request
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(json(resolution()));
  render(<AppShell {...props()} />);
  await screen.findByText("We couldn't reach your assistant");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByTitle("Assistant");
  expect(request).toHaveBeenCalledTimes(2);
  // The shell's assistantId prop rides the request — the scoped spelling.
  expect(
    request.mock.calls.every(([url]) =>
      String(url).endsWith("/v1/assistants/assistant-1/"),
    ),
  ).toBe(true);
});

test("an API failure offers switching to another assistant", async () => {
  respond(async () => new Response(null, { status: 503 }));
  render(<AppShell {...props()} />);
  await screen.findByText("We couldn't reach your assistant");
  fireEvent.click(screen.getByRole("button", { name: "Switch assistant" }));
  expect(navigate).toHaveBeenCalledWith("/account/select-assistant", {
    replace: false,
  });
});

test("unmount aborts requests and ignores late replies", async () => {
  let finish!: (value: Response) => void;
  respond(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  const view = render(<AppShell {...props()} />);
  await act(async () => {});
  const signal = request.mock.calls[0][1]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    finish(json(resolution()));
  });
  expect(screen.queryByTitle("Assistant")).toBeNull();
});

test("changing assistant or API base immediately hides the previous frame", async () => {
  const view = await mounted();
  let finish!: (value: Response) => void;
  respond(() => {
    return new Promise((done) => {
      finish = done;
    });
  });
  view.rerender(
    <AppShell {...props("assistant-2")} apiBaseUrl="/admin/api/" />,
  );
  expect(screen.queryByTitle("Assistant")).toBeNull();
  await act(async () => {});
  expect(String(request.mock.calls.at(-1)?.[0])).toBe(
    `${origin}/admin/api/v1/assistants/assistant-2/`,
  );
  await act(async () => {
    finish(json(resolution("assistant-2")));
  });
  await screen.findByTitle("Assistant");
});

test("without an ID the shell hands off to the account chooser", async () => {
  respond(async () =>
    json({
      status: "selection",
      assistants: [
        { id: "assistant-1", name: "One" },
        { id: "assistant-2", name: "Two" },
      ],
    }),
  );
  render(<AppShell {...props()} assistantId={undefined} />);
  await screen.findByText("Choose an assistant.");
  // The chooser handoff is a post-paint effect: await it rather than race it.
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith("/account/select-assistant", {
      replace: true,
    }),
  );
  expect(screen.queryByRole("button", { name: "Two" })).toBeNull();
});

test("empty and unauthenticated states hand off to the chooser too", async () => {
  respond(async () => json({ status: "empty" }));
  render(<AppShell {...props()} assistantId={undefined} />);
  await screen.findByText("No assistant is available.");
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith("/account/select-assistant", {
      replace: true,
    }),
  );
});

test("embedded shells follow the app locale", async () => {
  respond(async () => json({ status: "empty" }));
  await changeLocale("es");
  try {
    const first = render(<AppShell {...props()} assistantId={undefined} />);
    const second = render(<AppShell {...props()} assistantId={undefined} />);
    await waitFor(() => {
      for (const view of [first, second]) {
        expect(view.container.textContent).toContain(
          "No hay ningún asistente disponible.",
        );
      }
    });
  } finally {
    await changeLocale("en");
    localStorage.removeItem("device:locale");
  }
});

test("a late reply for a previous assistant cannot replace the current selection", async () => {
  // One resolution endpoint now — every request lands on the same URL, so
  // the pending requests are told apart by ORDER, not by path.
  const replies: Array<(response: Response) => void> = [];
  respond(() => {
    return new Promise((done) => {
      replies.push(done);
    });
  });
  const view = render(<AppShell {...props()} />);
  await act(async () => {});
  view.rerender(<AppShell {...props("assistant-2")} />);
  await act(async () => {});
  expect(replies.length).toBe(2);
  await act(async () => {
    replies[0]?.(json(resolution()));
  });
  expect(screen.queryByTitle("Assistant")).toBeNull();
  await act(async () => {
    replies[1]?.(json(resolution("assistant-2")));
  });
  await screen.findByTitle("Assistant");
});

test("frame navigation echoes do not create duplicate host history entries", async () => {
  await mounted();
  const frame = iframe();
  message(frame, "/web/files");
  message(frame, "/web/files");
  expect(navigate).toHaveBeenCalledTimes(1);
});

test("a frame that loads late receives the current host route", async () => {
  await mounted();
  const frame = iframe();
  if (!frame.contentWindow) {
    throw new Error("Missing frame window");
  }
  const post = spyOn(frame.contentWindow, "postMessage");
  fireEvent.load(frame);
  expect(post).toHaveBeenCalledWith(
    {
      source: "mycadet-web-parent-nav",
      path: new URL(
        `/web${window.location.pathname}${window.location.search}${window.location.hash}`,
        window.location.origin,
      ).href,
    },
    origin,
  );
  post.mockRestore();
});
